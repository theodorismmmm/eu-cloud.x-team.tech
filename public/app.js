'use strict';

/* ── Utility ─────────────────────────────────────────────────────────────── */
const $ = id => document.getElementById(id);

/** Safely set text inside an element (no XSS). */
function setText(el, text) { el.textContent = text; }

/** Create a text node. */
function tn(text) { return document.createTextNode(text); }

/** Create an element, optionally with text content. */
function el(tag, text) {
  const e = document.createElement(tag);
  if (text !== undefined) e.textContent = text;
  return e;
}

/* ── Year ────────────────────────────────────────────────────────────────── */
$('year').textContent = new Date().getFullYear();

/* ── Load server info ────────────────────────────────────────────────────── */
async function loadInfo() {
  try {
    const res  = await fetch('/api/info');
    const data = await res.json();
    setText($('infoDomain'), data.domain);
    setText($('infoRepo'),   data.repoName);
    setText($('webdavUrl'),  data.webdavUrl);
    setText($('iosUrl'),     data.webdavUrl);
    $('domain').placeholder   = `e.g. ${data.domain}`;
    $('repoName').placeholder = `e.g. ${data.repoName}`;
  } catch (_) {
    // Server info not available (running static demo)
  }
}

/* ── Load storage usage ──────────────────────────────────────────────────── */
async function loadUsage() {
  // Prompt user for credentials rather than using hardcoded defaults
  const stored = sessionStorage.getItem('eu-cloud-auth');
  if (!stored) {
    setText($('usageText'), 'Log in to see usage');
    return;
  }
  try {
    const res  = await fetch('/api/usage', {
      headers: { Authorization: 'Basic ' + stored },
    });
    if (!res.ok) throw new Error('Not authenticated');
    const data = await res.json();
    $('progressBar').style.width = `${Math.min(100, parseFloat(data.percentUsed))}%`;
    setText($('usageText'), `${data.usedHuman} used of ${data.quotaHuman}`);
  } catch (_) {
    setText($('usageText'), 'Log in to see usage');
  }
}

/* ── Connect form ────────────────────────────────────────────────────────── */
$('connectForm').addEventListener('submit', e => {
  e.preventDefault();

  const domain    = $('domain').value.trim();
  const repoName  = $('repoName').value.trim();
  const port      = $('port').value.trim() || '3000';
  const result    = $('connectResult');
  const username  = $('username') ? $('username').value.trim() : '';
  const password  = $('password') ? $('password').value : '';

  if (!domain || !repoName) {
    result.className = 'result-box error';
    setText(result, 'Please enter both a domain and a repository name.');
    result.classList.remove('hidden');
    return;
  }

  const webdavUrl = `http://${domain}:${port}/webdav`;

  // Store credentials in session storage (not in source code)
  if (username && password) {
    sessionStorage.setItem('eu-cloud-auth', btoa(`${username}:${password}`));
    loadUsage();
  }

  // Build result box using DOM APIs to avoid XSS
  result.className = 'result-box success';
  result.classList.remove('hidden');
  while (result.firstChild) result.removeChild(result.firstChild); // clear safely

  const addLine = (label, value) => {
    result.appendChild(el('strong', label));
    result.appendChild(tn(' '));
    const code = el('code', value);
    result.appendChild(code);
    result.appendChild(el('br'));
  };

  result.appendChild(el('strong', 'Your WebDAV connection details:'));
  result.appendChild(el('br'));
  result.appendChild(el('br'));
  addLine('WebDAV URL:', webdavUrl);
  addLine('Domain:', domain);
  addLine('Repository:', repoName);
  addLine('Port:', port);
  result.appendChild(el('br'));
  result.appendChild(el('strong', 'iPad Files app steps:'));
  result.appendChild(el('br'));

  const steps = [
    'Open Files → tap ⋯ → Connect to Server',
    `Enter: ${webdavUrl}`,
    'Choose Registered User and enter your username & password.',
    'Tap Connect – your cloud drive appears under Locations.',
  ];
  steps.forEach((s, i) => {
    result.appendChild(tn(`${i + 1}. ${s}`));
    result.appendChild(el('br'));
  });

  // Update the iOS URL hint in the iPad section too
  setText($('iosUrl'), webdavUrl);
});

/* ── Init ─────────────────────────────────────────────────────────────────── */
loadInfo();
loadUsage();
