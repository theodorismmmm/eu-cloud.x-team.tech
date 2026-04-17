'use strict';

/**
 * eu-cloud – Self-hosted cloud storage with WebDAV
 *
 * Compatible with iPad Files app "Connect Server" (WebDAV).
 * Each user gets a dedicated storage folder with a 100 GB quota.
 *
 * Environment variables:
 *   PORT           – HTTP port (default 3000)
 *   STORAGE_DIR    – Absolute path to store user data (default ./storage)
 *   MAX_BYTES      – Per-user quota in bytes (default 107374182400 = 100 GiB)
 *   ADMIN_USER     – Admin username (default "admin")
 *   ADMIN_PASS     – Admin password (default "changeme" – change in production!)
 *   PUBLIC_DOMAIN  – Publicly reachable domain shown in the UI (default "localhost")
 *   REPO_NAME      – Repository / bucket name (default "my-cloud")
 */

const http       = require('http');
const path       = require('path');
const fs         = require('fs');
const os         = require('os');
const express    = require('express');
const rateLimit  = require('express-rate-limit');
const basicAuth  = require('basic-auth');
const mime       = require('mime-types');
const { v4: uuidv4 } = require('uuid');

// ── Configuration ─────────────────────────────────────────────────────────────

const PORT        = parseInt(process.env.PORT || '3000', 10);
const STORAGE_DIR = path.resolve(process.env.STORAGE_DIR || './storage');
const MAX_BYTES   = parseInt(process.env.MAX_BYTES || String(100 * 1024 * 1024 * 1024), 10); // 100 GiB
const ADMIN_USER  = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS  = process.env.ADMIN_PASS || 'changeme';
const PUBLIC_DOMAIN = process.env.PUBLIC_DOMAIN || 'localhost';
const REPO_NAME   = process.env.REPO_NAME || 'my-cloud';

// ── Ensure storage directory exists ──────────────────────────────────────────

if (!fs.existsSync(STORAGE_DIR)) {
  fs.mkdirSync(STORAGE_DIR, { recursive: true });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Resolve and validate a path so it stays inside the storage root. */
function safePath(root, relativeParts) {
  const joined = path.join(root, ...relativeParts);
  const resolved = path.resolve(joined);
  if (!resolved.startsWith(path.resolve(root) + path.sep) && resolved !== path.resolve(root)) {
    return null; // path traversal attempt
  }
  return resolved;
}

/** Recursively compute the total size of a directory in bytes. */
function dirSize(dirPath) {
  if (!fs.existsSync(dirPath)) return 0;
  let total = 0;
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const full = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      total += dirSize(full);
    } else {
      try { total += fs.statSync(full).size; } catch (_) { /* ignore */ }
    }
  }
  return total;
}

/** Format bytes as a human-readable string. */
function humanSize(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let u = 0;
  let v = bytes;
  while (v >= 1024 && u < units.length - 1) { v /= 1024; u++; }
  return `${v.toFixed(u > 0 ? 1 : 0)} ${units[u]}`;
}

/** Build a simple XML error response. */
function xmlError(res, status, message) {
  res.status(status)
    .set('Content-Type', 'application/xml; charset=utf-8')
    .send(`<?xml version="1.0" encoding="utf-8"?>\n<error><message>${message}</message></error>`);
}

// ── Authentication middleware ──────────────────────────────────────────────────

function requireAuth(req, res, next) {
  const credentials = basicAuth(req);
  if (credentials && credentials.name === ADMIN_USER && credentials.pass === ADMIN_PASS) {
    req.cloudUser = ADMIN_USER;
    req.userRoot  = path.join(STORAGE_DIR, sanitizePathSegment(ADMIN_USER));
    if (!fs.existsSync(req.userRoot)) fs.mkdirSync(req.userRoot, { recursive: true });
    return next();
  }
  res.set('WWW-Authenticate', `Basic realm="${REPO_NAME}"`);
  res.status(401).send('Authentication required.');
}

/** Strip characters that are unsafe in directory names. */
function sanitizePathSegment(name) {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_');
}

// ── Express app ───────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Rate limiting ─────────────────────────────────────────────────────────────

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,   // 1 minute
  max: 120,              // 120 requests per IP per minute
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
});
app.use('/api/', apiLimiter);
app.use('/webdav', apiLimiter);

// ── REST API ──────────────────────────────────────────────────────────────────

