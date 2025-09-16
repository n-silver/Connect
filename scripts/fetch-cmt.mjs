// scripts/fetch-cmt.mjs
import fs from 'node:fs/promises';
import path from 'node:path';

/* ---------- constants ---------- */
const ROOT = process.cwd();
const PUZZLES_DIR = path.join(ROOT, 'puzzles');

const MAIN = 'https://capitalizemytitle.com/todays-nyt-connections-answers/';
const AMP  = 'https://capitalizemytitle.com/todays-nyt-connections-answers/amp/';

/* ---------- utils ---------- */
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function fetchText(url) {
  // cache-buster; AMP is static too but OK
  const u = `${url}${url.includes('?') ? '&' : '?'}ts=${Date.now()}`;
  const res = await fetch(u, {
    headers: {
      'Cache-Control': 'no-cache, no-store, max-age=0',
      'Pragma': 'no-cache',
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'en-GB,en;q=0.9',
      'User-Agent':
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36'
    }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
  return await res.text();
}

function decodeEntities(t = '') {
  return t
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&ldquo;|&rdquo;|&quot;/g, '"')
    .replace(/&rsquo;|&apos;/g, "'");
}

function stripTags(html = '') {
  return decodeEntities(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/* ---------- previous snapshot ---------- */
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

/* ---------- date detection ---------- */
const MONTHS = {
  january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
  july: 6, august: 7, september: 8, october: 9, november: 10, december: 11
};

function mmddyyyyToISO(monthName, dayStr, yearStr) {
  const m = MONTHS[monthName.toLowerCase()];
  const d = parseInt(dayStr, 10);
  const y = parseInt(yearStr, 10);
  if (Number.isNaN(m) || !d || !y) return null;
  return new Date(Date.UTC(y, m, d)).toISOString().slice(0, 10);
}

function extractDateFromText(text) {
  // e.g., "September 16, 2025"
  const re = /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),\s*(\d{4})\b/;
  const m = text.match(re);
  return m ? mmddyyyyToISO(m[1], m[2], m[3]) : null;
}

/* ---------- parsers (section-based) ---------- */

/** find all H2s that say “…Connections Puzzle Answer” or “Answers”, slice to next H2 */
function findAnswerSections(allHtml) {
  // allow Answer or Answers, any extra copy around
  const reH2 = /<h2[^>]*>([\s\S]*?NYT[\s]+Connections[\s]+Puzzle[\s]+Answers?[\s\S]*?)<\/h2>/gi;
  const sections = [];
  const html = allHtml;
  const marks = [];
  let m;
  while ((m = reH2.exec(html))) {
    marks.push({ start: m.index, end: reH2.lastIndex, labelHtml: m[1] });
  }
  for (let i = 0; i < marks.length; i++) {
    const startIdx = marks[i].end;
    const endIdx = (i + 1 < marks.length) ? marks[i + 1].start : html.length;
    sections.push({
      label: stripTags(marks[i].labelHtml).toLowerCase(),
      blockHtml: html.slice(startIdx, endIdx)
    });
  }
  return sections;
}

/** strict extractor: first 4 blocks that carry the answer text */
function extractAnswerBlocks(sectionHtml) {
  // matches <span class="answer-text">…</span> or <div class="answer-text">…</div>
  const re = /<(?:span|div)[^>]*class=["'][^"']*\banswer-text\b[^"']*["'][^>]*>([\s\S]*?)<\/(?:span|div)>/gi;
  const out = [];
  let m;
  while ((m = re.exec(sectionHtml)) && out.length < 4) out.push(m[1]);
  return out.length === 4 ? out : null;
}

function parseAnswerBlock(innerHtml) {
  const html = decodeEntities(innerHtml);
  // collect paragraphs
  const ps = [];
  const reP = /<p[^>]*>([\s\S]*?)<\/p>/gi;
  let m;
  while ((m = reP.exec(html))) {
    const txt = stripTags(m[1]);
    if (txt) ps.push(txt);
  }
  if (!ps.length) return null;

  // title from first <p> (strip trailing colon)
  const title = ps[0].replace(/:\s*$/, '').replace(/[“”"’]+/g, '').trim();

  // words: prefer next paragraph as comma list
  let words = [];
  if (ps[1]) {
    words = ps[1].split(',').map(s =>
      s.replace(/[“”"’]+/g, '').replace(/[^A-Za-z'’-]/g, '').toUpperCase().trim()
    ).filter(Boolean);
  }
  // fallback: collect next 3–4 single-word lines
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

/** loose fallback: <p><strong>Title:</strong></p><p>A, B, C, D</p> pairs anywhere in the section */
function parseFromHtmlLoose(sectionHtml) {
  const section = sectionHtml || '';
  const re = /<p[^>]*>\s*<strong[^>]*>([\s\S]*?)<\/strong>\s*<\/p>\s*<p[^>]*>([\s\S]*?)<\/p>/gi;
  const cats = [];
  let m;
  while ((m = re.exec(section)) && cats.length < 4) {
    const rawTitle = decodeEntities(m[1]).replace(/:\s*$/, '').replace(/[“”"’]+/g, '').trim();
    const wordsLine = decodeEntities(m[2]);
    let words = wordsLine.split(',').map(s =>
      s.replace(/[“”"’]+/g, '').replace(/[^A-Za-z'’-]/g, '').toUpperCase().trim()
    ).filter(Boolean);
    if (rawTitle && words.length >= 4) cats.push({ title: rawTitle, words: words.slice(0, 4) });
  }
  return cats.length === 4 ? cats : null;
}

/** parse a section block into categories + text */
function parseSection(blockHtml) {
  let cats = null;
  const blocks = extractAnswerBlocks(blockHtml);
  if (blocks) {
    const parsed = blocks.map(parseAnswerBlock).filter(Boolean);
    if (parsed.length === 4) cats = parsed;
  }
  if (!cats) {
    const loose = parseFromHtmlLoose(blockHtml);
    if (loose) cats = loose;
  }
  if (!cats) return null;
  return { categories: cats, sectionText: stripTags(blockHtml) };
}

/** choose a section:
 *  1) newest explicit date in section text wins
 *  2) else any section whose words != previous
 *  3) else null (stale)
 */
function chooseBestSection(sections, prevSet) {
  const parsed = [];
  for (const s of sections) {
    const p = parseSection(s.blockHtml);
    if (!p) continue;
    const dateInSection = extractDateFromText(p.sectionText);
    parsed.push({ cats: p.categories, text: p.sectionText, date: dateInSection, label: s.label });
  }
  if (!parsed.length) return null;

  // 1) pick section with the latest date
  const dated = parsed.filter(x => !!x.date)
    .sort((a, b) => (a.date < b.date ? 1 : -1));
  if (dated.length) return dated[0];

  // 2) first that differs from previous words
  const diff = parsed.find(x => !sameWords(x.cats, prevSet));
  if (diff) return diff;

  // 3) stale
  return null;
}

/* ---------- fetch + decide ---------- */
async function fetchPuzzleFresh() {
  const prev = await loadPrev();

  const sources = [
    { name: 'MAIN', url: MAIN },
    { name: 'AMP',  url: AMP  }
  ];

  let best = null;
  let bestSource = null;

  for (let pass = 0; pass < 2 && !best; pass++) {
    for (const s of sources) {
      try {
        const html = await fetchText(s.url);
        const sections = findAnswerSections(html);
        if (!sections.length) { console.log(`[skip] ${s.name}: no sections`); continue; }

        const chosen = chooseBestSection(sections, prev.wordSet);
        if (!chosen) { console.log(`[stale] ${s.name}: all sections match previous`); continue; }

        const isNew = !sameWords(chosen.cats, prev.wordSet);
        const date = chosen.date
          ? chosen.date
          : (isNew
              ? (prev.date
                  ? new Date(new Date(prev.date).getTime() + 86400000).toISOString().slice(0, 10)
                  : new Date().toISOString().slice(0, 10))
              : prev.date || new Date().toISOString().slice(0, 10));

        if (isNew) {
          best = { date, categories: chosen.cats };
          bestSource = s.name;
          break; // fresh found
        }
        // else continue trying other sources/pass
      } catch (e) {
        console.log(`[skip] ${s.name}: ${e.message}`);
      }
    }
    if (!best && pass === 0) {
      console.log('[info] all looked stale; waiting 8s then retrying…');
      await sleep(8000);
    }
  }

  if (!best) return { status: 'stale', reason: 'No differing section found' };

  console.log(`[source] ${bestSource}`);
  console.log(`[date]   ${best.date}`);
  console.log(`[titles] ${best.categories.map(c => c.title).join(' | ')}`);
  return { status: 'fresh', puzzle: best };
}

/* ---------- writes ---------- */
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
    .sort((a, b) => (a < b ? 1 : -1));
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
}

/* ---------- CLI ---------- */
async function main() {
  const DRY = process.argv.includes('--dry-run');
  const { status, puzzle, reason } = await fetchPuzzleFresh();

  if (status === 'stale') {
    console.log(`[OK] No new puzzle yet; skipping write. (${reason})`);
    return; // exit 0
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
