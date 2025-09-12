// scripts/scrape-nyt-connections.mjs
import { chromium } from "playwright";

const URL = "https://www.nytimes.com/games/connections";
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const CONTROL_PATTERNS = [
  /submit/i, /shuffle/i, /deselect/i, /undo/i, /hint/i, /help/i, /how to/i,
  /back to puzzle/i, /play/i, /continue/i, /accept/i, /agree/i, /settings?/i,
  /menu/i, /share/i, /login/i, /sign/i, /give up/i, /reveal/i, /new/i, /archive/i
];

function tokenish(s) {
  return !!s && !/\s/.test(s) && s.length >= 1 && s.length <= 30 && /[A-Za-z]/.test(s);
}

async function clickFirstButtonWithTextInAllFrames(page, regexes, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const frames = page.frames();
    for (const fr of frames) {
      const els = await fr.$$('button, [role="button"], a[role="button"], a');
      for (const el of els) {
        const txt = ((await el.innerText().catch(()=>'')) || '').trim();
        if (!txt) continue;
        if (regexes.some(re => re.test(txt))) {
          await el.click({ force: true }).catch(()=>{});
          return true;
        }
      }
    }
    await sleep(250);
  }
  return false;
}

async function collectTileHandlesInFrame(frame) {
  // Return element handles for visible, word-like tiles (exclude controls)
  const handles = await frame.$$('button, [role="button"]');
  const tiles = [];
  for (const h of handles) {
    const box = await h.boundingBox().catch(()=>null);
    if (!box || box.width < 48 || box.height < 38) continue; // skip tiny ui
    const text = ((await h.innerText().catch(()=>'')) || '').trim();
    if (!text) continue;
    if (CONTROL_PATTERNS.some(re => re.test(text))) continue;
    // Tiles tend to be one token; loosen if needed, but this avoids nav
    if (!tokenish(text)) continue;
    tiles.push({ handle: h, text });
  }
  // Dedup by text; keep first instance
  const seen = new Set();
  const out = [];
  for (const t of tiles) {
    if (seen.has(t.text)) continue;
    seen.add(t.text);
    out.push(t);
  }
  return out;
}

async function findGameFrameWithTiles(page, minTiles = 12, totalWaitMs = 20000) {
  const deadline = Date.now() + totalWaitMs;
  while (Date.now() < deadline) {
    const frames = page.frames();
    for (const fr of frames) {
      try {
        const tiles = await collectTileHandlesInFrame(fr);
        if (tiles.length >= minTiles) {
          console.log(`[INFO] Found ${tiles.length} tile-like buttons in a frame: ${fr.url()}`);
          return { frame: fr, tiles };
        }
      } catch {}
    }
    await sleep(500);
  }
  return null;
}

async function submitSelectionInFrame(frame) {
  // Prefer exact "Submit", but try aria-label as well
  const btns = await frame.$$('button, [role="button"]');
  for (const b of btns) {
    const t = ((await b.innerText().catch(()=>'')) || '').trim();
    if (/^submit$/i.test(t)) {
      await b.click({ force: true }).catch(()=>{});
      await sleep(800);
      return true;
    }
  }
  const alt = await frame.$('button[aria-label*="Submit" i], [role="button"][aria-label*="Submit" i]');
  if (alt) {
    await alt.click({ force: true }).catch(()=>{});
    await sleep(800);
    return true;
  }
  // As a last resort, try from all frames
  const ok = await clickFirstButtonWithTextInAllFrames(frame.page(), [/^submit$/i], 3000);
  await sleep(800);
  return ok;
}

async function backToPuzzle(page) {
  await clickFirstButtonWithTextInAllFrames(page, [/^back to puzzle$/i, /^back$/i], 8000).catch(()=>{});
}

