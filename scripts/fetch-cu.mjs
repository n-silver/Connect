// scripts/fetch-cu.mjs
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const SITE = 'https://www.connectionsunlimited.org/';
const ROOT = process.cwd();
const INDEX = path.join(ROOT, 'index.html');
const PUZZLES_DIR = path.join(ROOT, 'puzzles');

const today = new Date().toISOString().slice(0,10);

// --- tiny helpers ---
const safeJSON = s => { try { return JSON.parse(s); } catch { return null; } };
const uniqBy = (arr, key) => {
  const seen = new Set(); const out = [];
  for (const x of arr) { const k = key(x); if (!seen.has(k)) { seen.add(k); out.push(x); } }
  return out;
};

// Scan any JS object for a {categories:[{title,words:[…]}x4]} shape
function findCategoriesAnywhere(obj) {
  let found = null;
  const visit = (v) => {
    if (!v || typeof v !== 'object' || found) return;
    if (Array.isArray(v)) { v.forEach(visit); return; }
    if (v.categories && Array.isArray(v.categories) && v.categories.length === 4) {
      const ok = v.categories.every(c =>
        c && typeof c.title === 'string' &&
        Array.isArray(c.words) && c.words.length === 4 &&
        c.words.every(w => typeof w === 'string')
      );
      if (ok) { found = v.categories; return; }
    }
    for (const k of Object.keys(v)) visit(v[k]);
  };
  visit(obj);
  return found;
}

async function fetchPuzzle() {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  // capture any JSON responses
  const jsonPayloads = [];
  page.on('response', async (resp) => {
    try {
      const ct = (resp.headers()['content-type'] || '').toLowerCase();
      if (!ct.includes('application/json')) return;
      const j = await resp.json().catch(() => null);
      if (j) jsonPayloads.push(j);
    } catch {}
  });

  await page.goto(SITE, { waitUntil: 'domcontentloaded', timeout: 45000 });
  // allow SPA to boot & requests to finish
  await page.waitForTimeout(6000);

  // 1) Try network JSON first
  let categories = null;
  for (const j of jsonPayloads) {
    const cats = findCategoriesAnywhere(j);
    if (cats) { categories = cats; break; }
  }

  // 2) If needed, try to scrape visible words from DOM (not ideal for answers)
  let words = [];
  if (!categories) {
    words = await page.evaluate(() => {
      const getText = el => (el.textContent || '').trim();
      const buttons = Array.from(document.querySelectorAll('button'));
      const tiles = buttons.map(getText).filter(Boolean);
      // de-dup and keep likely 16
      return Array.from(new Set(tiles)).slice(0, 16);
    });
  }

  await browser.close();

  if (!categories && words.length !== 16) {
    throw new Error('Could not capture puzzle data.');
  }

  // Build puzzle object your page expects
  const puzzle = {
    date: today,
    categories: categories ? categories.map(c => ({ title: c.title, words: c.words })) : [
      // If only words were found (rare), put them into 4 buckets of 4 so the page still loads;
      // You can delete this fallback if you prefer to fail instead.
      { title: 'Group 1', words: words.slice(0, 4) },
      { title: 'Group 2', words: words.slice(4, 8) },
      { title: 'Group 3', words: words.slice(8, 12) },
      { title: 'Group 4', words: words.slice(12, 16) }
    ]
  };

  return puzzle;
}

async function ensureDir(p) { await fs.mkdir(p, { recursive: true }); }

async function readCurrentPuzzlesFromIndex() {
  const html = await fs.readFile(INDEX, 'utf8');
  const m = html.match(/<script id="conn-data" type="application\/json">\s*([\s\S]*?)\s*<\/script>/);
  if (!m) throw new Error('Could not find <script id="conn-data" ...> in index.html');
  const raw = m[1].trim();
  const data = raw ? safeJSON(raw) : null;
  const puzzles = data?.puzzles && Array.isArray(data.puzzles) ? data.puzzles : [];
  return { html, puzzles, match: m[0] };
}

function embedPuzzlesIntoIndex(html, puzzles) {
  const payload = JSON.stringify({ puzzles }, null, 2);
  const replacement = `<script id="conn-data" type="application/json">\n${payload}\n</script>`;
  return html.replace(/<script id="conn-data" type="application\/json">[\s\S]*?<\/script>/, replacement);
}

async function main() {
  const newPuzzle = await fetchPuzzle();

  // 1) Update the archive files
  await ensureDir(PUZZLES_DIR);
  await fs.writeFile(path.join(PUZZLES_DIR, `${today}.json`), JSON.stringify(newPuzzle, null, 2));
  await fs.writeFile(path.join(PUZZLES_DIR, `latest.json`), JSON.stringify(newPuzzle, null, 2));

  // 2) Update the embedded JSON inside index.html
  const { html, puzzles } = await readCurrentPuzzlesFromIndex();
  const merged = uniqBy([newPuzzle, ...puzzles], p => p.date); // keep newest first, de-dup by date
  const nextHtml = embedPuzzlesIntoIndex(html, merged);
  await fs.writeFile(INDEX, nextHtml, 'utf8');

  console.log(`Updated puzzles: added ${newPuzzle.date}.`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
