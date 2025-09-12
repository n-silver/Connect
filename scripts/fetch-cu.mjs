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
const REPLAY_HAR = getArg('--replay-har', null);
const SAVE_HAR   = getArg('--save-har', null);
const DUMP       = args.has('--dump-buttons');
const DRY_RUN    = args.has('--dry-run');
const ALLOW_FALLBACK = args.has('--allow-fallback'); // only if you *really* want fake groups

// ---- utils ----
const safeJSON = s => { try { return JSON.parse(s); } catch { return null; } };
const uniqBy = (arr, key) => {
  const seen = new Set(); const out = [];
  for (const x of arr) { const k = key(x); if (!seen.has(k)) { seen.add(k); out.push(x); } }
  return out;
};

// find { categories:[ {title,words:[4]} x4 ] } anywhere inside an object
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

// debug helper: tile candidates (not used for grouping)
async function extractWordsFromDOM(page) {
  return await page.evaluate((dump) => {
    const isVisible = (el) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
    };
    const btns = Array.from(document.querySelectorAll('button, [role="button"]')).filter(isVisible);

    // group by ancestor with lots of buttons, pick largest
    const groups = new Map();
    for (const b of btns) {
      let a = b.parentElement, host = null;
      for (let d = 0; a && d < 6; d++, a = a.parentElement) {
        const count = a.querySelectorAll('button, [role="button"]').length;
        if (count >= 12) { host = a; break; }
      }
      const key = host || document.body;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(b);
    }
    let best = null, max = 0;
    for (const arr of groups.values()) if (arr.length > max) { max = arr.length; best = arr; }

    if (dump) {
      console.log('--- All candidate buttons (visible) ---');
      for (const el of btns) console.log('BTN:', (el.textContent || '').trim());
    }

    const IGNORES = [
      /login/i, /sign\s*up/i, /register/i, /profile/i, /menu/i, /share/i, /settings?/i, /account/i,
      /hint/i, /help/i, /give\s*up/i, /reset/i, /check/i, /new/i, /start/i, /today/i,
      /archive/i, /daily/i, /random/i,
      /^\?$/, /^…$/, /\//
    ];

    const raw = (best || []).map(el => {
      const t = (el.textContent || '').trim();
      const r = el.getBoundingClientRect();
      return { t, w: r.width, h: r.height };
    });

    let texts = raw
      .filter(x => !!x.t)
      .filter(x => !IGNORES.some(r => r.test(x.t)))
      .filter(x => !/\s/.test(x.t))        // single token
      .filter(x => x.t.length >= 2 && x.t.length <= 18)
      .filter(x => x.w >= 50 && x.h >= 40) // avoid tiny icons
      .map(x => x.t);

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
  if (replayHar) await context.routeFromHAR(replayHar, { notFound: 'abort' });

  const page = await context.newPage();

  // collect ALL responses and try parsing JSON even if content-type is wrong
  const payloads = [];
  page.on('response', async (resp) => {
    try {
      const ct = (resp.headers()['content-type'] || '').toLowerCase();
      const status = resp.status();
      if (status >= 300) return;
      // prefer JSON parsing; fall back to text->JSON
      let j = null;
      if (ct.includes('application/json')) {
        j = await resp.json().catch(() => null);
      } else {
        const txt = await resp.text().catch(() => '');
        if (txt && /"categories"\s*:/.test(txt)) j = safeJSON(txt);
      }
      if (j) payloads.push(j);
    } catch {}
  });

  await page.goto(SITE, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(6000); // let SPA boot

  // 1) Try to find categories in network payloads
  let categories = null;
  for (const j of payloads) {
    const cats = findCategoriesAnywhere(j);
    if (cats) { categories = cats; break; }
  }

  // 2) Try localStorage / sessionStorage (some sites stash puzzle JSON there)
  if (!categories) {
    const stor = await page.evaluate(() => {
      const dump = s => {
        const out = [];
        for (let i = 0; i < s.length; i++) {
          const k = s.key(i);
          const v = s.getItem(k);
          out.push([k, v]);
        }
        return out;
      };
      return { ls: dump(localStorage), ss: dump(sessionStorage) };
    });
    for (const [k, v] of [...stor.ls, ...stor.ss]) {
      const obj = safeJSON(v);
      if (!obj) continue;
      const cats = findCategoriesAnywhere(obj);
      if (cats) { categories = cats; break; }
    }
  }

  // 3) (optional) words only for debugging
  let words = [];
  try { words = await extractWordsFromDOM(page); } catch {}

  await context.close();
  await browser.close();

  if (!categories) {
    console.log('Could not find categories in network/storage.');
    if (words?.length) console.log('Saw word candidates:', words);
    if (!ALLOW_FALLBACK) {
      throw new Error('Strict mode: aborting because categories were not found.');
    }
    // ONLY if you pass --allow-fallback do we fabricate groups (not recommended)
    console.warn('[WARN] Falling back to fake groups due to --allow-fallback.');
    categories = [
      { title: 'Group 1', words: words.slice(0, 4) },
      { title: 'Group 2', words: words.slice(4, 8) },
      { title: 'Group 3', words: words.slice(8, 12) },
      { title: 'Group 4', words: words.slice(12, 16) }
    ];
  }

  // Build puzzle object (answers included)
  const puzzle = {
    date: today,
    categories: categories.map(c => ({ title: c.title, words: c.words }))
  };

  // tiny sanity check
  const sum = puzzle.categories.reduce((n, c) => n + c.words.length, 0);
  if (puzzle.categories.length !== 4 || sum !== 16) {
    throw new Error(`Invalid categories shape (got ${puzzle.categories.length} groups / ${sum} words).`);
  }

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
