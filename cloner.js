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
// Strip all <script> tags from output — page already rendered by Puppeteer.
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
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
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
// CSS processor – rewrites url() / @import to local relative paths.
// cssOutputPath: absolute path where the CSS will be saved (used to compute
// correct relative references). Falls back to localPath(cssUrl) if omitted.
// ---------------------------------------------------------------------------
async function processCSS(cssText, cssUrl, outputDir, downloaded, cssOutputPath) {
  const urlRe = /url\(\s*(['"]?)([^'"\)\s]+)\1\s*\)/g;
  const importRe = /@import\s+(?:url\(\s*['"]?([^'"\)]+)['"]?\s*\)|['"]([^'"]+)['"])/g;
  const jobs = new Map(); // raw → abs

  let m;
  while ((m = urlRe.exec(cssText)) !== null) {
    const raw = m[2].trim();
    if (raw.startsWith('data:') || jobs.has(raw)) continue;
    const abs = resolveUrl(cssUrl, raw);
    if (abs) jobs.set(raw, abs);
  }
  while ((m = importRe.exec(cssText)) !== null) {
    const raw = (m[1] || m[2]).trim();
    if (raw.startsWith('data:') || jobs.has(raw)) continue;
    const abs = resolveUrl(cssUrl, raw);
    if (abs) jobs.set(raw, abs);
  }

  const cssFilePath = cssOutputPath || localPath(cssUrl, outputDir);
  for (const [raw, abs] of jobs) {
    const saved = await downloadAsset(abs, outputDir, downloaded);
    if (saved) {
      const rel = relPath(cssFilePath, saved);
      cssText = cssText.split(raw).join(rel);
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
      data = Buffer.isBuffer(bodyOverride) ? bodyOverride : Buffer.from(bodyOverride);
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
// Scroll the full page to trigger lazy-loaded images / infinite scroll content
// ---------------------------------------------------------------------------
async function autoScroll(page) {
  await page.evaluate(async () => {
    await new Promise(resolve => {
      const step = 400;
      const intervalMs = 80;
      // Cap at a reasonable max so we don't scroll forever on infinite-scroll pages
      const maxPx = Math.min(document.body.scrollHeight, 15000);
      let scrolled = 0;
      const t = setInterval(() => {
        window.scrollBy(0, step);
        scrolled += step;
        if (scrolled >= maxPx) {
          clearInterval(t);
          window.scrollTo(0, 0);
          resolve();
        }
      }, intervalMs);
    });
  });
  // Give lazy-loaded resources a moment to finish fetching
  await new Promise(r => setTimeout(r, 1500));
}

// ---------------------------------------------------------------------------
// Extract ALL CSS from the live page via CSSOM — captures CSS-in-JS, Stylex,
// Emotion, styled-components, and any <style> tag injected by JavaScript.
// Requires --disable-web-security so cross-origin sheet rules are readable.
// ---------------------------------------------------------------------------
async function extractCSSOM(page) {
  return page.evaluate(() => {
    const results = [];
    for (const sheet of document.styleSheets) {
      try {
        const rules = [];
        for (const rule of sheet.cssRules || []) {
          // Skip @import — the imported sheet appears as its own entry
          if (rule.type === 3 /* IMPORT_RULE */) continue;
          // Skip @charset — meaningless in a concatenated file
          if (rule.type === 2 /* CHARSET_RULE */) continue;
          rules.push(rule.cssText);
        }
        results.push({
          href: sheet.href || null,
          media: sheet.media?.mediaText || '',
          rules: rules.join('\n'),
        });
      } catch {
        // Still cross-origin even with --disable-web-security (rare); fall back
        // to whatever we captured from the network.
        if (sheet.href) results.push({ href: sheet.href, crossOrigin: true });
      }
    }
    return results;
  });
}

// ---------------------------------------------------------------------------
// Find Chrome / Chromium executable
// ---------------------------------------------------------------------------
async function findChromium() {
  const { execSync } = require('child_process');
  let executablePath;
  try {
    executablePath = puppeteer.executablePath();
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
  }
  if (!executablePath) throw new Error(
    'Chrome/Chromium not found. Install with:\n' +
    '  sudo apt-get install -y chromium-browser\n' +
    'or install the required libs for puppeteer\'s bundled Chrome.'
  );
  return executablePath;
}

// ---------------------------------------------------------------------------
// Puppeteer page fetch – returns rendered HTML + intercepted resource map
// + CSSOM-extracted stylesheets
// ---------------------------------------------------------------------------
async function fetchWithPuppeteer(targetUrl) {
  console.log('Launching headless Chrome...');
  const executablePath = await findChromium();
  console.log(`  Browser: ${executablePath}`);

  const browser = await puppeteer.launch({
    headless: 'new',
    executablePath,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      // Allow reading cross-origin CSS rules via document.styleSheets
      '--disable-web-security',
      '--disable-features=IsolateOrigins,site-per-process',
      '--allow-running-insecure-content',
      // Reduces headless-browser fingerprint
      '--disable-blink-features=AutomationControlled',
      '--window-size=1440,900',
    ],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
  );

  // Basic stealth: hide navigator.webdriver and add minimal browser fingerprint
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    delete navigator.__proto__.webdriver;
    Object.defineProperty(navigator, 'plugins', {
      get: () => ({ length: 3, 0: { name: 'Chrome PDF Plugin' }, 1: { name: 'Chrome PDF Viewer' }, 2: { name: 'Native Client' } }),
    });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    window.chrome = { runtime: {}, loadTimes: () => {}, csi: () => {}, app: {} };
  });

  // Intercept all network requests so we capture response bodies for assets
  const captured = new Map(); // url → Buffer
  await page.setRequestInterception(true);

  page.on('request', req => {
    const u = req.url();
    if (/google-analytics|googletagmanager|doubleclick/.test(u)) {
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
      // redirects / aborted responses have no body
    }
  });

  console.log(`Navigating to ${targetUrl} ...`);
  try {
    await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 60000 });
  } catch (e) {
    console.warn(`Navigation warning: ${e.message} — continuing with what we have`);
  }

  // Dismiss cookie consent modals (Instagram and common patterns)
  try {
    await page.evaluate(() => {
      // Find buttons by text content and click the first "allow all" match
      const keywords = [
        'allow all cookies', 'allow all', 'accept all', 'allow essential and optional cookies',
        'zezwól na wszystkie', 'zaakceptuj wszystkie', 'zgadzam się', 'akceptuję',
        'alle cookies akzeptieren', 'tout accepter',
      ];
      for (const el of document.querySelectorAll('button, [role="button"]')) {
        const text = el.textContent.trim().toLowerCase();
        if (keywords.some(k => text.includes(k))) {
          el.click();
          return true;
        }
      }
      return false;
    });
    // Give the modal time to animate out and the page to settle
    await new Promise(r => setTimeout(r, 1500));
  } catch (e) {
    console.warn(`Cookie dismissal warning: ${e.message}`);
  }

  // Scroll to trigger lazy-loaded images and JS-rendered content
  console.log('Scrolling page to trigger lazy loading...');
  await autoScroll(page);

  // Give JS-heavy SPAs (React, Vue, Angular) extra time to settle
  await new Promise(r => setTimeout(r, 2000));

  // Extract every CSS rule the browser has loaded — this is the key step that
  // captures CSS-in-JS (Stylex, Emotion, styled-components, etc.)
  console.log('Extracting CSS via CSSOM...');
  const cssomSheets = await extractCSSOM(page);
  console.log(`  Found ${cssomSheets.length} stylesheets in CSSOM`);

  const html = await page.content();
  await browser.close();
  console.log(`Captured ${captured.size} network responses from browser.\n`);
  return { html, captured, cssomSheets };
}

// ---------------------------------------------------------------------------
// Static fetch (no JS execution)
// ---------------------------------------------------------------------------
async function fetchStatic(targetUrl) {
  const resp = await http.get(targetUrl);
  return { html: Buffer.from(resp.data).toString('utf-8'), captured: new Map(), cssomSheets: [] };
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

  const { html, captured, cssomSheets } = USE_STATIC
    ? await fetchStatic(targetUrl)
    : await fetchWithPuppeteer(targetUrl);

  const $ = cheerio.load(html, { decodeEntities: false });
  const downloaded = new Map();
  const htmlFilePath = path.join(outputDir, 'index.html');

  // ---------------------------------------------------------------------------
  // CSS — build one combined stylesheet from CSSOM data.
  // This single step handles: static CSS files, dynamic <style> injections,
  // CSS-in-JS (Stylex, Emotion, …), and cross-origin CDN stylesheets.
  // ---------------------------------------------------------------------------
  const allCssFilePath = path.join(outputDir, 'assets', 'all-styles.css');
  fs.mkdirSync(path.dirname(allCssFilePath), { recursive: true });

  let cssFromCSSOM = '';
  if (cssomSheets.length > 0) {
    console.log('Building combined stylesheet from CSSOM...');
    for (const sheet of cssomSheets) {
      if (sheet.crossOrigin) {
        // CSSOM couldn't read the rules — use the buffer we captured from the network
        const buf = captured.get(sheet.href);
        if (buf) {
          cssFromCSSOM += `/* ${sheet.href} */\n${buf.toString('utf-8')}\n`;
        }
      } else if (sheet.rules && sheet.rules.trim()) {
        const label = sheet.href ? `/* ${sheet.href} */` : '/* inline */';
        cssFromCSSOM += `${label}\n${sheet.rules}\n`;
      }
    }
  }

  if (cssFromCSSOM.trim()) {
    // Process the combined CSS: download fonts, background images, etc.
    console.log('Processing assets referenced in CSS...');
    const processedCSS = await processCSS(
      cssFromCSSOM, targetUrl, outputDir, downloaded, allCssFilePath
    );
    fs.writeFileSync(allCssFilePath, processedCSS, 'utf-8');
    console.log(`  ✓ all-styles.css  (${Math.round(processedCSS.length / 1024)} KB)`);

    // Remove all existing stylesheet links and inline <style> blocks — we
    // replace them with a single reference to our combined file.
    $('link[rel="stylesheet"], link[as="style"]').remove();
    $('style').remove();
    $('head').append(`<link rel="stylesheet" href="${relPath(htmlFilePath, allCssFilePath)}">`);
  } else {
    // CSSOM extraction returned nothing (e.g. --static mode or very simple page).
    // Fall back to processing <link> and <style> elements individually.
    console.log('CSSOM empty — processing CSS elements individually (fallback)...');

    async function processCSSLink(el) {
      const val = $(el).attr('href');
      if (!val || val.startsWith('data:')) return;
      const abs = resolveUrl(targetUrl, val);
      if (!abs) return;
      const rawBuf = captured.get(abs);
      let cssText = rawBuf ? rawBuf.toString('utf-8') : null;
      if (!cssText) {
        try { cssText = Buffer.from((await http.get(abs)).data).toString('utf-8'); } catch { return; }
      }
      const filePath = localPath(abs, outputDir);
      cssText = await processCSS(cssText, abs, outputDir, downloaded, filePath);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, cssText, 'utf-8');
      downloaded.set(abs, filePath);
      $(el).attr('href', relPath(htmlFilePath, filePath));
      console.log(`  ✓ CSS: ${abs.substring(0, 80)}`);
    }

    const cssEls = [];
    $('link[rel="stylesheet"], link[as="style"]').each((_, el) => cssEls.push(el));
    for (const el of cssEls) await processCSSLink(el);

    const styleBlocks = [];
    $('style').each((_, el) => styleBlocks.push(el));
    for (const el of styleBlocks) {
      const text = $(el).html() || '';
      $(el).html(await processCSS(text, targetUrl, outputDir, downloaded));
    }
  }

  // ---------------------------------------------------------------------------
  // Scripts
  // ---------------------------------------------------------------------------
  if (STRIP_JS) {
    $('script').remove();
    $('link[rel="preload"][as="script"], link[rel="modulepreload"]').remove();
    console.log('JS stripped (use --keep-js to preserve scripts).');
  } else {
    console.log('Processing JS...');
    const scriptEls = [];
    $('script[src]').each((_, el) => scriptEls.push(el));
    for (const el of scriptEls) {
      const val = $(el).attr('src');
      if (!val || val.startsWith('data:')) continue;
      const abs = resolveUrl(targetUrl, val);
      if (!abs) continue;
      const saved = await downloadAsset(abs, outputDir, downloaded, captured.get(abs) || null);
      if (saved) $(el).attr('src', relPath(htmlFilePath, saved));
    }
  }

  // ---------------------------------------------------------------------------
  // Images and other media assets
  // ---------------------------------------------------------------------------
  console.log('Processing images and media...');

  async function handleAttr(el, attr) {
    const val = $(el).attr(attr);
    if (!val || val.startsWith('data:')) return;
    const abs = resolveUrl(targetUrl, val);
    if (!abs) return;
    const saved = await downloadAsset(abs, outputDir, downloaded, captured.get(abs) || null);
    if (saved) $(el).attr(attr, relPath(htmlFilePath, saved));
  }

  async function handleSrcset(el) {
    const srcset = $(el).attr('srcset') || '';
    const parts = srcset.split(',').map(s => s.trim()).filter(Boolean);
    const newParts = [];
    for (const part of parts) {
      const [src, ...rest] = part.split(/\s+/);
      if (!src || src.startsWith('data:')) { newParts.push(part); continue; }
      const abs = resolveUrl(targetUrl, src);
      if (!abs) { newParts.push(part); continue; }
      const saved = await downloadAsset(abs, outputDir, downloaded, captured.get(abs) || null);
      const localSrc = saved ? relPath(htmlFilePath, saved) : src;
      newParts.push(rest.length ? `${localSrc} ${rest.join(' ')}` : localSrc);
    }
    if (newParts.length) $(el).attr('srcset', newParts.join(', '));
  }

  // img — multiple lazy-load attribute conventions
  for (const attr of ['src', 'data-src', 'data-lazy-src', 'data-original', 'data-lazy']) {
    const els = [];
    $(`img[${attr}]`).each((_, el) => els.push(el));
    for (const el of els) await handleAttr(el, attr);
  }

  // srcset on <img> and <source>
  const srcsetEls = [];
  $('[srcset]').each((_, el) => srcsetEls.push(el));
  for (const el of srcsetEls) await handleSrcset(el);

  // <source src> inside <video> / <audio> / <picture>
  const sourceEls = [];
  $('source[src]').each((_, el) => sourceEls.push(el));
  for (const el of sourceEls) await handleAttr(el, 'src');

  // <video poster>
  const videoEls = [];
  $('video[poster]').each((_, el) => videoEls.push(el));
  for (const el of videoEls) await handleAttr(el, 'poster');

  // Common data-attribute patterns for background images / lazy loaders
  for (const attr of ['data-bg', 'data-background', 'data-background-image', 'data-img-src']) {
    const els = [];
    $(`[${attr}]`).each((_, el) => els.push(el));
    for (const el of els) await handleAttr(el, attr);
  }

  // Favicons / manifest / apple-touch-icon
  const linkAssetEls = [];
  $('link[rel~="icon"], link[rel="apple-touch-icon"], link[rel="manifest"]').each((_, el) =>
    linkAssetEls.push(el)
  );
  for (const el of linkAssetEls) await handleAttr(el, 'href');

  // ---------------------------------------------------------------------------
  // Inline style attributes — rewrite ALL url() occurrences (not just the first)
  // ---------------------------------------------------------------------------
  console.log('Processing inline styles...');
  const inlineUrlRe = /url\(\s*(['"]?)([^'"\)\s]+)\1\s*\)/g;
  const inlineStyleEls = [];
  $('[style]').each((_, el) => inlineStyleEls.push(el));
  for (const el of inlineStyleEls) {
    let style = $(el).attr('style') || '';
    const replacements = new Map();
    let m;
    while ((m = inlineUrlRe.exec(style)) !== null) {
      const raw = m[2];
      if (raw.startsWith('data:') || replacements.has(raw)) continue;
      const abs = resolveUrl(targetUrl, raw);
      if (!abs) continue;
      const saved = await downloadAsset(abs, outputDir, downloaded, captured.get(abs) || null);
      if (saved) replacements.set(raw, relPath(htmlFilePath, saved));
    }
    for (const [raw, rel] of replacements) {
      style = style.split(raw).join(rel);
    }
    $(el).attr('style', style);
  }

  // ---------------------------------------------------------------------------
  // Clean up the HTML
  // ---------------------------------------------------------------------------

  // preload/prefetch tags try to reach origin and only cause console errors locally
  $('link[rel="preload"], link[rel="prefetch"]').remove();

  // Remove CSP meta tags — they would block loading local assets in some browsers
  $('meta[http-equiv="Content-Security-Policy"]').remove();
  $('meta[http-equiv="Content-Security-Policy-Report-Only"]').remove();

  // <base href> would break all relative paths we just computed
  $('base').remove();

  if (!$('head meta[charset]').length) {
    $('head').prepend('<meta charset="utf-8">');
  }

  const prettyHtml = beautify($.html(), {
    indent_size: 2,
    indent_char: ' ',
    max_preserve_newlines: 1,
    preserve_newlines: true,
    wrap_line_length: 0,
    wrap_attributes: 'force-aligned',
    end_with_newline: true,
    unformatted: ['script', 'style'],
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
