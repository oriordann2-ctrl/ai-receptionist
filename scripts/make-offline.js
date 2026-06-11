/**
 * make-offline.js
 * Creates self-contained offline versions of the pitch and designs files.
 * Fetches all external images and inlines them as base64 data URIs.
 * Run: node scripts/make-offline.js
 * Output: public/cosy-cafe-pitch-offline.html
 *         public/cosy-cafe-designs-offline.html
 */

const fs   = require('fs');
const path = require('path');
const https = require('https');
const http  = require('http');

const FILES = [
  'public/cosy-cafe-pitch.html',
  'public/cosy-cafe-designs.html',
];

function fetch(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    mod.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetch(res.headers.location).then(resolve).catch(reject);
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ buffer: Buffer.concat(chunks), type: res.headers['content-type'] || '' }));
      res.on('error', reject);
    }).on('error', reject);
  });
}

function mimeFromUrl(url) {
  if (url.match(/\.png/i))  return 'image/png';
  if (url.match(/\.gif/i))  return 'image/gif';
  if (url.match(/\.svg/i))  return 'image/svg+xml';
  if (url.match(/\.webp/i)) return 'image/webp';
  return 'image/jpeg';
}

async function inlineImages(html) {
  // Match all external http(s) URLs used as src= or url('...') in the HTML
  const urlRegex = /(?:url\(['"]?|src=['"])(https?:\/\/[^'"\)\s>]+)(?:['"]?\)|['"])/g;
  const urls = new Set();
  let m;
  while ((m = urlRegex.exec(html)) !== null) {
    const u = m[1];
    // Only inline images, not scripts/fonts/iframes
    if (u.match(/\.(jpg|jpeg|png|gif|webp|svg)(\?|$)/i) || u.includes('tripadvisor') || u.includes('website-files')) {
      urls.add(u);
    }
  }

  console.log(`  Found ${urls.size} image URLs to inline...`);

  for (const url of urls) {
    try {
      const { buffer, type } = await fetch(url);
      const mime = type.split(';')[0].trim() || mimeFromUrl(url);
      const b64  = buffer.toString('base64');
      const dataUri = `data:${mime};base64,${b64}`;
      // Replace all occurrences (url('...') and src="...")
      html = html.split(url).join(dataUri);
      console.log(`  ✓ Inlined: ${url.substring(0, 80)}...`);
    } catch (e) {
      console.warn(`  ✗ Failed to inline: ${url} — ${e.message}`);
    }
  }

  return html;
}

async function inlineFonts(html) {
  // Remove Google Fonts link tags — fonts fall back to system fonts offline
  html = html.replace(/<link[^>]*fonts\.googleapis\.com[^>]*>/g, '<!-- Google Fonts removed for offline use -->');
  html = html.replace(/<link[^>]*fonts\.gstatic\.com[^>]*>/g, '');
  return html;
}

async function processFile(filePath) {
  const outPath = filePath.replace('.html', '-offline.html');
  console.log(`\nProcessing: ${filePath}`);

  let html = fs.readFileSync(filePath, 'utf8');
  html = await inlineFonts(html);
  html = await inlineImages(html);

  // Add offline banner
  html = html.replace('<body>', `<body>
  <div style="position:fixed;top:0;left:0;right:0;z-index:99999;background:#1e40af;color:#fff;text-align:center;padding:6px;font-size:12px;font-family:sans-serif;font-weight:600;letter-spacing:0.05em;">
    OFFLINE VERSION — sprimal.com
  </div>
  <div style="height:28px"></div>`);

  fs.writeFileSync(outPath, html, 'utf8');
  const kb = Math.round(fs.statSync(outPath).size / 1024);
  console.log(`  ✓ Saved: ${outPath} (${kb} KB)`);
}

(async () => {
  for (const f of FILES) {
    await processFile(f);
  }
  console.log('\n✅ Done. Open the -offline.html files in any browser — no internet needed.');
})();
