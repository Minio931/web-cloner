#!/usr/bin/env node

const puppeteer = require('puppeteer');
const axios = require('axios');
const cheerio = require('cheerio');
const beautify = require('js-beautify').html;
const fs = require('fs');
const path = require('path');
const https = require('https');

const TARGET_URL = process.argv[2];
const USE_STATIC = process.argv.includes('--static');
// Strip all <script> tags from output — page already rendered by Puppeteer,
// so JS is not needed for looks and only causes chunk-loading errors locally.
const STRIP_JS = !process.argv.includes('--keep-js');

if (!TARGET_URL) {
  console.error('Usage: node cloner.js <URL> [--static] [--keep-js]');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// HTTP client for downloading assets after the page is rendered
// ---------------------------------------------------------------------------
const http = axios.create({
  timeout: 20000,
  httpsAgent: new https.Agent({ rejectUnauthorized: false }),
  headers: {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    Accept: '*/*',
    'Accept-Language': 'en-US,en;q=0.5',
  },
  maxRedirects: 10,
  responseType: 'arraybuffer',
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function sanitizeName(str) {
  return str.replace(/[^a-zA-Z0-9_\-\.]/g, '_').substring(0, 80);
}

function resolveUrl(base, relative) {
  try {
    return new URL(relative, base).href;
  } catch {
    return null;
  }
}

function localPath(assetUrl, outputDir) {
  try {
    const parsed = new URL(assetUrl);
    let filePath = parsed.pathname;
    if (filePath === '/' || filePath === '') filePath = '/index';
    const ext = path.extname(filePath).split('?')[0];
    const base = path.basename(filePath, path.extname(filePath));
    const dir = path.dirname(filePath).replace(/^\//, '');
    const safeDir = dir.split('/').map(sanitizeName).join(path.sep);
    const safeBase = sanitizeName(base) || 'asset';
    return path.join(outputDir, 'assets', safeDir, safeBase + (ext || ''));
  } catch {
    return path.join(outputDir, 'assets', 'unknown', Date.now() + '');
  }
}

function relPath(fromFile, toFile) {
  return path.relative(path.dirname(fromFile), toFile).replace(/\\/g, '/');
}

// ---------------------------------------------------------------------------
// CSS processor – rewrites url() / @import to local relative paths
// ---------------------------------------------------------------------------
async function processCSS(cssText, cssUrl, outputDir, downloaded) {
  const urlRe = /url\(\s*(['"]?)([^'"\)\s]+)\1\s*\)/g;
  const importRe = /@import\s+(['"])([^'"]+)\1/g;
  const jobs = [];

  for (const re of [urlRe, importRe]) {
    let m;
    while ((m = re.exec(cssText)) !== null) {
      const raw = m[2].trim();
      if (raw.startsWith('data:')) continue;
      const abs = resolveUrl(cssUrl, raw);
      if (abs) jobs.push({ raw, abs });
    }
  }

  const cssFilePath = localPath(cssUrl, outputDir);
  for (const j of jobs) {
    const saved = await downloadAsset(j.abs, outputDir, downloaded);
    if (saved) {
      const rel = relPath(cssFilePath, saved);
      cssText = cssText.split(j.raw).join(rel);
    }
  }
  return cssText;
}

// ---------------------------------------------------------------------------
// Asset downloader (idempotent via `downloaded` map)
// ---------------------------------------------------------------------------
async function downloadAsset(assetUrl, outputDir, downloaded, bodyOverride) {
  if (!assetUrl) return null;
  if (downloaded.has(assetUrl)) return downloaded.get(assetUrl);
  downloaded.set(assetUrl, null); // mark in-progress

  try {
    let data;
    if (bodyOverride) {
      data = Buffer.from(bodyOverride);
    } else {
      const resp = await http.get(assetUrl);
      data = Buffer.from(resp.data);
    }
    const filePath = localPath(assetUrl, outputDir);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, data);
    downloaded.set(assetUrl, filePath);
    console.log(`  ✓ ${assetUrl.substring(0, 90)}`);
    return filePath;
  } catch (e) {
    console.warn(`  ✗ ${assetUrl.substring(0, 90)} — ${e.message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Puppeteer page fetch – returns rendered HTML + intercepted resource map
// ---------------------------------------------------------------------------
async function fetchWithPuppeteer(targetUrl) {
  console.log('Launching headless Chrome...');

  // Try Puppeteer's bundled Chrome first; fall back to system Chromium
  const { execSync } = require('child_process');
  let executablePath;
  try {
    executablePath = puppeteer.executablePath();
    // Quick lib check – if missing, throw so we fall back
    const missing = execSync(`ldd "${executablePath}" 2>&1 | grep "not found" || true`, {
      encoding: 'utf-8',
    }).trim();
    if (missing) throw new Error(missing);
  } catch {
    for (const bin of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
      try {
        const p = execSync(`which ${bin} 2>/dev/null`, { encoding: 'utf-8' }).trim();
        if (p) { executablePath = p; break; }
      } catch { /* keep looking */ }
    }
    if (!executablePath) throw new Error(
      'Chrome/Chromium not found. Run:\n  sudo apt-get install -y libnspr4 libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2'
    );
  }
  console.log(`  Browser: ${executablePath}`);

  const browser = await puppeteer.launch({
    headless: 'new',
    executablePath,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
    ],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
  );

  // Intercept all network requests so we capture response bodies for assets
  const captured = new Map(); // url → Buffer
  await page.setRequestInterception(true);

  page.on('request', req => {
    // Block analytics/trackers – not needed for visual clone
    const u = req.url();
    if (/google-analytics|googletagmanager|doubleclick|facebook\.net\/en_US\/sdk|connect\.facebook\.net/.test(u)) {
      req.abort();
    } else {
      req.continue();
    }
  });

  page.on('response', async resp => {
    const url = resp.url();
    if (url.startsWith('data:')) return;
    try {
      const buf = await resp.buffer();
      captured.set(url, buf);
    } catch {
      // some responses have no body (redirects, etc.)
    }
  });

  console.log(`Navigating to ${targetUrl} ...`);
  try {
    await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 45000 });
  } catch (e) {
    console.warn(`Navigation warning: ${e.message} — continuing with what we have`);
  }

  // Give JS-heavy SPAs a moment to settle
  await new Promise(r => setTimeout(r, 2000));

  const html = await page.content();
  await browser.close();
  console.log(`Captured ${captured.size} network responses from browser.\n`);
  return { html, captured };
}

// ---------------------------------------------------------------------------
// Static fetch (no JS execution)
// ---------------------------------------------------------------------------
async function fetchStatic(targetUrl) {
  const resp = await http.get(targetUrl);
  return { html: Buffer.from(resp.data).toString('utf-8'), captured: new Map() };
}

// ---------------------------------------------------------------------------
// Main clone logic
// ---------------------------------------------------------------------------
async function clone(targetUrl) {
  const parsed = new URL(targetUrl);
  const siteName = sanitizeName(parsed.hostname);
  const outputDir = path.join(process.cwd(), 'output', siteName);
  fs.mkdirSync(outputDir, { recursive: true });

  console.log(`\n=== Web Cloner ===`);
  console.log(`URL:    ${targetUrl}`);
  console.log(`Output: ${outputDir}`);
  console.log(`Mode:   ${USE_STATIC ? 'static (--static)' : 'Puppeteer (full JS)'}\n`);

  const { html, captured } = USE_STATIC
    ? await fetchStatic(targetUrl)
    : await fetchWithPuppeteer(targetUrl);

  const $ = cheerio.load(html, { decodeEntities: false });
  const downloaded = new Map();
  const htmlFilePath = path.join(outputDir, 'index.html');

  // Helper: resolve + download, rewriting `el[attr]`
  async function handleAttr(el, attr, type) {
    const val = $(el).attr(attr);
    if (!val || val.startsWith('data:')) return;
    const abs = resolveUrl(targetUrl, val);
    if (!abs) return;

    let saved;
    if (type === 'css') {
      // Use captured body if available, else fetch
      const rawBuf = captured.get(abs);
      let cssText = rawBuf ? rawBuf.toString('utf-8') : null;
      if (!cssText) {
        try {
          const r = await http.get(abs);
          cssText = Buffer.from(r.data).toString('utf-8');
        } catch {
          return;
        }
      }
      cssText = await processCSS(cssText, abs, outputDir, downloaded);
      const filePath = localPath(abs, outputDir);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, cssText);
      downloaded.set(abs, filePath);
      saved = filePath;
      console.log(`  ✓ CSS: ${abs.substring(0, 80)}`);
    } else {
      const body = captured.get(abs) || null;
      saved = await downloadAsset(abs, outputDir, downloaded, body);
    }

    if (saved) $(el).attr(attr, relPath(htmlFilePath, saved));
  }

  // --- CSS links ---
  console.log('Processing CSS...');
  const cssEls = [];
  $('link[rel="stylesheet"], link[as="style"]').each((_, el) => cssEls.push(el));
  for (const el of cssEls) await handleAttr(el, 'href', 'css');

  // --- Scripts ---
  if (STRIP_JS) {
    $('script').remove();
    $('link[rel="preload"][as="script"], link[rel="modulepreload"]').remove();
    console.log('JS stripped (use --keep-js to preserve scripts).');
  } else {
    console.log('Processing JS...');
    const scriptEls = [];
    $('script[src]').each((_, el) => scriptEls.push(el));
    for (const el of scriptEls) await handleAttr(el, 'src', 'js');
  }

  // --- Images (src) ---
  console.log('Processing images...');
  const imgEls = [];
  $('img[src]').each((_, el) => imgEls.push(el));
  for (const el of imgEls) await handleAttr(el, 'src', 'img');

  $('img[data-src]').each((_, el) => imgEls.push(el));
  for (const el of imgEls) {
    const v = $(el).attr('data-src');
    if (!v || v.startsWith('data:')) continue;
    await handleAttr(el, 'data-src', 'img');
  }

  // --- srcset ---
  $('[srcset]').each((_, el) => {
    const srcset = $(el).attr('srcset') || '';
    const parts = srcset.split(',').map(s => s.trim());
    const rewrites = [];
    for (const part of parts) {
      const [src, ...rest] = part.split(/\s+/);
      if (!src || src.startsWith('data:')) continue;
      const abs = resolveUrl(targetUrl, src);
      if (abs) rewrites.push({ src, abs, descriptor: rest.join(' ') });
    }
    // Store for async processing
    $(el).data('_srcset_jobs', rewrites);
  });

  const srcsetEls = [];
  $('[srcset]').each((_, el) => srcsetEls.push(el));
  for (const el of srcsetEls) {
    const jobs = $(el).data('_srcset_jobs') || [];
    const newParts = [];
    for (const j of jobs) {
      const body = captured.get(j.abs) || null;
      const saved = await downloadAsset(j.abs, outputDir, downloaded, body);
      const rel = saved ? relPath(htmlFilePath, saved) : j.src;
      newParts.push(j.descriptor ? `${rel} ${j.descriptor}` : rel);
    }
    if (newParts.length) $(el).attr('srcset', newParts.join(', '));
  }

  // --- Favicons / manifest / other link assets ---
  const linkAssetEls = [];
  $('link[rel~="icon"], link[rel="apple-touch-icon"], link[rel="manifest"]').each((_, el) =>
    linkAssetEls.push(el)
  );
  for (const el of linkAssetEls) await handleAttr(el, 'href', 'img');

  // --- Inline style url() ---
  console.log('Processing inline styles...');
  const inlineStyleEls = [];
  $('[style]').each((_, el) => inlineStyleEls.push(el));
  for (const el of inlineStyleEls) {
    const style = $(el).attr('style') || '';
    const m = style.match(/url\(['"]?([^'"\)\s]+)['"]?\)/);
    if (!m || m[1].startsWith('data:')) continue;
    const abs = resolveUrl(targetUrl, m[1]);
    if (!abs) continue;
    const body = captured.get(abs) || null;
    const saved = await downloadAsset(abs, outputDir, downloaded, body);
    if (saved) {
      const rel = relPath(htmlFilePath, saved);
      $(el).attr('style', style.split(m[1]).join(rel));
    }
  }

  // --- Inline <style> blocks ---
  const styleBlocks = [];
  $('style').each((_, el) => styleBlocks.push(el));
  for (const el of styleBlocks) {
    const text = $(el).html() || '';
    const processed = await processCSS(text, targetUrl, outputDir, downloaded);
    $(el).html(processed);
  }

  // --- Preload / prefetch links ---
  $('link[rel="preload"], link[rel="prefetch"]').each((_, el) => {
    // Remove these — they try to load from origin and cause console errors
    $(el).remove();
  });

  // Clean up base tag so relative paths resolve correctly from disk
  $('base').remove();
  if (!$('head meta[charset]').length) {
    $('head').prepend('<meta charset="utf-8">');
  }

  const prettyHtml = beautify($.html(), {
    indent_size: 2,
    indent_char: ' ',
    max_preserve_newlines: 1,
    preserve_newlines: true,
    wrap_line_length: 0,         // nie łam długich linii
    wrap_attributes: 'force-aligned',
    end_with_newline: true,
    unformatted: ['script', 'style'],  // nie ruszaj zawartości script/style
    content_unformatted: ['pre', 'textarea'],
    extra_liners: ['head', 'body', '/html'],
  });
  fs.writeFileSync(htmlFilePath, prettyHtml, 'utf-8');

  console.log(`\n✅ Done!`);
  console.log(`   Assets downloaded : ${downloaded.size}`);
  console.log(`   Open in browser   : ${htmlFilePath}`);
}

clone(TARGET_URL).catch(e => {
  console.error('Fatal error:', e.message);
  process.exit(1);
});