/** GET /api/info – server info & connection details */
app.get('/api/info', (req, res) => {
  res.json({
    domain:   PUBLIC_DOMAIN,
    repoName: REPO_NAME,
    protocol: 'WebDAV',
    webdavUrl: `http://${PUBLIC_DOMAIN}:${PORT}/webdav`,
    quotaBytes: MAX_BYTES,
    quotaHuman: humanSize(MAX_BYTES),
  });
});

/** GET /api/usage – storage usage for the authenticated user */
app.get('/api/usage', requireAuth, (req, res) => {
  const used = dirSize(req.userRoot);
  res.json({
    used,
    usedHuman: humanSize(used),
    quota: MAX_BYTES,
    quotaHuman: humanSize(MAX_BYTES),
    available: Math.max(0, MAX_BYTES - used),
    availableHuman: humanSize(Math.max(0, MAX_BYTES - used)),
    percentUsed: ((used / MAX_BYTES) * 100).toFixed(2),
  });
});

// ── WebDAV handler ────────────────────────────────────────────────────────────

/**
 * A minimal WebDAV server implemented directly on top of Express.
 * Supports the methods required by the iPad Files "Connect Server" feature:
 *   OPTIONS, PROPFIND, GET, PUT, DELETE, MKCOL, MOVE, COPY
 */

/** Generate a PROPFIND response XML element for one resource. */
function propfindEntry(resourcePath, stat, requestPath) {
  const name    = path.basename(resourcePath) || REPO_NAME;
  const isDir   = stat.isDirectory();
  const mtime   = stat.mtime.toUTCString();
  const ctype   = isDir ? '' : (mime.lookup(resourcePath) || 'application/octet-stream');
  const size    = isDir ? '' : `<D:getcontentlength>${stat.size}</D:getcontentlength>`;
  const restype = isDir
    ? '<D:resourcetype><D:collection/></D:resourcetype>'
    : '<D:resourcetype/>';

  const encodedHref = requestPath
    .split('/')
    .map(s => encodeURIComponent(s))
    .join('/');

  return `<D:response>
  <D:href>${encodedHref}</D:href>
  <D:propstat>
    <D:prop>
      <D:displayname>${escapeXml(name)}</D:displayname>
      <D:getlastmodified>${mtime}</D:getlastmodified>
      ${restype}
      ${size}
      ${ctype ? `<D:getcontenttype>${ctype}</D:getcontenttype>` : ''}
      <D:getetag>"${stat.ino}-${stat.mtime.getTime()}"</D:getetag>
    </D:prop>
    <D:status>HTTP/1.1 200 OK</D:status>
  </D:propstat>
</D:response>`;
}

