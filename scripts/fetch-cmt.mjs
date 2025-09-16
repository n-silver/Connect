// scripts/fetch-cmt.mjs
import fs from 'node:fs/promises';
import path from 'node:path';

/* ---------------- constants ---------------- */
const ROOT = process.cwd();
const PUZZLES_DIR = path.join(ROOT, 'puzzles');

const MAIN = 'https://capitalizemytitle.com/todays-nyt-connections-answers/';
const AMP  = 'https://capitalizemytitle.com/todays-nyt-connections-answers/amp/';
// Jina mirror helper: MUST include scheme
const JINA = (u) => `https://r.jina.ai/http/${u}`;

/* ---------------- utils ---------------- */
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function fetchText(url) {
  const addTs = !url.startsWith('https://r.jina.ai/http/');
  const u = addTs ? `${url}${url.includes('?') ? '&' : '?'}ts=${Date.now()}` : url;
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

/* ---------------- previous snapshot ---------------- */
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

function sameWords(curCats, prevSet) {
  if (!curCats || !prevSet) return false;
  const cur = new Set(curCats.flatMap(c => c.words));
  if (cur.size !== prevSet.size) return false;
  for (const w of cur) if (!prevSet.has(w)) return false;
  return true;
}

/* ---------------- parsing ---------------- */
function sliceFromHeading(html) {
  const re = /<h2[^>]*>\s*Today'?s NYT Connections Puzzle Answer\s*<\/h2>/i;
  const i = html.search(re);
  return i >= 0 ? html.slice(i) : null;
}

// first four .answer-text spans after the heading
function extractAnswerSpans(sectionHtml) {
  if (!sectionHtml) return null;
  const re = /<span[^>]*class=["'][^"']*\banswer-text\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/gi;
  const blocks = [];
  let m;
  while ((m = re.exec(sectionHtml)) && blocks.length < 4) blocks.push(m[1]);
  return blocks.length === 4 ? blocks : null;
}

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
  return (cats.length === 4) ? cats : null;
}

// For r.jina.ai (returns extracted text)
function parseFromText(bigText) {
  const anchor = /today'?s nyt connections puzzle answer/i;
  const idx = bigText.search(anchor);
  const region = idx >= 0 ? bigText.slice(idx) : bigText;
  const lines = region.split(/\r?\n/).map(s => s.replace(/\s+/g,' ').trim()).filter(Boolean);

  const groups = [];
  for (let i = 0; i < lines.length && groups.length < 4; i++) {
    if (/[:：]\s*$/.test(lines[i]) && /[A-Za-z]/.test(lines[i])) {
      const title = lines[i].replace(/[:：]\s*$/,'').replace(/[“”"’]+/g,'').trim();
      for (let j = i+1; j < Math.min(i+6, lines.length); j++) {
        const words = lines[j].split(',').map(s =>
          s.replace(/[“”"’]+/g,'').replace(/[^A-Za-z'’-]/g,'').toUpperCase().trim()
        ).filter(Boolean);
        if (words.length >= 4) { groups.push({ title, words: words.slice(0,4) }); break; }
      }
    }
  }
  return (groups.length === 4) ? groups : null;
}

/* ---------------- date detection ---------------- */
const MONTHS = { january:0,february:1,march:2,april:3,may:4,june:5,july:6,august:7,september:8,october:9,november:10,december:11 };

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

function extractDateFromJsonLd(html) {
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    try {
      const node = JSON.parse(m[1]);
      const arr = Array.isArray(node) ? node : [node];
      for (const obj of arr) {
        if (obj && typeof obj === 'object') {
          const dt = obj.datePublished || obj.dateModified;
          if (typeof dt === 'string') return new Date(dt).toISOString().slice(0,10);
        }
      }
    } catch {}
  }
  return null;
}

function extractDateFromMeta(html) {
  const re = /<meta[^>]+(?:property|name)=["']article:(?:published_time|modified_time)["'][^>]+content=["']([^"']+)["'][^>]*>/i;
  const m = html.match(re);
  return m ? new Date(m[1]).toISOString().slice(0,10) : null;
}

function inferDate({ html, text, prevDate, wordsAreDifferent }) {
  // 1) explicit calendar text
  const fromText = text ? extractDateFromText(text) : null;
  if (fromText) return fromText;

  // 2) structured data/meta timestamps
  const fromJsonLd = html ? extractDateFromJsonLd(html) : null;
  if (fromJsonLd) return fromJsonLd;

  const fromMeta = html ? extractDateFromMeta(html) : null;
  if (fromMeta) return fromMeta;

  // 3) ONLY if words are new, infer prev+1; never for stale content
  if (wordsAreDifferent && prevDate) {
    const d = new Date(prevDate);
    d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString().slice(0,10);
  }

  // 4) last resort: UTC "today" (used only for fresh content w/o any date signal)
  if (wordsAreDifferent) return new Date().toISOString().slice(0,10);

  // If stale, return prevDate (prevents wrong stamping)
  return prevDate || new Date().toISOString().slice(0,10);
}

/* ---------------- fetch orchestration ---------------- */
async function fetchPuzzleFresh() {
  const prev = await loadPrev();

  const tries = [
    { name: 'MAIN',               url: MAIN,                           parser: parseFromHtml, isText: false },
    { name: 'AMP',                url: AMP,                            parser: parseFromHtml, isText: false },
    { name: 'JINA MAIN (https)',  url: JINA(MAIN),                     parser: parseFromText, isText: true  },
    { name: 'JINA AMP (https)',   url: JINA(AMP),                      parser: parseFromText, isText: true  },
    { name: 'JINA MAIN (http)',   url: JINA(MAIN.replace('https://','http://')), parser: parseFromText, isText: true  },
    { name: 'JINA AMP (http)',    url: JINA(AMP.replace('https://','http://')),  parser: parseFromText, isText: true  },
  ];

  // First pass + short retry pass
  for (let pass = 0; pass < 2; pass++) {
    for (const t of tries) {
      try {
        const body = await fetchText(t.url);
        const cats = t.parser(body);
        if (!cats) { console.log(`[skip] ${t.name}: no parse`); continue; }

        const htmlForDate = t.isText ? '' : body;
        const textForDate = t.isText ? body : '';
        const isNew = !sameWords(cats, prev.wordSet);
        const date = inferDate({
          html: htmlForDate,
          text: textForDate,
          prevDate: prev.date,
          wordsAreDifferent: isNew
        });

        if (isNew) {
          const puzzle = { date, categories: cats };
          console.log(`[source] ${t.name}`);
          console.log(`[date]   ${date}`);
          console.log(`[titles] ${puzzle.categories.map(c => c.title).join(' | ')}`);
          return { status: 'fresh', puzzle };
        } else {
          console.log(`[stale] ${t.name} matches previous; trying next…`);
        }
      } catch (e) {
        console.log(`[skip] ${t.name}: ${e.message}`);
      }
    }
    if (pass === 0) {
      console.log('[info] all sources stale; waiting 8s then retrying…');
      await sleep(8000);
    }
  }

  // Nothing new found
  return { status: 'stale', reason: 'All sources matched previous (CDN lag or not updated yet)' };
}

/* ---------------- writes ---------------- */
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

/* ---------------- CLI ---------------- */
async function main() {
  const DRY = process.argv.includes('--dry-run');
  const { status, puzzle, reason } = await fetchPuzzleFresh();

  if (status === 'stale') {
    console.log(`[OK] No new puzzle yet; skipping write. (${reason})`);
    return; // exit 0, lets the commit step say "No changes"
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
