'use strict';

/**
 * Tests for eu-cloud server.
 * Uses Node.js built-in test runner (node --test).
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http   = require('node:http');
const fs     = require('node:fs');
const path   = require('node:path');
const os     = require('node:os');

/** Make a raw HTTP request and return { status, headers, body }. */
function request(options, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({
        status:  res.statusCode,
        headers: res.headers,
        body:    Buffer.concat(chunks).toString(),
      }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function authHeader(user = 'admin', pass = 'changeme') {
  return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
}

// ── Setup ─────────────────────────────────────────────────────────────────────

const tmpStorage = fs.mkdtempSync(path.join(os.tmpdir(), 'eu-cloud-test-'));
let serverModule, PORT;

before(async () => {
  // Set up env before loading server
  process.env.STORAGE_DIR = tmpStorage;
  process.env.PORT        = '0'; // let OS assign a free port
  process.env.ADMIN_USER  = 'admin';
  process.env.ADMIN_PASS  = 'changeme';
  process.env.MAX_BYTES   = String(100 * 1024 * 1024 * 1024);
  process.env.PUBLIC_DOMAIN = 'localhost';
  process.env.REPO_NAME   = 'test-repo';

  serverModule = require('../server.js');
  await new Promise(res => serverModule.server.on('listening', res));
  PORT = serverModule.server.address().port;
});

after(() => {
  serverModule.server.close();
  fs.rmSync(tmpStorage, { recursive: true, force: true });
});

// ── Tests ─────────────────────────────────────────────────────────────────────

test('GET /api/info returns domain and repoName', async () => {
  const { status, body } = await request({ hostname: 'localhost', port: PORT, path: '/api/info' });
  assert.equal(status, 200);
  const data = JSON.parse(body);
  assert.equal(data.domain,   'localhost');
  assert.equal(data.repoName, 'test-repo');
  assert.equal(data.protocol, 'WebDAV');
  assert.match(data.webdavUrl, /\/webdav$/);
});

test('GET /api/usage requires authentication', async () => {
  const { status } = await request({ hostname: 'localhost', port: PORT, path: '/api/usage' });
  assert.equal(status, 401);
});

test('GET /api/usage returns usage for authenticated user', async () => {
  const { status, body } = await request({
    hostname: 'localhost', port: PORT, path: '/api/usage',
    headers: { Authorization: authHeader() },
  });
  assert.equal(status, 200);
  const data = JSON.parse(body);
  assert.ok(typeof data.used === 'number');
  assert.ok(typeof data.quota === 'number');
  assert.equal(data.quota, 100 * 1024 * 1024 * 1024);
  assert.ok(data.quotaHuman.includes('100'));
});

test('WebDAV OPTIONS returns DAV header', async () => {
  const { status, headers } = await request({
    method: 'OPTIONS', hostname: 'localhost', port: PORT, path: '/webdav',
    headers: { Authorization: authHeader() },
  });
  assert.equal(status, 200);
  assert.ok(headers['dav'], 'DAV header should be present');
});

test('WebDAV PROPFIND on root returns 207', async () => {
  const { status, body } = await request({
    method: 'PROPFIND', hostname: 'localhost', port: PORT, path: '/webdav',
    headers: { Authorization: authHeader(), Depth: '1' },
  });
  assert.equal(status, 207);
  assert.ok(body.includes('multistatus'));
});

test('WebDAV PUT uploads a file', async () => {
  const content = 'Hello eu-cloud!';
  const { status } = await request({
    method: 'PUT', hostname: 'localhost', port: PORT, path: '/webdav/hello.txt',
    headers: {
      Authorization: authHeader(),
      'Content-Type': 'text/plain',
      'Content-Length': Buffer.byteLength(content),
    },
  }, content);
  assert.equal(status, 201);
});

test('WebDAV GET retrieves the uploaded file', async () => {
  const { status, body } = await request({
    method: 'GET', hostname: 'localhost', port: PORT, path: '/webdav/hello.txt',
    headers: { Authorization: authHeader() },
  });
  assert.equal(status, 200);
  assert.equal(body, 'Hello eu-cloud!');
});

test('WebDAV MKCOL creates a directory', async () => {
  const { status } = await request({
    method: 'MKCOL', hostname: 'localhost', port: PORT, path: '/webdav/myfolder',
    headers: { Authorization: authHeader() },
  });
  assert.equal(status, 201);
});

test('WebDAV MOVE renames a file', async () => {
  // First upload
  await request({
    method: 'PUT', hostname: 'localhost', port: PORT, path: '/webdav/orig.txt',
    headers: { Authorization: authHeader(), 'Content-Length': 4 },
  }, 'data');

  const { status } = await request({
    method: 'MOVE', hostname: 'localhost', port: PORT, path: '/webdav/orig.txt',
    headers: {
      Authorization: authHeader(),
      Destination: `http://localhost:${PORT}/webdav/moved.txt`,
      Overwrite: 'T',
    },
  });
  assert.equal(status, 201);
});

test('WebDAV DELETE removes a file', async () => {
  // Upload then delete
  await request({
    method: 'PUT', hostname: 'localhost', port: PORT, path: '/webdav/todelete.txt',
    headers: { Authorization: authHeader(), 'Content-Length': 2 },
  }, 'hi');

  const del = await request({
    method: 'DELETE', hostname: 'localhost', port: PORT, path: '/webdav/todelete.txt',
    headers: { Authorization: authHeader() },
  });
  assert.equal(del.status, 204);

  const get = await request({
    method: 'GET', hostname: 'localhost', port: PORT, path: '/webdav/todelete.txt',
    headers: { Authorization: authHeader() },
  });
  assert.equal(get.status, 404);
});

test('WebDAV rejects path traversal attempts', async () => {
  const { status } = await request({
    method: 'GET', hostname: 'localhost', port: PORT,
    path: '/webdav/../../etc/passwd',
    headers: { Authorization: authHeader() },
  });
  // 403 Forbidden or 404 – either is acceptable, but NOT 200
  assert.ok(status === 403 || status === 404, `Expected 403 or 404, got ${status}`);
});

test('WebDAV PUT without auth returns 401', async () => {
  const { status } = await request({
    method: 'PUT', hostname: 'localhost', port: PORT, path: '/webdav/noauth.txt',
    headers: { 'Content-Length': 1 },
  }, 'x');
  assert.equal(status, 401);
});

test('WebDAV PUT rejects upload that exceeds quota', async () => {
  // Set a tiny quota for this sub-test by overriding MAX_BYTES via env and
  // testing against the Content-Length pre-check path.
  const smallQuota = 10; // 10 bytes
  const originalEnv = process.env.MAX_BYTES;

  // We cannot change MAX_BYTES at runtime (it's already captured as a constant),
  // so instead we upload a file that is larger than the current quota to verify
  // the 507 path is reachable.  We use a dedicated test server with a tiny quota.
  const { createServer } = require('node:http');

  // Spin up a second isolated server with 10-byte quota
  const tmpDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'eu-cloud-quota-test-'));
  process.env.STORAGE_DIR = tmpDir2;
  process.env.MAX_BYTES   = String(smallQuota);
  process.env.PORT        = '0';

  // Clear require cache so the module re-reads env (use exact path to avoid collisions)
  const serverModulePath = require.resolve('../server.js');
  delete require.cache[serverModulePath];
  const tinyModule = require('../server.js');
  await new Promise(res => tinyModule.server.on('listening', res));
  const tinyPort = tinyModule.server.address().port;

  // Upload a file larger than 10 bytes
  const bigContent = 'This content is definitely longer than 10 bytes!';
  const { status } = await request({
    method: 'PUT', hostname: 'localhost', port: tinyPort, path: '/webdav/big.txt',
    headers: {
      Authorization: authHeader(),
      'Content-Type': 'text/plain',
      'Content-Length': Buffer.byteLength(bigContent),
    },
  }, bigContent);

  tinyModule.server.close();
  fs.rmSync(tmpDir2, { recursive: true, force: true });

  // Restore env
  process.env.STORAGE_DIR = tmpStorage;
  process.env.MAX_BYTES   = originalEnv;

  assert.equal(status, 507, 'Expected 507 Insufficient Storage when quota is exceeded');
});
