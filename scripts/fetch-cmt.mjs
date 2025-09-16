// scripts/fetch-cmt.mjs
import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = process.cwd();
const PUZZLES_DIR = path.join(ROOT, 'puzzles');
const todayISO = new Date().toISOString().slice(0, 10);

// Sources (ordered by freshness likelihood)
const MAIN = 'https://capitalizemytitle.com/todays-nyt-connections-answers/';
const AMP  = 'https://capitalizemytitle.com/todays-nyt-connections-answers/amp/';
// Remote fetcher that often bypasses regional CDN caches:
const JINA = (u) => `https://r.jina.ai/http/${u}`;  // e.g. JINA('https://capitalizemytitle.com/…')

// ---------- utils ----------
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function fetchText(url) {
  const u = `${url}?ts=${Date.now()}`; // cache-buster
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

// ---------- parsing (HTML-first, then text fallback) ----------
function sliceFromHeading(html) {
  const re = /<h2[^>]*>\s*Today'?s NYT Connections Puzzle Answer\s*<\/h2>/i;
  const i = html.search(re);
  return i >= 0 ? html.slice(i) : null;
}

// Find first four <span class="answer-text">...</span> blocks after the heading
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

// Parse one answer span into {title, words}
function parseAnswerSpan(innerHtml) {
  if (!innerHtml) return null;
  const html = decodeEntities(innerHtml);
  const ps = [];
  const reP = /<p[^>]*>([\s\S]*?)<\/p>/gi;
  let m;
  while ((m = reP.exec(html))) {
    const txt = m[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    if (txt) ps.push(txt);
  }
  if (!ps.length) return null;
  const rawTitle = ps[0].replace(/:\s*$/, '');
  const title = rawTitle.replace(/[“”"’]+/g, '').trim();
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

function parseFromHtml(html) {
  const section = sliceFromHeading(html);
  if (!section) return null;
  const spans = extractAnswerSpans(section);
  if (!spans) return null;
  const cats = spans.map(parseAnswerSpan).filter(Boolean);
  return (cats.length === 4) ? { date: todayISO, categories: cats } : null;
}

// Text fallback (for r.jina.ai which returns extracted text)
function parseFromText(bigText) {
  const anchor = /today'?s nyt connections puzzle answer/i;
  const idx = bigText.search(anchor);
  const region = idx >= 0 ? bigText.slice(idx) : bigText;
  const lines = region.split(/\r?\n/).map(s => s.replace(/\s+/g,' ').trim()).filter(Boolean);

  const groups = [];
  for (let i = 0; i < lines.length && groups.length < 4; i++) {
    // detect a title line ending with colon and then a comma list
    if (/[:：]\s*$/.test(lines[i]) && /[A-Za-z]/.test(lines[i])) {
      const title = lines[i].replace(/[:：]\s*$/,'').replace(/[“”"’]+/g,'').trim();
      // find next non-empty line with >=4 comma-separated words
      for (let j = i+1; j < Math.min(i+6, lines.length); j++) {
        const words = lines[j].split(',').map(s =>
          s.replace(/[“”"’]+/g,'').replace(/[^A-Za-z'’-]/g,'').toUpperCase().trim()
        ).filter(Boolean);
        if (words.length >= 4) {
          groups.push({ title, words: words.slice(0,4) });
          break;
        }
      }
    }
  }
  return (groups.length === 4) ? { date: todayISO, categories: groups } : null;
}

// ---------- staleness guard ----------
async function loadPrevWordSet() {
  try {
    const raw = await fs.readFile(path.join(PUZZLES_DIR, 'latest.json'), 'utf8');
    const j = JSON.parse(raw);
    return new Set(j.categories?.flatMap(c => c.words) || []);
  } catch {
    return null;
  }
}

function sameWords(a, bSet) {
  if (!a || !bSet) return false;
  const cur = new Set(a.categories.flatMap(c => c.words));
  if (cur.size !== bSet.size) return false;
  for (const w of cur) if (!bSet.has(w)) return false;
  return true;
}

// ---------- main fetch with multi-source + retries ----------
async function fetchPuzzleFresh() {
  const prevSet = await loadPrevWordSet();

  const tries = [
    { name: 'MAIN', url: MAIN, parse: parseFromHtml, isText: false },
    { name: 'AMP',  url: AMP,  parse: parseFromHtml, isText: false },
    { name: 'JINA MAIN', url: JINA(MAIN), parse: parseFromText, isText: true },
    { name: 'JINA AMP',  url: JINA(AMP),  parse: parseFromText, isText: true },
  ];

  // up to 2 passes; second pass waits a bit to let caches refresh
  for (let pass = 0; pass < 2; pass++) {
    for (const t of tries) {
      const body = await fetchText(t.url);
      const puzzle = t.parse(body);
      if (puzzle && !sameWords(puzzle, prevSet)) {
        console.log(`[source] ${t.name}`);
        console.log(`[titles] ${puzzle.categories.map(c => c.title).join(' | ')}`);
        return puzzle;
      }
    }
    // if all sources matched previous, wait a bit and try again
    if (pass === 0) {
      console.log('[info] looked stale; waiting 5s and retrying…');
      await sleep(5000);
    }
  }

  // Last resort: return whatever we parsed first (even if same), so the run doesn't hard-fail
  // Try MAIN once more and return it if parse succeeds.
  const last = parseFromHtml(await fetchText(MAIN)) || parseFromHtml(await fetchText(AMP));
  if (last) {
    console.log('[warn] returning content that matches previous (stale at source)');
    return last;
  }
  throw new Error('Could not parse 4 categories from any source.');
}

// ---------- file writes ----------
async function writeFiles(puzzle) {
  await fs.mkdir(PUZZLES_DIR, { recursive: true });
  await fs.writeFile(path.join(PUZZLES_DIR, `${puzzle.date}.json`), JSON.stringify(puzzle, null, 2));
  await fs.writeFile(path.join(PUZZLES_DIR, `latest.json`), JSON.stringify(puzzle, null, 2));

  // manifest newest first
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

// ---------- CLI ----------
async function main() {
  const DRY = process.argv.includes('--dry-run');
  const puzzle = await fetchPuzzleFresh();

  if (DRY) {
    console.log('[DRY RUN] Parsed puzzle:');
    console.log(JSON.stringify(puzzle, null, 2));
    return;
  }

  await writeFiles(puzzle);
  console.log(`[OK] Saved ${puzzle.date} (latest + archive) and updated puzzles/manifest.json`);
}

main().catch(err => { console.error(err); process.exit(1); });
