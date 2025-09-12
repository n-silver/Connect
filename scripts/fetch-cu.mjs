// scripts/scrape-nyt-connections.mjs
import { chromium } from "playwright";

const URL = "https://www.nytimes.com/games/connections";

// --- small helpers ---
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function clickFirstButtonWithText(page, patterns, opts = {}) {
  // patterns: array of regexps to match button text (case-insensitive)
  const timeout = opts.timeout ?? 5000;
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    // search in main page
    const buttons = await page.$$('button, [role="button"], a[role="button"], a');
    for (const b of buttons) {
      const t = ((await b.innerText().catch(()=>'')) || '').trim();
      for (const re of patterns) {
        if (re.test(t)) {
          await b.click({ force: true }).catch(()=>{});
          return true;
        }
      }
    }
    // search in iframes (cookie banners often live in frames)
    for (const frame of page.frames()) {
      const fbuttons = await frame.$$('button, [role="button"], a[role="button"], a');
      for (const b of fbuttons) {
        const t = ((await b.innerText().catch(()=>'')) || '').trim();
        for (const re of patterns) {
          if (re.test(t)) {
            await b.click({ force: true }).catch(()=>{});
            return true;
          }
        }
      }
    }
    await sleep(250);
  }
  return false;
}

async function getVisibleTileButtons(page) {
  // Find the 16 tile buttons by visibility and “word-like” text, excluding controls.
  return await page.$$eval('button, [role="button"]', (els) => {
    const isVisible = (el) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
    };

    const CONTROL_PATTERNS = [
      /submit/i, /shuffle/i, /deselect/i, /undo/i, /hint/i, /help/i, /how to/i,
      /back to puzzle/i, /play/i, /continue/i, /accept/i, /agree/i, /settings?/i,
      /menu/i, /share/i, /login/i, /sign/i, /give up/i, /reveal/i, /new/i, /archive/i
    ];

    const tokens = [];
    for (const el of els) {
      if (!isVisible(el)) continue;
      const text = (el.textContent || '').trim();
      if (!text) continue;
      if (CONTROL_PATTERNS.some(re => re.test(text))) continue;
      // Connections tiles are usually single tokens (no spaces)
      if (/\s/.test(text)) continue;
      if (text.length < 1 || text.length > 20) continue;
      // Avoid lone punctuation
      if (/^[?.…/\\]+$/.test(text)) continue;
      const r = el.getBoundingClientRect();
      // Avoid tiny icons
      if (r.width < 48 || r.height < 38) continue;
      tokens.push({ text, bbox: r });
    }

    // Dedup by text, keep up to 16
    const seen = new Set();
    const result = [];
    for (const t of tokens) {
      if (seen.has(t.text)) continue;
      seen.add(t.text);
      result.push(t.text);
      if (result.length === 16) break;
    }
    return result;
  });
}

async function clickTileByText(page, word) {
  // Click the first visible button matching the word exactly
  const candidates = await page.$$('button, [role="button"]');
  for (const el of candidates) {
    const t = ((await el.innerText().catch(()=>'')) || '').trim();
    if (t === word) {
      const box = await el.boundingBox().catch(()=>null);
      if (box && box.width >= 1 && box.height >= 1) {
        await el.click({ force: true }).catch(()=>{});
        return true;
      }
    }
  }
  return false;
}

async function submitSelection(page) {
  // Try to click a “Submit” button
  const ok = await clickFirstButtonWithText(page, [/^submit$/i], { timeout: 4000 });
  if (!ok) {
    // Some UIs replace button text with an icon; try role=button with aria-label
    const btn = await page.$('button[aria-label*="Submit" i], [role="button"][aria-label*="Submit" i]');
    if (btn) await btn.click({ force: true }).catch(()=>{});
  }
  // brief pause for animations
  await sleep(800);
}

async function scrapeSummary(page) {
  // After finishing/losing & hitting “Back to Puzzle”, the four groups are shown.
  // Heuristic: find containers that contain exactly 4 distinct word-like tokens,
  // and a short title (non-token) above them.
  return await page.evaluate(() => {
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

      // candidate words: token-like strings (single words)
      const words = [];
      for (const t of texts) if (tokenish(t) && !words.includes(t)) words.push(t);
      if (words.length !== 4) continue;

      // title: first non-tokenish, reasonably short text in the same container
      let title = '';
      for (const t of texts) {
        if (notTokenish(t) && t.length <= 60) { title = t.replace(/\s+/g, ' ').trim(); break; }
      }
      if (!title) continue;

      // bounding box heuristic: ignore tiny or huge containers
      const r = el.getBoundingClientRect();
      const area = r.width * r.height;
      if (area < 10_000) continue;

      groups.push({ title, words, area });
    }

    // Dedup by word signature, keep smallest area (tightest group containers)
    const bySig = new Map();
    for (const g of groups) {
      const sig = g.words.slice().sort().join('|');
      if (!bySig.has(sig) || g.area < bySig.get(sig).area) bySig.set(sig, g);
    }
    const uniq = Array.from(bySig.values());

    // If more than 4 candidates, pick the 4 with smallest area (usually the four groups)
    uniq.sort((a, b) => a.area - b.area);
    const chosen = uniq.slice(0, 4).map(g => ({ title: g.title, words: g.words }));

    return chosen;
  });
}

async function run() {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  // 1) Open page
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(1000);

  // 2) Accept cookies (banner + possible iframe)
  await clickFirstButtonWithText(page, [/^accept all$/i, /^agree$/i, /^accept$/i], { timeout: 8000 }).catch(()=>{});

  // 3) Click Play (start game)
  const played = await clickFirstButtonWithText(page, [/^play$/i, /^continue$/i], { timeout: 12000 });
  if (!played) {
    // Sometimes the game is already visible for returning visitors
    // carry on if we can see tiles
  }

  // 4) Wait for tiles to be visible & collect their texts
  let words = [];
  for (let i = 0; i < 20; i++) {
    words = await getVisibleTileButtons(page).catch(()=>[]);
    if (words.length >= 12) break;
    await sleep(500);
  }
  if (words.length < 12) throw new Error(`Could not find enough tiles (found ${words.length}).`);
  // Ensure we have up to 16
  if (words.length > 16) words = words.slice(0, 16);

  // 5) Make 4 submissions: first 4, then change 1 tile each time to ensure at least one unique tile
  const picks = [];
  // Make sure we have at least 7 tiles to rotate (we should)
  const needed = 7;
  if (words.length < needed) throw new Error("Not enough tiles to vary picks.");

  picks.push(words.slice(0, 4));
  picks.push([...words.slice(0, 3), words[4]]);
  picks.push([...words.slice(0, 2), words[4], words[5]]);
  picks.push([words[0], words[4], words[5], words[6]]);

  for (const group of picks) {
    // click the 4 words
    for (const w of group) {
      await clickTileByText(page, w);
      await sleep(120);
    }
    await submitSelection(page);
    await sleep(500);
  }

  // 6) Wait a bit (animations, result view)
  await sleep(5000);

  // 7) Back to Puzzle (if present)
  await clickFirstButtonWithText(page, [/^back to puzzle$/i, /^back$/i], { timeout: 5000 }).catch(()=>{});

  // 8) Scrape the four revealed categories + words
  const summary = await scrapeSummary(page);
  console.log(JSON.stringify({ date: new Date().toISOString().slice(0,10), groups: summary }, null, 2));

  await browser.close();
}

run().catch(async (err) => {
  console.error(err);
  process.exit(1);
});
