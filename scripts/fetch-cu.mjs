// scripts/fetch-cu.mjs
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const SITE = 'https://www.connectionsunlimited.org/';
const ROOT = process.cwd();
const INDEX = path.join(ROOT, 'index.html');
const PUZZLES_DIR = path.join(ROOT, 'puzzles');
const today = new Date().toISOString().slice(0, 10);

// ---- CLI flags ----
const args = new Set(process.argv.slice(2));
const getArg = (name, fallback = undefined) => {
  const x = [...args].find(a => a.startsWith(name + '='));
  return x ? x.split('=').slice(1).join('=') : fallback;
};
const REPLAY_HAR = getArg('--replay-har', null); // path to .har to replay
const SAVE_HAR   = getArg('--save-har', null);   // path to save .har
const DUMP       = args.has('--dump-buttons');   // log all candidate button texts
const DRY_RUN    = args.has('--dry-run');        // don't write files

// ---- small utils ----
const safeJSON = s => { try { return JSON.parse(s); } catch { return null; } };
const uniqBy = (arr, key) => {
  const seen = new Set(); const out = [];
  for (const x of arr) { const k = key(x); if (!seen.has(k)) { seen.add(k); out.push(x); } }
  return out;
};

// Heuristic: locate { categories:[{title,words:[4]} x4] } anywhere inside a JSON object
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

// Extract words from DOM when network JSON isn’t found
async function extractWordsFromDOM(page) {
  return await page.evaluate((dump) => {
    const isVisible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };

    // gather **visible** button-like elements
    const btns = Array.from(document.querySelectorAll('button, [role="button"]')).filter(isVisible);

    // Group buttons by the nearest ancestor that contains lots of buttons (>= 12)
    const groups = new Map();
    for (const b of btns) {
      let a = b.parentElement, host = null;
      for (let depth = 0; a && depth < 6; depth++, a = a.parentElement) {
        const count = a.querySelectorAll('button, [role="button"]').length;
        if (count >= 12) { host = a; break; }
      }
      const key = host || document.body;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(b);
    }

    // pick the largest cluster
    let best = null, max = 0;
    for (const arr of groups.values()) if (arr.length > max) { max = arr.length; best = arr; }

    // texts for debugging
    if (dump) {
      console.log('--- All candidate buttons (visible) ---');
      for (const el of btns) console.log('BTN:', (el.textContent || '').trim());
    }

    const IGNORES = [
      /login/i, /sign\s*up/i, /register/i, /menu/i, /share/i, /settings?/i, /account/i,
      /hint/i, /help/i, /give\s*up/i, /reset/i, /check/i, /new/i, /start/i, /today/i,
      /archive/i, /daily/i, /random/i
    ];

    const rawTexts = (best || []).map(el => {
      const t = (el.textContent || '').trim();
      const rect = el.getBoundingClientRect();
      return { t, w: rect.width, h: rect.height };
    });

    // Filter rules:
    //  - non-empty
    //  - not "?" or "…" or a slashy label like "Login / Sign Up"
    //  - not matching common nav/action words
    //  - **single word** (no spaces) – Connections tiles are single tokens
    //  - reasonable length & size (avoid tiny icons)
    let texts = rawTexts
      .filter(x => !!x.t)
      .filter(x => x.t !== '?' && x.t !== '…')
      .filter(x => !x.t.includes('/'))
      .filter(x => !IGNORES.some(r => r.test(x.t)))
      .filter(x => !/\s/.test(x.t))        // single token
      .filter(x => x.t.length >= 2 && x.t.length <= 14)
      .filter(x => x.w >= 50 && x.h >= 40) // probably a tile, not a tiny icon
      .map(x => x.t);

    // Deduplicate & cap at 16
    texts = Array.from(new Set(texts)).slice(0, 16);

    if (dump) {
      console.log('--- Filtered tile candidates ---');
      console.log(texts);
    }
    return texts;
  }, DUMP);
}

async function fetchPuzzle({ replayHar, saveHar } = {}) {
  const browser = await chromium.launch();
  const context = await browser.newContext(
    saveHar ? { recordHar: { path: saveHar, content: 'embed', mode: 'minimal' } } : {}
  );
  if (replayHar) {
    await context.routeFromHAR(replayHar, { notFound: 'abort' });
  }

  const page = await context.newPage();
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
  await page.waitForTimeout(6000); // let SPA settle

  // Try to find categories from any JSON first (best quality)
  let categories = null;
  for (const j of jsonPayloads) {
    const cats = findCategoriesAnywhere(j);
    if (cats) { categories = cats; break; }
  }

  // Fallback: DOM words (robust filters)
  let words = [];
  if (!categories) {
    words = await extractWordsFromDOM(page);
  }

  await context.close();
  await browser.close();

  if (!categories && words.length !== 16) {
    throw new Error(`Could not capture 16 words (got ${words.length}).`);
  }

  const puzzle = {
    date: today,
    categories: categories
      ? categories.map(c => ({ title: c.title, words: c.words }))
      : [
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
  return { html, puzzles };
}

function embedPuzzlesIntoIndex(html, puzzles) {
  const payload = JSON.stringify({ puzzles }, null, 2);
  const replacement = `<script id="conn-data" type="application/json">\n${payload}\n</script>`;
  return html.replace(/<script id="conn-data" type="application\/json">[\s\S]*?<\/script>/, replacement);
}

async function main() {
  const newPuzzle = await fetchPuzzle({ replayHar: REPLAY_HAR, saveHar: SAVE_HAR });

  if (DRY_RUN) {
    console.log(`[DRY RUN] Captured puzzle for ${newPuzzle.date}`);
    console.log(JSON.stringify(newPuzzle, null, 2));
    return;
  }

  await ensureDir(PUZZLES_DIR);
  await fs.writeFile(path.join(PUZZLES_DIR, `${today}.json`), JSON.stringify(newPuzzle, null, 2));
  await fs.writeFile(path.join(PUZZLES_DIR, `latest.json`), JSON.stringify(newPuzzle, null, 2));

  const { html, puzzles } = await readCurrentPuzzlesFromIndex();
  const merged = uniqBy([newPuzzle, ...puzzles], p => p.date); // newest first, de-dup by date
  const nextHtml = embedPuzzlesIntoIndex(html, merged);
  await fs.writeFile(INDEX, nextHtml, 'utf8');

  console.log(`Updated puzzles: added ${newPuzzle.date}.`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
