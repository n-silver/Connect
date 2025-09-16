// scripts/fetch-cmt.mjs
import fs from 'node:fs/promises';
import path from 'node:path';

/* ========== CONSTANTS ========== */
const ROOT = process.cwd();
const PUZZLES_DIR = path.join(ROOT, 'puzzles');

const MAIN = 'https://capitalizemytitle.com/todays-nyt-connections-answers/';
const AMP  = 'https://capitalizemytitle.com/todays-nyt-connections-answers/amp/';

/* ========== UTILS ========== */
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function fetchText(url) {
  const u = `${url}${url.includes('?') ? '&' : '?'}ts=${Date.now()}`; // cache-buster
  const res = await fetch(u, {
    headers: {
      'Cache-Control': 'no-cache, no-store, max-age=0',
      'Pragma': 'no-cache',
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'en-GB,en;q=0.9',
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36'
    }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
  return await res.text();
}

function decodeEntities(t='') {
  return t
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&ldquo;|&rdquo;|&quot;/g, '"')
    .replace(/&rsquo;|&apos;/g, "'");
}

function stripTags(html='') {
  return decodeEntities(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/* ========== PREVIOUS SNAPSHOT ========== */
async function loadPrev() {
  try {
    const raw = await fs.readFile(path.join(PUZZLES_DIR, 'latest.json'), 'utf8');
    const j = JSON.parse(raw);
    const words = new Set(j.categories?.flatMap(c => c.words) || []);
    return { date: j.date || null, wordSet: words };
  } catch {
    return { date: null, wordSet: null };
  }
}

function sameWords(cats, prevSet) {
  if (!cats || !prevSet) return false;
  const cur = new Set(cats.flatMap(c => c.words));
  if (cur.size !== prevSet.size) return false;
  for (const w of cur) if (!prevSet.has(w)) return false;
  return true;
}

/* ========== DATE DETECTION ========== */
const MONTHS = {
  january:0,february:1,march:2,april:3,may:4,june:5,
  july:6,august:7,september:8,october:9,november:10,december:11
};

function mmddyyyyToISO(monthName, dayStr, yearStr) {
  const m = MONTHS[monthName.toLowerCase()];
  const d = parseInt(dayStr,10);
  const y = parseInt(yearStr,10);
  if (Number.isNaN(m) || !d || !y) return null;
  return new Date(Date.UTC(y, m, d)).toISOString().slice(0,10);
}

function extractDateFromText(text) {
  const re = /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),\s*(\d{4})\b/;
  const m = text.match(re);
  return m ? mmddyyyyToISO(m[1], m[2], m[3]) : null;
}

/* ========== PARSERS (SECTION-BASED) ========== */

/**
 * Find ALL <h2>…NYT Connections Puzzle Answer…</h2> sections,
 * and slice the HTML for each block up to the next <h2>.
 * Returns an array of { label, blockHtml } in document order.
 */
function findAnswerSections(allHtml) {
  const html = allHtml;
  const reH2 = /<h2[^>]*>([\s\S]*?NYT\s+Connections\s+Puzzle\s+Answer[\s\S]*?)<\/h2>/gi;
  const sections = [];
  let m;

  const indices = [];
  while ((m = reH2.exec(html))) {
    indices.push({ start: m.index, end: reH2.lastIndex, labelHtml: m[1] });
  }
  if (!indices.length) return [];

  // slice each h2..next h2 (or end)
  for (let i = 0; i < indices.length; i++) {
    const startIdx = indices[i].end;
    const endIdx = (i + 1 < indices.length) ? indices[i+1].start : html.length;
    const blockHtml = html.slice(startIdx, endIdx);
    const label = stripTags(indices[i].labelHtml).toLowerCase();
    sections.push({ label, blockHtml });
  }
  return sections;
}

/**
 * Extract the first 4 "answer boxes" inside a section block.
 * Matches both <span class="answer-text"> and <div class="answer-text">.
 * Returns array of inner HTML blocks (length 4) or null.
 */
function extractAnswerBlocks(sectionHtml) {
  const re = /<(?:span|div)[^>]*class=["'][^"']*\banswer-text\b[^"']*["'][^>]*>([\s\S]*?)<\/(?:span|div)>/gi;
  const found = [];
  let m;
  while ((m = re.exec(sectionHtml)) && found.length < 4) {
    found.push(m[1]);
  }
  return found.length === 4 ? found : null;
}

/**
 * Parse one answer block into { title, words }
 * Accepts either:
 *  - <p><strong>TITLE:</strong></p><p>A, B, C, D</p>
 *  - Or 4 words spread on separate lines/paragraphs
 */
function parseAnswerBlock(innerHtml) {
  const html = decodeEntities(innerHtml);
  // collect <p> text
  const ps = [];
  const reP = /<p[^>]*>([\s\S]*?)<\/p>/gi;
  let m;
  while ((m = reP.exec(html))) {
    const txt = stripTags(m[1]);
    if (txt) ps.push(txt);
  }
  if (!ps.length) return null;

  // title is first <p> (strip trailing colon)
  const title = ps[0].replace(/:\s*$/, '').replace(/[“”"’]+/g, '').trim();

  // words: prefer next line as comma-list
  let words = [];
  if (ps[1]) {
    words = ps[1].split(',').map(s =>
      s.replace(/[“”"’]+/g, '').replace(/[^A-Za-z'’-]/g, '').toUpperCase().trim()
    ).filter(Boolean);
  }
  if (words.length !== 4) {
    const buf = [];
    for (let i = 1; i < ps.length && buf.length < 4; i++) {
      const w = ps[i].replace(/[“”"’]+/g, '').replace(/[^A-Za-z'’-]/g, '').toUpperCase().trim();
      if (w) buf.push(w);
    }
    if (buf.length === 4) words = buf;
  }
  return (title && words.length === 4) ? { title, words } : null;
}

/**
 * Parse a whole section into categories (4).
 * Returns { categories, sectionText } or null.
 */
function parseSection(blockHtml) {
  const blocks = extractAnswerBlocks(blockHtml);
  if (!blocks) return null;
  const cats = blocks.map(parseAnswerBlock).filter(Boolean);
  if (cats.length !== 4) return null;
  const sectionText = stripTags(blockHtml);
  return { categories: cats, sectionText };
}

/**
 * Parse the entire page into multiple sections and decide which one to use.
 * Preference order:
 *   1) a section whose H2 label includes "today"
 *   2) otherwise, the first section whose words != prevSet
 *   3) otherwise, return null (stale; don’t write)
 */
function parsePageBySections(allHtml, prevSet) {
  const sections = findAnswerSections(allHtml);
  if (!sections.length) return null;

  // Try "today" labeled section first
  const todayIdx = sections.findIndex(s => /\btoday'?s\b/i.test(s.label));
  const candidates = [];
  if (todayIdx >= 0) candidates.push(sections[todayIdx], ...sections.filter((_,i)=>i!==todayIdx));
  else candidates.push(...sections);

  for (const s of candidates) {
    const parsed = parseSection(s.blockHtml);
    if (!parsed) continue;

    // If label says "today", accept immediately
    if (/\btoday'?s\b/i.test(s.label)) {
      return { categories: parsed.categories, sectionText: parsed.sectionText, label: s.label };
    }

    // Otherwise, prefer the first that differs from previous
    if (!sameWords(parsed.categories, prevSet)) {
      return { categories: parsed.categories, sectionText: parsed.sectionText, label: s.label };
    }
  }

  // Everything parsed equals previous -> treat as stale
  return null;
}

/* ========== DATE PICKING for CHOSEN SECTION ========== */
function inferDateForChosen({ sectionText, pageHtml, prevDate, isNewWords }) {
  // Prefer explicit calendar date found within the chosen section text
  const fromSection = extractDateFromText(sectionText || '');
  if (fromSection) return fromSection;

  // Try whole page (sometimes date sits outside the immediate section)
  const wholeText = stripTags(pageHtml || '');
  const fromWhole = extractDateFromText(wholeText);
  if (fromWhole) return fromWhole;

  // If words are new, infer prev+1; else leave as prev (no writing if stale anyway)
  if (isNewWords && prevDate) {
    const d = new Date(prevDate);
    d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString().slice(0,10);
  }
  if (isNewWords) {
    return new Date().toISOString().slice(0,10);
  }
  return prevDate || new Date().toISOString().slice(0,10);
}

/* ========== FETCH + DECIDE ========== */
async function fetchPuzzleFresh() {
  const prev = await loadPrev();

  const sources = [
    { name: 'MAIN', url: MAIN },
    { name: 'AMP',  url: AMP  },
  ];

  let chosen = null;
  let chosenSource = null;
  let lastHtml = '';

  // Two passes with a small wait to dodge slow template rebuilds
  for (let pass = 0; pass < 2 && !chosen; pass++) {
    for (const s of sources) {
      try {
        const html = await fetchText(s.url);
        lastHtml = html;
        const parsed = parsePageBySections(html, prev.wordSet);
        if (parsed) {
          const isNew = !sameWords(parsed.categories, prev.wordSet);
          const date = inferDateForChosen({
            sectionText: parsed.sectionText,
            pageHtml: html,
            prevDate: prev.date,
            isNewWords: isNew
          });
          chosen = { date, categories: parsed.categories };
          chosenSource = s.name;
          if (isNew) break; // stop early on a fresh set
        } else {
          // parsed == null => stale (all sections equal prev)
          // try next source (or next pass)
        }
      } catch (e) {
        console.log(`[skip] ${s.name}: ${e.message}`);
      }
    }
    if (!chosen) {
      console.log('[info] no differing section found; waiting 8s then retrying…');
      await sleep(8000);
    }
  }

  if (!chosen) {
    return { status: 'stale', reason: 'All parsed sections matched previous or no sections found' };
  }

  const isNew = !sameWords(chosen.categories, prev.wordSet);
  if (!isNew) {
    return { status: 'stale', reason: 'Chosen section still equals previous (stale at source)' };
  }

  console.log(`[source] ${chosenSource}`);
  console.log(`[date]   ${chosen.date}`);
  console.log(`[titles] ${chosen.categories.map(c => c.title).join(' | ')}`);
  return { status: 'fresh', puzzle: chosen };
}

/* ========== WRITES ========== */
async function writeFiles(puzzle) {
  await fs.mkdir(PUZZLES_DIR, { recursive: true });
  await fs.writeFile(path.join(PUZZLES_DIR, `${puzzle.date}.json`), JSON.stringify(puzzle, null, 2));
  await fs.writeFile(path.join(PUZZLES_DIR, `latest.json`), JSON.stringify(puzzle, null, 2));

  const manifestPath = path.join(PUZZLES_DIR, 'manifest.json');
  let manifest = [];
  try {
    const raw = await fs.readFile(manifestPath, 'utf8');
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) manifest = arr;
  } catch {}
  manifest = [puzzle.date, ...manifest.filter(d => d !== puzzle.date)]
    .sort((a,b) => (a < b ? 1 : -1));
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
}

/* ========== CLI ========== */
async function main() {
  const DRY = process.argv.includes('--dry-run');
  const { status, puzzle, reason } = await fetchPuzzleFresh();

  if (status === 'stale') {
    console.log(`[OK] No new puzzle yet; skipping write. (${reason})`);
    return; // exit 0 (allows commit step to say "No changes")
  }

  if (DRY) {
    console.log('[DRY RUN] Parsed puzzle:');
    console.log(JSON.stringify(puzzle, null, 2));
    return;
  }

  await writeFiles(puzzle);
  console.log(`[OK] Saved ${puzzle.date} (latest + archive) and updated puzzles/manifest.json`);
}

main().catch(err => { console.error(err); process.exit(1); });