async function scrapeSummaryFromAllFrames(page) {
  // Return array of 4 groups: { title, words }
  const frames = page.frames();
  for (const fr of frames) {
    const groups = await fr.evaluate(() => {
      const isVisible = (el) => {
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
      };
      const all = Array.from(document.querySelectorAll('*')).filter(isVisible);
      const tokenish = (s) => !!s && !/\s/.test(s) && s.length >= 1 && s.length <= 30 && /[A-Za-z]/.test(s);
      const notTokenish = (s) => !!s && (/\s/.test(s) || s.length > 30) && /[A-Za-z]/.test(s);

      const groups = [];
      for (const el of all) {
        const texts = Array.from(el.querySelectorAll('*'))
          .map(n => (n.textContent || '').trim())
          .filter(Boolean);

        const words = [];
        for (const t of texts) if (tokenish(t) && !words.includes(t)) words.push(t);
        if (words.length !== 4) continue;

        let title = '';
        for (const t of texts) {
          if (notTokenish(t) && t.length <= 80) { title = t.replace(/\s+/g,' ').trim(); break; }
        }
        if (!title) continue;

        const r = el.getBoundingClientRect();
        const area = r.width * r.height;
        if (area < 10000) continue;

        groups.push({ title, words, area });
      }
      // Dedup by word signature, prefer tighter containers
      const bySig = new Map();
      for (const g of groups) {
        const sig = g.words.slice().sort().join('|');
        if (!bySig.has(sig) || g.area < bySig.get(sig).area) bySig.set(sig, g);
      }
      const uniq = Array.from(bySig.values()).sort((a,b) => a.area - b.area);
      // keep top 4
      return uniq.slice(0,4).map(g => ({ title: g.title, words: g.words }));
    }).catch(()=>[]);
    if (groups && groups.length === 4 && groups.every(g => Array.isArray(g.words) && g.words.length === 4)) {
      console.log(`[INFO] Summary found in frame: ${fr.url()}`);
      return groups;
    }
  }
  return [];
}

async function run() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 1360, height: 900 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
  });

  console.log('[STEP] goto');
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(1000);

  console.log('[STEP] accept cookies (if present)');
  await clickFirstButtonWithTextInAllFrames(page, [/^accept all$/i, /^agree$/i, /^accept$/i], 12000);

  console.log('[STEP] click Play (or Continue)');
  await clickFirstButtonWithTextInAllFrames(page, [/^play$/i, /^continue$/i], 15000);

  console.log('[STEP] find game frame + tiles');
  const found = await findGameFrameWithTiles(page, 12, 25000);
  if (!found) throw new Error('Could not find tile buttons in any frame.');
  const game = found.frame;

  // Refresh handles each round (DOM can re-render)
  const rounds = [
    (tiles) => tiles.slice(0, 4).map(t => t.handle),
    (tiles) => [tiles[0].handle, tiles[1].handle, tiles[2].handle, tiles[4].handle],
    (tiles) => [tiles[0].handle, tiles[1].handle, tiles[4].handle, tiles[5].handle],
    (tiles) => [tiles[0].handle, tiles[4].handle, tiles[5].handle, tiles[6].handle],
  ];

  for (let r = 0; r < 4; r++) {
    // If the game already ended early (e.g., we accidentally guessed right), continue anyway
    const tiles = await collectTileHandlesInFrame(game);
    if (tiles.length < 7) console.warn(`[WARN] only ${tiles.length} tiles detected this round`);

    const pick = rounds[r](tiles);
    console.log(`[STEP] round ${r+1} click ${pick.length} tiles`);
    for (const h of pick) { await h.click({ force: true }).catch(()=>{}); await sleep(120); }

    console.log('[STEP] submit');
    await submitSelectionInFrame(game);
    await sleep(800);
  }

  console.log('[STEP] wait 5s');
  await sleep(5000);

  console.log('[STEP] back to puzzle (if shown)');
  await backToPuzzle(page);

  console.log('[STEP] scrape summary');
  const groups = await scrapeSummaryFromAllFrames(page);
  if (!groups.length) throw new Error('Failed to scrape summary groups.');
  const out = { date: new Date().toISOString().slice(0,10), groups };
  console.log(JSON.stringify(out, null, 2));

  await browser.close();
}

run().catch(async (err) => {
  console.error('[ERROR]', err);
  process.exit(1);
});
