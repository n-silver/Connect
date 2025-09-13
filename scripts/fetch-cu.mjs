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
const cleanWord  = (s) => (s || '').replace(/[“”"’]+/g, '').replace(/[^A-Za-z'’-]/g,'').trim();
const isWord     = (s) => /^[A-Za-z][A-Za-z'’-]*$/.test(s);

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

    // Search forward (up to ~20 lines) for TITLE: (a line that ends with colon)
    let titleLineIndex = -1;
    for (let j = colorAt; j < Math.min(colorAt + 20, lines.length); j++) {
      const L = lines[j];
      if (/:$/.test(L) && /[A-Za-z]/.test(L)) {
        titleLineIndex = j;
        break;
      }
    }
    if (titleLineIndex < 0) continue;

    const title = cleanTitle(lines[titleLineIndex].replace(/:$/, ''));

    // Next non-empty line should be the comma list
    let words = [];
    for (let k = titleLineIndex + 1; k < Math.min(titleLineIndex + 6, lines.length); k++) {
      const parts = lines[k].split(',').map(s => cleanWord(s)).filter(isWord);
      if (parts.length >= 4) { words = parts.slice(0,4); break; }
    }
    if (words.length !== 4) {
      // Fallback: collect the next 6 lines that look like single words
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
  const page = await browser.newPage({
    viewport: { width: 1280, height: 900 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36'
  });

  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(800);
  await acceptCookies(page).catch(()=>{});
  await slowScroll(page, 12, 200);

  // 1) Try parsing from raw HTML text (works even if collapsed)
  const html1 = await page.content();
  const text1 = htmlToTextPreservingLines(html1);
  let result = parseFromLinearText(text1);

  // 2) If that fails, expand accordions and parse from visible text
  if (!result) {
    await expandAccordions(page);
    await sleep(300);
    const text2 = await page.evaluate(() => document.body.innerText);
    result = parseFromLinearText(text2);
  }

  await browser.close();
  if (!result) throw new Error('Could not parse 4 colour sections with 4 words each.');
  return result;
}

async function updateFiles(puzzle) {
  await fs.mkdir(PUZZLES_DIR, { recursive: true });
  await fs.writeFile(path.join(PUZZLES_DIR, `${puzzle.date}.json`), JSON.stringify(puzzle, null, 2));
  await fs.writeFile(path.join(PUZZLES_DIR, `latest.json`), JSON.stringify(puzzle, null, 2));

  // Update embedded archive in index.html
  const html = await fs.readFile(INDEX, 'utf8');
  const m = html.match(/<script id="conn-data" type="application\/json">\s*([\s\S]*?)\s*<\/script>/);
  const current = m ? (safeJSON(m[1].trim()) || { puzzles: [] }) : { puzzles: [] };
  const puzzles = Array.isArray(current.puzzles) ? current.puzzles : [];
  const merged = uniqBy([{ date: puzzle.date, categories: puzzle.categories }, ...puzzles], p => p.date);
  const payload = JSON.stringify({ puzzles: merged }, null, 2);
  const replacement = `<script id="conn-data" type="application/json">\n${payload}\n</script>`;
  const nextHtml = html.replace(/<script id="conn-data" type="application\/json">[\s\S]*?<\/script>/, replacement);
  await fs.writeFile(INDEX, nextHtml, 'utf8');
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
  console.log(`[OK] Saved ${puzzle.date} (latest + archive) and updated index.html`);
}

main().catch(err => { console.error(err); process.exit(1); });
