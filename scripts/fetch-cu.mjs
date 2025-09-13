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

const cleanTitle = (s) => (s || '').replace(/[“”"’]+/g, '').replace(/\s+/g, ' ').trim();
const cleanWord  = (s) => (s || '').replace(/[“”"’]+/g, '').replace(/[^A-Za-z'’-]/g,'').trim();
const isWord     = (s) => /^[A-Za-z][A-Za-z'’-]*$/.test(s);

async function acceptCookies(page) {
  // Click common consent buttons (top page or iframes)
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

async function expandColorAccordions(page) {
  // Scroll to the "Today's ..." heading, then click any toggles containing the color names
  const head = page.getByRole('heading', { name: /today'?s nyt connections puzzle answer/i }).first();
  try { await head.scrollIntoViewIfNeeded(); } catch {}

  const colors = ['Yellow', 'Green', 'Blue', 'Purple'];

  // Try several common toggle selectors right under that heading section
  for (const color of colors) {
    // Limit search to nodes following the heading to avoid clicking unrelated items
    const toggle = page.locator(
      `xpath=(//h1|//h2|//h3|//h4)[contains(translate(normalize-space(.),"abcdefghijklmnopqrstuvwxyz","ABCDEFGHIJKLMNOPQRSTUVWXYZ"),"TODAY'S NYT CONNECTIONS PUZZLE ANSWER")][1]/following::*[
        self::button or @role="button" or self::summary or contains(@class,'accordion') or contains(@class,'toggle') or contains(@class,'spoiler') or contains(@class,'elementor-tab')
      ][contains(translate(normalize-space(.),"abcdefghijklmnopqrstuvwxyz","ABCDEFGHIJKLMNOPQRSTUVWXYZ"), "${color.toUpperCase()}")][1]`
    ).first();

    await toggle.click({ timeout: 2000 }).catch(()=>{});
    await sleep(200);
  }

  // Safety: also click any “Show/Reveal Answer” toggles under the section
  const expanders = page.locator(
    `xpath=(//h1|//h2|//h3|//h4)[contains(translate(normalize-space(.),"abcdefghijklmnopqrstuvwxyz","ABCDEFGHIJKLMNOPQRSTUVWXYZ"),"TODAY'S NYT CONNECTIONS PUZZLE ANSWER")][1]/following::*[
      self::button or @role="button" or self::summary
    ][contains(translate(normalize-space(.),"abcdefghijklmnopqrstuvwxyz","ABCDEFGHIJKLMNOPQRSTUVWXYZ"), "ANSWER")]`
  );
  const n = await expanders.count().catch(()=>0);
  for (let i = 0; i < n; i++) {
    await expanders.nth(i).click({ timeout: 1000 }).catch(()=>{});
    await sleep(120);
  }
}

async function parseOpenedSections(page) {
  // Read the four color sections (opened) just below the "Today's ..." heading.
  return await page.evaluate(() => {
    const colors = ['Yellow','Green','Blue','Purple'];

    const getText = el => (el?.textContent || '').replace(/\s+/g, ' ').trim();
    const cleanTitle = s => (s || '').replace(/[“”"’]+/g, '').replace(/\s+/g, ' ').trim();
    const cleanWord  = s => (s || '').replace(/[“”"’]+/g, '').replace(/[^A-Za-z'’-]/g,'').trim();
    const isWord     = s => /^[A-Za-z][A-Za-z'’-]*$/.test(s);

    const isVisible = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
    };

    // Find the "Today's NYT Connections Puzzle Answer" heading
    const headings = Array.from(document.querySelectorAll('h1,h2,h3,h4'));
    const anchor = headings.find(h => /today'?s nyt connections puzzle answer/i.test(getText(h)));
    if (!anchor) return null;

    // Collect a window of siblings after the anchor to limit our search area
    const after = [];
    let node = anchor.nextElementSibling;
    for (let i = 0; node && i < 120; i++, node = node.nextElementSibling) after.push(node);

    // Find the first element (in our window) that mentions this color (likely the accordion header),
    // then find its nearest visible content block that follows it.
    function findOpenedContentForColor(color) {
      const colorHeader =
        after.find(el => el && /button|summary|h\d|div|p/i.test(el.tagName) &&
          new RegExp(color, 'i').test(getText(el))) || null;
      if (!colorHeader) return null;

      // Common accordion pattern: header followed by a content block sibling
      // Walk forward a few siblings to find a visible, texty block
      let cur = colorHeader.nextElementSibling;
      for (let i = 0; cur && i < 8; i++, cur = cur.nextElementSibling) {
        if (!isVisible(cur)) continue;
        const t = getText(cur);
        if (t && t.length > 0) return cur;
      }

      // Fallback: if header has aria-controls, try that
      const id = colorHeader.getAttribute?.('aria-controls');
      if (id) {
        const pane = document.getElementById(id);
        if (pane && isVisible(pane)) return pane;
      }
      return null;
    }

    function extractTitleAndWordsFromContent(contentEl) {
      // Strategy:
      //  1) Split the content into lines (blockish) and trim empties
      //  2) Find a line that ends with ":" (the TITLE:)
      //  3) Take the next non-empty line; expect "W1, W2, W3, W4"
      //  4) If not present, fall back to UL/OL list with 4 <li>
      const lines = [];
      // Prefer child blocks first to keep line order sensible
      const blocks = Array.from(contentEl.querySelectorAll('p,li,div,span,strong,b,em,h5,h6,section,article'));
      if (blocks.length) {
        for (const b of blocks) {
          const t = getText(b);
          if (t) lines.push(t);
        }
      } else {
        // Fallback to innerText split
        contentEl.innerText.split('\n').forEach(s => {
          const t = (s || '').replace(/\s+/g,' ').trim();
          if (t) lines.push(t);
        });
      }

      // 1) TITLE: on its own line (usually uppercase + colon)
      let title = '';
      let words = [];

      for (let i = 0; i < lines.length; i++) {
        const L = lines[i];

        // Match “SOMETHING LIKE THIS:” (allow mixed case too)
        if (/:$/.test(L)) {
          // strip trailing colon for title
          title = cleanTitle(L.replace(/:$/, ''));
          // find the next non-empty line
          let j = i + 1;
          while (j < lines.length && !lines[j]) j++;
          if (j < lines.length) {
            // Expect a comma list
            const parts = lines[j].split(',').map(s => cleanWord(s)).filter(isWord);
            if (parts.length >= 4) {
              words = parts.slice(0,4);
              break;
            }
          }
        }
      }

      // 2) Fallback: UL/OL list directly inside contentEl
      if (!words.length) {
        const items = Array.from(contentEl.querySelectorAll('li')).map(n => cleanWord(getText(n))).filter(isWord);
        if (items.length >= 4) {
          words = items.slice(0,4);
        }
      }

      if (!title && words.length) {
        // Try to infer a nearby label if no explicit TITLE: line found
        const label = getText(contentEl).match(/[A-Z][A-Z '’\-]{3,}:/);
        if (label) title = cleanTitle(label[0].replace(/:$/, ''));
      }

      return { title, words };
    }

    const groups = [];
    for (const color of colors) {
      const content = findOpenedContentForColor(color);
      if (!content) continue;

      const { title, words } = extractTitleAndWordsFromContent(content);
      if (title && words.length === 4) {
        groups.push({ color, title, words });
      }
    }

    if (groups.length !== 4) return null;

    // Normalize into final shape
    return {
      date: new Date().toISOString().slice(0,10),
      categories: groups
        // keep official NYT color order
        .sort((a,b) => ['Yellow','Green','Blue','Purple'].indexOf(a.color) - ['Yellow','Green','Blue','Purple'].indexOf(b.color))
        .map(g => ({ title: g.title, words: g.words }))
    };
  });
}

async function fetchTodayFromCMT() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 1280, height: 900 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36'
  });

  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(1200);

  await acceptCookies(page).catch(()=>{});
  await expandColorAccordions(page);
  await sleep(300);

  const result = await parseOpenedSections(page);
  await browser.close();

  if (!result) throw new Error('Could not parse 4 opened color sections with 4 words each.');
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