function escapeXml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Mount WebDAV at /webdav */
app.use('/webdav', requireAuth, (req, res, next) => {
  const method = req.method.toUpperCase();

  // Decode URL path segments individually to avoid URIError on bare '%' chars
  const relParts = req.path.split('/').filter(Boolean).map(seg => {
    try { return decodeURIComponent(seg); } catch (_) { return seg; }
  });
  const fsPath   = safePath(req.userRoot, relParts);

  if (!fsPath) {
    return xmlError(res, 403, 'Forbidden');
  }

  // Reconstruct the WebDAV href for responses
  const davPrefix = '/webdav';
  const hrefPath  = davPrefix + '/' + relParts.map(encodeURIComponent).join('/');

  // ── OPTIONS ──────────────────────────────────────────────────────────────
  if (method === 'OPTIONS') {
    res.set({
      'DAV': '1, 2',
      'Allow': 'OPTIONS, GET, HEAD, PUT, DELETE, MKCOL, MOVE, COPY, PROPFIND, PROPPATCH, LOCK, UNLOCK',
      'MS-Author-Via': 'DAV',
    });
    return res.status(200).end();
  }

  // ── PROPFIND ─────────────────────────────────────────────────────────────
  if (method === 'PROPFIND') {
    if (!fs.existsSync(fsPath)) return xmlError(res, 404, 'Not Found');

    const depth   = req.headers['depth'] || 'infinity';
    const rootStat = fs.statSync(fsPath);
    const entries  = [propfindEntry(fsPath, rootStat, hrefPath || davPrefix + '/')];

    if (rootStat.isDirectory() && depth !== '0') {
      for (const child of fs.readdirSync(fsPath)) {
        const childFsPath   = path.join(fsPath, child);
        const childHrefPath = hrefPath.replace(/\/$/, '') + '/' + encodeURIComponent(child);
        try {
          const childStat = fs.statSync(childFsPath);
          entries.push(propfindEntry(childFsPath, childStat, childHrefPath));
        } catch (_) { /* skip unreadable entries */ }
      }
    }

    const body = `<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:">
${entries.join('\n')}
</D:multistatus>`;

    return res.status(207)
      .set('Content-Type', 'application/xml; charset=utf-8')
      .send(body);
  }

  // ── GET / HEAD ────────────────────────────────────────────────────────────
  if (method === 'GET' || method === 'HEAD') {
    if (!fs.existsSync(fsPath)) return xmlError(res, 404, 'Not Found');
    const stat = fs.statSync(fsPath);
    if (stat.isDirectory()) {
      // Return a simple directory listing as XML for browsers
      const children = fs.readdirSync(fsPath).map(n => `<entry>${escapeXml(n)}</entry>`).join('');
      const xml = `<?xml version="1.0"?><directory>${children}</directory>`;
      return res.set('Content-Type', 'application/xml').send(xml);
    }
    return res.sendFile(fsPath);
  }

  // ── PUT ───────────────────────────────────────────────────────────────────
  if (method === 'PUT') {
    const parentDir = path.dirname(fsPath);
    if (!fs.existsSync(parentDir)) return xmlError(res, 409, 'Conflict – parent collection does not exist');

    // Quota check: content-length header gives us a quick pre-check
    const incoming = parseInt(req.headers['content-length'] || '0', 10);
    const used     = dirSize(req.userRoot);
    if (used + incoming > MAX_BYTES) {
      return xmlError(res, 507, `Insufficient Storage – quota is ${humanSize(MAX_BYTES)}`);
    }

    let written = 0;
    let quotaExceeded = false;
    // Write to a temp file outside user storage to avoid name collisions
    const tmpPath = path.join(os.tmpdir(), `eu-cloud-${uuidv4()}.tmp`);
    const ws = fs.createWriteStream(tmpPath);

    req.on('data', chunk => {
      if (quotaExceeded) return;
      written += chunk.length;
      if (written + used > MAX_BYTES) {
        quotaExceeded = true;
        req.destroy();
        ws.destroy();
        try { fs.unlinkSync(tmpPath); } catch (_) {}
        xmlError(res, 507, `Insufficient Storage – quota is ${humanSize(MAX_BYTES)}`);
        return;
      }
      ws.write(chunk);
    });

    req.on('end', () => {
      if (quotaExceeded) return;
      ws.end(() => {
        try {
          fs.renameSync(tmpPath, fsPath);
          res.status(201).end();
        } catch (err) {
          try { fs.unlinkSync(tmpPath); } catch (_) {}
          xmlError(res, 500, 'Internal Server Error');
        }
      });
    });

    req.on('error', () => {
      ws.destroy();
      try { fs.unlinkSync(tmpPath); } catch (_) {}
    });

    return; // response is sent asynchronously
  }

  // ── DELETE ────────────────────────────────────────────────────────────────
  if (method === 'DELETE') {
    if (!fs.existsSync(fsPath)) return xmlError(res, 404, 'Not Found');
    try {
      fs.rmSync(fsPath, { recursive: true, force: true });
      return res.status(204).end();
    } catch (err) {
      return xmlError(res, 500, 'Internal Server Error');
    }
  }

  // ── MKCOL ─────────────────────────────────────────────────────────────────
  if (method === 'MKCOL') {
    if (fs.existsSync(fsPath)) return xmlError(res, 405, 'Method Not Allowed – already exists');
    const parentDir = path.dirname(fsPath);
    if (!fs.existsSync(parentDir)) return xmlError(res, 409, 'Conflict – parent collection does not exist');
    try {
      fs.mkdirSync(fsPath);
      return res.status(201).end();
    } catch (err) {
      return xmlError(res, 500, 'Internal Server Error');
    }
  }

  // ── MOVE ──────────────────────────────────────────────────────────────────
  if (method === 'MOVE') {
    if (!fs.existsSync(fsPath)) return xmlError(res, 404, 'Not Found');
    const destHeader = req.headers['destination'];
    if (!destHeader) return xmlError(res, 400, 'Bad Request – missing Destination header');

    let destRelPath;
    try {
      const destUrl  = new URL(destHeader);
      destRelPath = decodeURIComponent(destUrl.pathname)
        .replace(/^\/webdav\/?/, '')
        .split('/')
        .filter(Boolean);
    } catch (_) {
      destRelPath = decodeURIComponent(destHeader)
        .replace(/^\/webdav\/?/, '')
        .split('/')
        .filter(Boolean);
    }

    const destFsPath = safePath(req.userRoot, destRelPath);
    if (!destFsPath) return xmlError(res, 403, 'Forbidden');

    const overwrite = (req.headers['overwrite'] || 'T').toUpperCase() !== 'F';
    if (fs.existsSync(destFsPath)) {
      if (!overwrite) return xmlError(res, 412, 'Precondition Failed');
      fs.rmSync(destFsPath, { recursive: true, force: true });
    }

    try {
      fs.renameSync(fsPath, destFsPath);
      return res.status(201).end();
    } catch (err) {
      return xmlError(res, 500, 'Internal Server Error');
    }
  }

  // ── COPY ──────────────────────────────────────────────────────────────────
  if (method === 'COPY') {
    if (!fs.existsSync(fsPath)) return xmlError(res, 404, 'Not Found');
    const destHeader = req.headers['destination'];
    if (!destHeader) return xmlError(res, 400, 'Bad Request – missing Destination header');

    let destRelPath;
    try {
      const destUrl  = new URL(destHeader);
      destRelPath = decodeURIComponent(destUrl.pathname)
        .replace(/^\/webdav\/?/, '')
        .split('/')
        .filter(Boolean);
    } catch (_) {
      destRelPath = decodeURIComponent(destHeader)
        .replace(/^\/webdav\/?/, '')
        .split('/')
        .filter(Boolean);
    }

    const destFsPath = safePath(req.userRoot, destRelPath);
    if (!destFsPath) return xmlError(res, 403, 'Forbidden');

    const overwrite = (req.headers['overwrite'] || 'T').toUpperCase() !== 'F';
    if (fs.existsSync(destFsPath)) {
      if (!overwrite) return xmlError(res, 412, 'Precondition Failed');
      fs.rmSync(destFsPath, { recursive: true, force: true });
    }

    try {
      fs.cpSync(fsPath, destFsPath, { recursive: true });
      return res.status(201).end();
    } catch (err) {
      return xmlError(res, 500, 'Internal Server Error');
    }
  }

  // ── LOCK / UNLOCK (stub – required by some DAV clients) ───────────────────
  if (method === 'LOCK') {
    const lockToken = `urn:uuid:${uuidv4()}`;
    const body = `<?xml version="1.0" encoding="utf-8"?>
<D:prop xmlns:D="DAV:">
  <D:lockdiscovery>
    <D:activelock>
      <D:locktype><D:write/></D:locktype>
      <D:lockscope><D:exclusive/></D:lockscope>
      <D:depth>0</D:depth>
      <D:timeout>Second-3600</D:timeout>
      <D:locktoken><D:href>${lockToken}</D:href></D:locktoken>
    </D:activelock>
  </D:lockdiscovery>
</D:prop>`;
    return res.status(200)
      .set('Content-Type', 'application/xml; charset=utf-8')
      .set('Lock-Token', `<${lockToken}>`)
      .send(body);
  }

  if (method === 'UNLOCK') {
    return res.status(204).end();
  }

  // ── PROPPATCH (stub) ───────────────────────────────────────────────────────
  if (method === 'PROPPATCH') {
    const body = `<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:">
  <D:response>
    <D:href>${hrefPath}</D:href>
    <D:propstat>
      <D:prop/>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
</D:multistatus>`;
    return res.status(207)
      .set('Content-Type', 'application/xml; charset=utf-8')
      .send(body);
  }

  // Fallback
  res.status(405).set('Allow', 'OPTIONS, GET, HEAD, PUT, DELETE, MKCOL, MOVE, COPY, PROPFIND, PROPPATCH, LOCK, UNLOCK').end();
});

// ── Start server ──────────────────────────────────────────────────────────────

const server = http.createServer(app);

server.listen(PORT, () => {
  console.log(`eu-cloud server running on port ${PORT}`);
  console.log(`  Public domain : ${PUBLIC_DOMAIN}`);
  console.log(`  Repo name     : ${REPO_NAME}`);
  console.log(`  Storage dir   : ${STORAGE_DIR}`);
  console.log(`  Quota per user: ${humanSize(MAX_BYTES)}`);
  console.log(`  WebDAV URL    : http://${PUBLIC_DOMAIN}:${PORT}/webdav`);
  console.log(`  Web UI        : http://${PUBLIC_DOMAIN}:${PORT}`);
});

module.exports = { app, server }; // exported for tests
