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

// --- replace your old "extractInnerById" and parseFromExactSection with this ---

function sliceFromHeading(html) {
  const anchorRe = /<h2[^>]*>\s*Today'?s NYT Connections Puzzle Answer\s*<\/h2>/i;
  const i = html.search(anchorRe);
  return i >= 0 ? html.slice(i) : null;
}

// pull the first 4 answer-text spans under the heading, regardless of id/index
function extractAnswerSpans(sectionHtml) {
  if (!sectionHtml) return null;
  const re = /<span[^>]*class=["'][^"']*\banswer-text\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/gi;
  const blocks = [];
  let m;
  while ((m = re.exec(sectionHtml)) && blocks.length < 4) {
    blocks.push(m[1]);
  }
  return blocks.length === 4 ? blocks : null;
}

function parseAnswerSpan(innerHtml) {
  if (!innerHtml) return null;
  const html = innerHtml
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&ldquo;|&rdquo;|&quot;/g, '"')
    .replace(/&rsquo;|&apos;/g, "'");

  // pull <p> blocks
  const ps = [];
  const reP = /<p[^>]*>([\s\S]*?)<\/p>/gi;
  let m;
  while ((m = reP.exec(html))) {
    const txt = m[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    if (txt) ps.push(txt);
  }
  if (!ps.length) return null;

  // first <p> is the title (strip trailing colon)
  const rawTitle = ps[0].replace(/:\s*$/, '');
  const title = rawTitle.replace(/[“”"’]+/g, '').trim();

  // next line: comma list of 4 words (fallback: 4 one-per-line)
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

function parseFromExactSection(html, todayISO) {
  const section = sliceFromHeading(html);
  if (!section) return null;

  const spans = extractAnswerSpans(section);
  if (!spans) return null;

  const cats = spans.map(parseAnswerSpan).filter(Boolean);
  if (cats.length !== 4) return null;

  return { date: todayISO, categories: cats };
}

// --- enhance fetchPuzzle to try main page, then /amp, and do a stale check ---

async function fetchHtmlFresh(url) {
  const res = await fetch(`${url}?ts=${Date.now()}`, {
    headers: {
      'Cache-Control': 'no-cache, no-store, max-age=0',
      'Pragma': 'no-cache',
      'Accept-Language': 'en-GB,en;q=0.9',
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36'
    }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  return await res.text();
}

async function readLatestWordsIfAny(fs, path, puzzlesDir) {
  try {
    const raw = await fs.readFile(path.join(puzzlesDir, 'latest.json'), 'utf8');
    const j = JSON.parse(raw);
    const set = new Set(j.categories?.flatMap(c => c.words) || []);
    return set;
  } catch { return null; }
}

async function fetchPuzzle() {
  const todayISO = new Date().toISOString().slice(0,10);
  const MAIN = 'https://capitalizemytitle.com/todays-nyt-connections-answers/';
  const AMP  = 'https://capitalizemytitle.com/todays-nyt-connections-answers/amp/';

  // 1) try main
  let html = await fetchHtmlFresh(MAIN);
  let puzzle = parseFromExactSection(html, todayISO);

  // 2) stale check vs latest.json; if identical words, try AMP
  const prevSet = await readLatestWordsIfAny(fs, path, PUZZLES_DIR);
  const sameAsPrev = () => {
    if (!puzzle || !prevSet) return false;
    const cur = new Set(puzzle.categories.flatMap(c => c.words));
    if (cur.size !== prevSet.size) return false;
    for (const w of cur) if (!prevSet.has(w)) return false;
    return true;
  };

  if (!puzzle || sameAsPrev()) {
    // try AMP (often fresher, no JS)
    const ampHtml = await fetchHtmlFresh(AMP);
    const ampPuzzle = parseFromExactSection(ampHtml, todayISO);
    if (ampPuzzle && (!puzzle || sameAsPrev())) {
      puzzle = ampPuzzle;
    }
  }

  // 3) last resort: wait and refetch main once more
  if (!puzzle || sameAsPrev()) {
    await new Promise(r => setTimeout(r, 3000));
    html = await fetchHtmlFresh(MAIN);
    const retry = parseFromExactSection(html, todayISO);
    if (retry) puzzle = retry;
  }

  if (!puzzle) throw new Error('Could not parse 4 categories from page.');
  return puzzle;
}
