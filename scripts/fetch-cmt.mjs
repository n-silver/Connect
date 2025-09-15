// scripts/fetch-cmt.mjs
import fs from 'node:fs/promises';
import path from 'node:path';

const ORIGIN = 'https://capitalizemytitle.com';
const URL = `${ORIGIN}/todays-nyt-connections-answers/`;
const ROOT = process.cwd();
const PUZZLES_DIR = path.join(ROOT, 'puzzles');
const todayUTC = new Date().toISOString().slice(0, 10);

const COLORS = ['Yellow','Green','Blue','Purple'];

// ---------- tiny helpers ----------
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const cleanTitle = (s) => (s || '').replace(/[“”"’]+/g, '').replace(/\s+/g, ' ').trim();
const cleanWord  = (s) =>
  (s || '')
    .replace(/[“”"’]+/g, '')
    .replace(/[^A-Za-z'’-]/g, '')
    .toUpperCase()
    .trim();
const isWord = (s) => /^[A-Z][A-Z'’-]*$/.test(s);

function decodeEntities(t) {
  return (t || '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&ldquo;|&rdquo;|&quot;/g, '"')
    .replace(/&rsquo;|&apos;/g, "'");
}

// Extract the inner HTML of a tag by id (simple and fast for known markup)
function extractInnerById(html, id) {
  const re = new RegExp(
    `<span[^>]*id=["']${id}["'][^>]*>([\\s\\S]*?)<\\/span>`,
    'i'
  );
  const m = re.exec(html);
  return m ? m[1] : null;
}

// From one answer-text span inner HTML, return {title, words}
function parseAnswerSpan(innerHtml) {
  if (!innerHtml) return null;
  const html = decodeEntities(innerHtml);

  // Grab all <p>...</p> blocks inside the span
  const pBlocks = [];
  const reP = /<p[^>]*>([\s\S]*?)<\/p>/gi;
  let m;
  while ((m = reP.exec(html))) {
    const txt = m[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim(); // strip any inline tags
    if (txt) pBlocks.push(txt);
  }
  if (pBlocks.length === 0) return null;

  // First <p> should have the strong title (ends with colon)
  const first = pBlocks[0];
  const mTitle = first.match(/^(.*?):\s*$/) || first.match(/^(.*?):/);
  const rawTitle = mTitle ? mTitle[1] : first;
  const title = cleanTitle(rawTitle);

  // Next non-empty <p> should be the comma list
  let wordsLine = '';
  for (let i = 1; i < pBlocks.length; i++) {
    if (pBlocks[i]) { wordsLine = pBlocks[i]; break; }
  }
  let words = [];
  if (wordsLine) {
    words = wordsLine.split(',').map(s => cleanWord(s)).filter(isWord).slice(0,4);
  }

  // Fallback: if no comma list, try to pick 4 single-word lines from subsequent <p>
  if (words.length !== 4 && pBlocks.length >= 5) {
    const buf = [];
    for (let i = 1; i < pBlocks.length; i++) {
      const w = cleanWord(pBlocks[i]);
      if (isWord(w)) buf.push(w);
      if (buf.length === 4) break;
    }
    if (buf.length === 4) words = buf;
  }

  if (!title || words.length !== 4) return null;
  return { title, words };
}

async function fetchHtmlFresh() {
  const url = `${URL}?ts=${Date.now()}`; // cache-buster
  const res = await fetch(url, {
    headers: {
      'Cache-Control': 'no-cache, no-store',
      'Pragma': 'no-cache',
      'Accept-Language': 'en-GB,en;q=0.9',
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36'
    }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  return await res.text();
}

// Parse exactly the structure you provided
function parseFromExactSection(html) {
  const anchorRe = /<h2[^>]*>\s*Today'?s NYT Connections Puzzle Answer\s*<\/h2>/i;
  const anchor = html.search(anchorRe);
  if (anchor < 0) return null;

  // Extract each known span by id = wordle-index-1-answerN-text (N=1..4)
  const groups = [];
  for (let n = 1; n <= 4; n++) {
    const inner = extractInnerById(html.slice(anchor), `wordle-index-1-answer${n}-text`);
    const parsed = parseAnswerSpan(inner);
    if (!parsed) return null;
    groups.push(parsed);
  }

  // Map to canonical color order: 1=Yellow, 2=Green, 3=Blue, 4=Purple
  return {
    date: todayUTC,
    categories: groups.map(g => ({ title: g.title, words: g.words }))
  };
}

async function fetchPuzzle() {
  let html = await fetchHtmlFresh();
  let puzzle = parseFromExactSection(html);

  // If not found on first try (edge cache), wait briefly and retry once
  if (!puzzle) {
    await sleep(3000);
    html = await fetchHtmlFresh();
    puzzle = parseFromExactSection(html);
  }
  if (!puzzle) throw new Error('Could not parse answers under the specified section.');

  return puzzle;
}

async function writeFiles(puzzle) {
  await fs.mkdir(PUZZLES_DIR, { recursive: true });

  // dated + latest
  await fs.writeFile(path.join(PUZZLES_DIR, `${puzzle.date}.json`), JSON.stringify(puzzle, null, 2));
  await fs.writeFile(path.join(PUZZLES_DIR, `latest.json`), JSON.stringify(puzzle, null, 2));

  // manifest (newest first)
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

async function main() {
  const DRY = process.argv.includes('--dry-run');
  const puzzle = await fetchPuzzle();

  if (DRY) {
    console.log('[DRY RUN] Parsed puzzle:');
    console.log(JSON.stringify(puzzle, null, 2));
    return;
  }

  await writeFiles(puzzle);
  console.log(`[OK] Saved ${puzzle.date} (latest + archive) and updated puzzles/manifest.json`);
}

main().catch(err => { console.error(err); process.exit(1); });
