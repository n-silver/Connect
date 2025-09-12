// scripts/scrape-nyt-connections.mjs
import { chromium } from "playwright";

const URL = "https://www.nytimes.com/games/connections";
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const CONTROL_PATTERNS = [
  /submit/i, /shuffle/i, /deselect/i, /undo/i, /hint/i, /help/i, /how to/i,
  /back to puzzle/i, /play/i, /continue/i, /accept/i, /agree/i, /settings?/i,
  /menu/i, /share/i, /login/i, /sign/i, /give up/i, /reveal/i, /new/i, /archive/i
];

const tokenish = (s) => !!s && !/\s/.test(s) && s.length >= 1 && s.length <= 30 && /[A-Za-z]/.test(s);
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

async function clickFirstButtonWithTextInAllFrames(page, regexes, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const fr of page.frames()) {
      const els = await fr.$$('button, [role="button"], a[role="button"], a').catch(()=>[]);
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

async function collectTileTextsInFrame(fr) {
  return await fr.$$eval('button, [role="button"]', (els, CONTROL_PATTERNS) => {
    const isVisible = (el) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
    };
    const controls = CONTROL_PATTERNS.map(s => new RegExp(s.slice(1, -2), 'i'));
    const out = [];
    for (const el of els) {
      if (!isVisible(el)) continue;
      const text = (el.textContent || '').trim();
      if (!text) continue;
      if (controls.some(re => re.test(text))) continue;
      if (!/^[A-Za-z][A-Za-z'’-]*$/.test(text)) continue; // single word-ish
      const r = el.getBoundingClientRect();
      if (r.width < 48 || r.height < 38) continue;
      if (!out.includes(text)) out.push(text);
      if (out.length === 16) break;
    }
    return out;
  }, CONTROL_PATTERNS.map(r => r.toString()));
}

async function findGameFrame(page, minTiles = 12, totalWaitMs = 25000) {
  const deadline = Date.now() + totalWaitMs;
  while (Date.now() < deadline) {
    for (const fr of page.frames()) {
      try {
        const words = await collectTileTextsInFrame(fr);
        if (words.length >= minTiles) return { frame: fr, words };
      } catch { /* frame may detach; ignore and retry */ }
    }
    await sleep(400);
  }
  return null;
}

async function clickTileByExactText(fr, word) {
  // use role locator each time (no stale handles)
  const loc = fr.getByRole('button', { name: new RegExp(`^${escapeRe(word)}$`, 'i') }).first();
  try {
    await loc.click({ timeout: 2000 });
    return true;
  } catch {
    // fallback: manual scan
    const btns = await fr.$$('button, [role="button"]').catch(()=>[]);
    for (const b of btns) {
      const t = ((await b.innerText().catch(()=>'')) || '').trim();
      if (t.toLowerCase() === word.toLowerCase()) {
        await b.click({ force: true }).catch(()=>{});
        return true;
      }
    }
    return false;
  }
}

async function submitInFrame(fr, page) {
  try {
    const ok = await fr.getByRole('button', { name: /^submit$/i }).first().click({ timeout: 2000 }).then(()=>true).catch(()=>false);
    if (ok) return true;
  } catch {}
  // Try aria-label
  const alt = await fr.$('button[aria-label*="Submit" i], [role="button"][aria-label*="Submit" i]').catch(()=>null);
  if (alt) { await alt.click({ force: true }).catch(()=>{}); return true; }
  // Try any frame
  return await clickFirstButtonWithTextInAllFrames(page, [/^submit$/i], 3000);
}

async function backToPuzzle(page) {
  await clickFirstButtonWithTextInAllFrames(page, [/^back to puzzle$/i, /^back$/i], 8000).catch(()=>{});
}

async function scrapeSummaryFromAllFrames(page) {
  for (const fr of page.frames()) {
    try {
      const groups = await fr.evaluate(() => {
        const isVisible = (el) => {
          const r = el.getBoundingClientRect();
          const s = getComputedStyle(el);
          return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
        };
        const tokenish = (s) => !!s && !/\s/.test(s) && s.length >= 1 && s.length <= 30 && /[A-Za-z]/.test(s);
        const notTokenish = (s) => !!s && (/\s/.test(s) || s.length > 30) && /[A-Za-z]/.test(s);

        const all = Array.from(document.querySelectorAll('*')).filter(isVisible);
        const groups = [];
        for (const el of all) {
          const texts = Array.from(el.querySelectorAll('*')).map(n => (n.textContent || '').trim()).filter(Boolean);
          const words = [];
          for (const t of texts) if (tokenish(t) && !words.includes(t)) words.push(t);
          if (words.length !== 4) continue;

          let title = '';
          for (const t of texts) {
            if (notTokenish(t) && t.length <= 80) { title = t.replace(/\s+/g, ' ').trim(); break; }
          }
          if (!title) continue;

          const r = el.getBoundingClientRect();
          const area = r.width * r.height;
          if (area < 10000) continue;

          groups.push({ title, words, area });
        }
        // dedupe by words, prefer tightest containers
        const map = new Map();
        for (const g of groups) {
          const sig = g.words.slice().sort().join('|');
          if (!map.has(sig) || g.area < map.get(sig).area) map.set(sig, g);
        }
        return Array.from(map.values()).sort((a,b)=>a.area-b.area).slice(0,4).map(g=>({title:g.title, words:g.words}));
      });
      if (groups?.length === 4 && groups.every(g => g.words?.length === 4)) return groups;
    } catch { /* frame may detach; try next */ }
  }
  return [];
}

async function run() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });

  // 1) Open & accept cookies
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(1000);
  await clickFirstButtonWithTextInAllFrames(page, [/^accept all$/i, /^agree$/i, /^accept$/i], 15000);

  // 2) Click Play (or Continue)
  await clickFirstButtonWithTextInAllFrames(page, [/^play$/i, /^continue$/i], 20000);

  // 3) Find game frame (don’t keep it forever; re-find each time)
  let found = await findGameFrame(page, 12, 30000);
  if (!found) throw new Error('No game frame with tiles found.');
  let words = found.words;

  // Ensure 16 max
  if (words.length > 16) words = words.slice(0, 16);

  // Build four picks with at least one new tile each round
  if (words.length < 7) throw new Error('Not enough tiles detected to vary picks.');
  const picks = [
    words.slice(0,4),
    [words[0], words[1], words[2], words[4]],
    [words[0], words[1], words[4], words[5]],
    [words[0], words[4], words[5], words[6]],
  ];

  for (let r = 0; r < 4; r++) {
    // re-find the frame before each round (handles frame detach/re-render)
    found = await findGameFrame(page, 7, 10000);
    if (!found) throw new Error('Lost the game frame before a round.');
    const fr = found.frame;

    for (const w of picks[r]) {
      // retry once if frame detaches mid-click
      const ok = await clickTileByExactText(fr, w).catch(()=>false);
      if (!ok) {
        const refound = await findGameFrame(page, 7, 8000);
        if (!refound) continue;
        await clickTileByExactText(refound.frame, w).catch(()=>{});
      }
      await sleep(120);
    }

    // submit with retry if frame changed
    let submitted = await submitInFrame(fr, page);
    if (!submitted) {
      const refound = await findGameFrame(page, 7, 8000);
      if (refound) submitted = await submitInFrame(refound.frame, page);
    }
    await sleep(1000);
  }

  // 4) Wait, back to puzzle, scrape summary
  await sleep(5000);
  await backToPuzzle(page);
  const groups = await scrapeSummaryFromAllFrames(page);
  if (!groups.length) throw new Error('Failed to scrape summary groups.');

  console.log(JSON.stringify({ date: new Date().toISOString().slice(0,10), groups }, null, 2));
  await browser.close();
}

run().catch(err => { console.error(err); process.exit(1); });
