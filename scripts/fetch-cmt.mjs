// scripts/fetch-cmt.mjs
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const URL = 'https://capitalizemytitle.com/todays-nyt-connections-answers/';
const ROOT = process.cwd();
const INDEX = path.join(ROOT, 'index.html');
const PUZZLES_DIR = path.join(ROOT, 'puzzles');
const todayUTC = new Date().toISOString().slice(0, 10);

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const safeJSON = (s) => { try { return JSON.parse(s); } catch { return null; } };
const uniqBy = (arr, key) => { const seen = new Set(); const out=[]; for (const x of arr){ const k=key(x); if(!seen.has(k)){ seen.add(k); out.push(x);} } return out; };

const COLORS = ['Yellow','Green','Blue','Purple'];
const cleanTitle = (s) => (s || '').replace(/[“”"’]+/g, '').replace(/\s+/g, ' ').trim();
const cleanWord  = (s) =>
  (s || '')
    .replace(/[“”"’]+/g, '')
    .replace(/[^A-Za-z'’-]/g, '')
    .toUpperCase()
    .trim();
const isWord     = (s) => /^[A-Z][A-Z'’-]*$/.test(s); // uppercase after cleanWord

// Compare full 16-word set, order-insensitive
function flattenWords(puzzle) {
  if (!puzzle?.categories) return '';
  return puzzle.categories
    .flatMap(c => c.words)
    .map(w => String(w).toUpperCase())
    .sort()
    .join('|');
}

async function readPrevLatest() {
  try {
    const raw = await fs.readFile(path.join(PUZZLES_DIR, 'latest.json'), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// Parse a WordPress "content.rendered" HTML string using your existing linear parser
function parseFromRenderedHTML(html) {
  const text = htmlToTextPreservingLines(html || '');
  return parseFromLinearText(text);
}

async function acceptCookies(page) {
  const labels = [/^accept all$/i, /^accept$/i, /^agree$/i, /^ok$/i, /^i agree$/i];
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    for (const fr of page.frames()) {
      const btns = await fr.$$('button, [role="button"]');
      for (const b of btns) {
        const t = ((await b.innerText().catch(()=>'')) || '').trim();
        if (labels.some(re => re.test(t))) { await b.click({ force: true }).catch(()=>{}); return; }
      }
    }
    await sleep(300);
  }
}

async function slowScroll(page, steps = 10, pause = 250) {
  for (let i = 0; i < steps; i++) {
    await page.evaluate(y => window.scrollBy(0, y), 800);
    await sleep(pause);
  }
}

function htmlToTextPreservingLines(html) {
  // Turn block endings into newlines, remove tags, decode a few common entities.
  let t = html;
  t = t.replace(/<br\s*\/?>/gi, '\n');
  t = t.replace(/<\/(p|div|li|h[1-6]|section|article)>/gi, '\n');
  t = t.replace(/<[^>]+>/g, ''); // strip tags
  t = t.replace(/&nbsp;/g, ' ');
  t = t.replace(/&amp;/g, '&');
  t = t.replace(/&ldquo;|&rdquo;|&quot;/g, '"');
  t = t.replace(/&rsquo;|&apos;/g, "'");
  return t;
}

function parseFromLinearText(bigText) {
  // Focus from the "Today’s NYT Connections Puzzle Answer" heading downward
  const anchorRE = /today'?s nyt connections puzzle answer/i;
  const idx = bigText.search(anchorRE);
  const region = idx >= 0 ? bigText.slice(idx) : bigText;

  // Split into trimmed non-empty lines
  const rawLines = region.split(/\r?\n/).map(s => s.replace(/\s+/g,' ').trim());
  const lines = rawLines.filter(Boolean);

  const groups = [];

  for (const color of COLORS) {
    // Find a nearby colour header line
    let colorAt = lines.findIndex(l =>
      new RegExp(`\\b${color}\\b`, 'i').test(l) &&
      (/\banswer\b|\bcategory\b|\bgroup\b/i.test(l) || /[:–—-]/.test(l))
    );
    if (colorAt < 0) {
      // fallback: first appearance of the colour
      colorAt = lines.findIndex(l => new RegExp(`\\b${color}\\b`, 'i').test(l));
      if (colorAt < 0) continue;
    }

    // Search forward (up to ~30 lines) for TITLE: (line ending with colon)
    let titleLineIndex = -1;
    for (let j = colorAt; j < Math.min(colorAt + 30, lines.length); j++) {
      const L = lines[j];
      if (/:\s*$/.test(L) && /[A-Za-z]/.test(L)) {
        titleLineIndex = j;
        break;
      }
    }
    if (titleLineIndex < 0) continue;

    const title = cleanTitle(lines[titleLineIndex].replace(/:\s*$/, ''));

    // Next non-empty line should be the comma list
    let words = [];
    for (let k = titleLineIndex + 1; k < Math.min(titleLineIndex + 6, lines.length); k++) {
      const parts = lines[k].split(',').map(s => cleanWord(s)).filter(isWord);
      if (parts.length >= 4) { words = parts.slice(0,4); break; }
    }
    if (words.length !== 4) {
      // Fallback: collect the next lines that look like single words
      const buf = [];
      for (let k = titleLineIndex + 1; k < Math.min(titleLineIndex + 10, lines.length); k++) {
        const w = cleanWord(lines[k]);
        if (isWord(w)) buf.push(w);
        if (buf.length === 4) break;
      }
      if (buf.length === 4) words = buf;
    }

    if (title && words.length === 4) {
      groups.push({ color, title, words });
    }
  }

  // Ensure we have all four, in NYT color order
  if (groups.length !== 4) return null;
  const byColor = new Map(groups.map(g => [g.color, g]));
  const ordered = COLORS.map(c => byColor.get(c)).filter(Boolean);
  if (ordered.length !== 4) return null;

  return { date: todayUTC, categories: ordered.map(g => ({ title: g.title, words: g.words })) };
}

async function expandAccordions(page) {
  // Scroll to the heading and click colour toggles (if any)
  const head = page.getByRole('heading', { name: /today'?s nyt connections puzzle answer/i }).first();
  try { await head.scrollIntoViewIfNeeded(); } catch {}

  for (const color of COLORS) {
    const toggle = page.locator(
      `xpath=(//h1|//h2|//h3|//h4)[contains(translate(normalize-space(.),"abcdefghijklmnopqrstuvwxyz","ABCDEFGHIJKLMNOPQRSTUVWXYZ"),"TODAY'S NYT CONNECTIONS PUZZLE ANSWER")][1]/following::*[
        self::button or @role="button" or self::summary or contains(@class,'accordion') or contains(@class,'toggle') or contains(@class,'spoiler') or contains(@class,'tab') or contains(@class,'elementor-tab')
      ][contains(translate(normalize-space(.),"abcdefghijklmnopqrstuvwxyz","ABCDEFGHIJKLMNOPQRSTUVWXYZ"), "${color.toUpperCase()}")][1]`
    ).first();
    await toggle.click({ timeout: 2000 }).catch(()=>{});
    await sleep(150);
  }

const ORIGIN = 'https://capitalizemytitle.com';

// Try WordPress REST API first (usually bypasses page-level cache)
async function fetchViaWordPressREST(context) {
  const endpoints = [
    // Exact page by slug
    `${ORIGIN}/wp-json/wp/v2/pages?slug=todays-nyt-connections-answers&_fields=content.rendered,modified_gmt`,
    // If they ever move it to a "post"
    `${ORIGIN}/wp-json/wp/v2/posts?slug=todays-nyt-connections-answers&_fields=content.rendered,modified_gmt`,
    // Fallback: search
    `${ORIGIN}/wp-json/wp/v2/pages?search=nyt%20connections&_fields=content.rendered,modified_gmt&per_page=1`,
    `${ORIGIN}/wp-json/wp/v2/posts?search=nyt%20connections&_fields=content.rendered,modified_gmt&per_page=1`,
  ];

  for (const base of endpoints) {
    const url = `${base}&_=${Date.now()}`;
    const res = await context.request.get(url, {
      headers: { 'Cache-Control': 'no-store', 'Pragma': 'no-cache' }
    }).catch(() => null);
    if (!res || !res.ok()) continue;

    let data;
    try { data = await res.json(); } catch { continue; }
    const arr = Array.isArray(data) ? data : [data];
    for (const item of arr) {
      const html = item?.content?.rendered;
      if (!html) continue;
      const parsed = parseFromRenderedHTML(html);
      if (parsed) return parsed;
    }
  }
  return null;
}

  
  // Click any generic “Answer” toggles too
  const expanders = page.locator(
    `xpath=(//h1|//h2|//h3|//h4)[contains(translate(normalize-space(.),"abcdefghijklmnopqrstuvwxyz","ABCDEFGHIJKLMNOPQRSTUVWXYZ"),"TODAY'S NYT CONNECTIONS PUZZLE ANSWER")][1]/following::*[
      self::button or @role="button" or self::summary
    ][contains(translate(normalize-space(.),"abcdefghijklmnopqrstuvwxyz","ABCDEFGHIJKLMNOPQRSTUVWXYZ"), "ANSWER")]`
  );
  const n = await expanders.count().catch(()=>0);
  for (let i = 0; i < n; i++) {
    await expanders.nth(i).click({ timeout: 1000 }).catch(()=>{});
    await sleep(100);
  }
}

async function fetchTodayFromCMT() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    timezoneId: 'UTC',
    locale: 'en-GB',
    userAgent: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36 Playwright/${Math.floor(Math.random()*1000)}`,
  });
  await context.setExtraHTTPHeaders({
    'Cache-Control': 'no-cache, no-store',
    'Pragma': 'no-cache',
  });
  const page = await context.newPage();

  // 0) Try WordPress REST API (often freshest)
  let result = await fetchViaWordPressREST(context);

  // Helper to load/parse the HTML page with a cache-buster
  const loadFromHTMLOnce = async () => {
    const bust = Date.now();
    const url = `${URL}?ts=${bust}`;
    // Optional: log which URL we hit
    // console.log('Fetching:', url);

    await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
    await sleep(800);
    await acceptCookies(page).catch(()=>{});
    await slowScroll(page, 12, 200);

    // Try collapsed HTML first
    const html1 = await page.content();
    let parsed = parseFromLinearText(htmlToTextPreservingLines(html1));

    // If not parsed, expand accordions and try visible text
    if (!parsed) {
      await expandAccordions(page);
      await sleep(300);
      const text2 = await page.evaluate(() => document.body.innerText);
      parsed = parseFromLinearText(text2);
    }
    return parsed;
  };

  // 1) If REST failed, or we suspect staleness, load HTML
  const prev = await readPrevLatest();
  if (!result) {
    result = await loadFromHTMLOnce();
    if (!result) { await browser.close(); throw new Error('Could not parse 4 colour sections with 4 words each.'); }
  }

  // 2) Stale guard: if words match previous latest.json, reload HTML once more
  if (prev && flattenWords(prev) === flattenWords(result)) {
    await sleep(5000);
    const second = await loadFromHTMLOnce();
    if (second) result = second;
  }

  await browser.close();
  return result;
}

  // First attempt (bypasses cache with ?ts=…)
  let result = await loadOnce();
  if (!result) {
    await browser.close();
    throw new Error('Could not parse 4 colour sections with 4 words each.');
  }

  // Stale-guard: if the words match the last saved latest.json, force one more fresh load
  const prev = await readPrevLatest();
  if (prev && flattenWords(prev) === flattenWords(result)) {
    // Likely hit a stale edge. Wait a moment and try again with a new cache-buster.
    await sleep(5000);
    const second = await loadOnce();
    if (second) result = second;
  }

  await browser.close();
  return result;
}


// --- replace updateFiles(...) and main() in scripts/fetch-cmt.mjs ---

async function updateFiles(puzzle) {
  await fs.mkdir(PUZZLES_DIR, { recursive: true });

  // Write dated + latest
  const datedPath = path.join(PUZZLES_DIR, `${puzzle.date}.json`);
  const latestPath = path.join(PUZZLES_DIR, `latest.json`);
  await fs.writeFile(datedPath, JSON.stringify(puzzle, null, 2));
  await fs.writeFile(latestPath, JSON.stringify(puzzle, null, 2));

  // Update manifest.json (list of dates, newest first)
  const manifestPath = path.join(PUZZLES_DIR, 'manifest.json');
  let manifest = [];
  try {
    const raw = await fs.readFile(manifestPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) manifest = parsed;
  } catch {}
  // de-dup + insert today at the top
  manifest = [puzzle.date, ...manifest.filter(d => d !== puzzle.date)]
    .sort((a, b) => (a < b ? 1 : -1)); // newest first
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
}

async function main() {
  const DRY = process.argv.includes('--dry-run');
  const puzzle = await fetchTodayFromCMT();

  if (DRY) {
    console.log('[DRY RUN] Parsed puzzle from CapitalizeMyTitle:');
    console.log(JSON.stringify(puzzle, null, 2));
    return;
  }

  await updateFiles(puzzle);
  console.log(`[OK] Saved ${puzzle.date} (latest + archive) and updated puzzles/manifest.json`);
}

main().catch(err => { console.error(err); process.exit(1); });

