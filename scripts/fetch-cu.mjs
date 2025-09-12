// scripts/scrape-nyt-connections.mjs
import { chromium } from "playwright";

const URL = "https://www.nytimes.com/games/connections";
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** Heuristic: is this the { categories:[ {title, words:[4]}, x4 ] } we want? */
function extractCategoriesShape(obj) {
  if (!obj || typeof obj !== 'object') return null;
  // Look in common places
  const candidates = [];
  const visit = (v) => {
    if (!v || typeof v !== 'object') return;
    if (Array.isArray(v)) { v.forEach(visit); return; }
    if (v.categories && Array.isArray(v.categories) && v.categories.length === 4) {
      const ok = v.categories.every(c =>
        c && typeof c.title === 'string' &&
        Array.isArray(c.words) && c.words.length === 4 &&
        c.words.every(w => typeof w === 'string')
      );
      if (ok) candidates.push(v.categories);
    }
    for (const k of Object.keys(v)) visit(v[k]);
  };
  visit(obj);
  if (candidates.length) return candidates[0];
  return null;
}

async function clickAny(page, regexes, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const frames = page.frames();
    for (const fr of frames) {
      const els = await fr.$$('button, [role="button"], a[role="button"], a').catch(()=>[]);
      for (const el of els) {
        const txt = ((await el.innerText().catch(()=>'')) || '').trim();
        if (!txt) continue;
        if (regexes.some(re => re.test(txt))) {
          await el.click({ force: true }).catch(()=>{});
          await sleep(400);
          return true;
        }
      }
    }
    await sleep(250);
  }
  return false;
}

async function run() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 1360, height: 900 }
  });

  // 1) Capture ANY JSON from the start
  let foundCats = null;
  page.on('response', async (resp) => {
    try {
      const ct = (resp.headers()['content-type'] || '').toLowerCase();
      if (!ct.includes('json')) return;
      const json = await resp.json().catch(()=>null);
      if (!json) return;
      const cats = extractCategoriesShape(json);
      if (cats && !foundCats) {
        foundCats = cats;
        // We keep listening, but first match wins
      }
    } catch {}
  });

  // 2) Go to page
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(1000);

  // 3) Accept cookies (banner often lives in an iframe)
  await clickAny(page, [/^accept all$/i, /^agree$/i, /^accept$/i], 15000).catch(()=>{});

  // 4) Play (or Continue)
  await clickAny(page, [/^play$/i, /^continue$/i], 20000).catch(()=>{});

  // 5) Give the app some time to fetch puzzle JSON
  for (let i = 0; i < 40 && !foundCats; i++) {
    await sleep(500);
  }

  // 6) If we didn’t see it on the wire, try storage
  if (!foundCats) {
    const stor = await page.evaluate(() => {
      const dump = (s) => {
        const out = {};
        for (let i = 0; i < s.length; i++) {
          const k = s.key(i);
          out[k] = s.getItem(k);
        }
        return out;
      };
      return { ls: dump(localStorage), ss: dump(sessionStorage) };
    });
    const blobs = [...Object.values(stor.ls || {}), ...Object.values(stor.ss || {})];
    for (const v of blobs) {
      try {
        const obj = JSON.parse(v);
        const cats = extractCategoriesShape(obj);
        if (cats) { foundCats = cats; break; }
      } catch {}
    }
  }

  // 7) If still nothing, try to click any “Show answers / Reveal / Give up” (may be A/B)
  if (!foundCats) {
    await clickAny(page, [/^give up$/i, /^reveal/i, /answers?/i], 8000).catch(()=>{});
    await sleep(2000);
    // sometimes going “back to puzzle” exposes summary containers too
    await clickAny(page, [/^back to puzzle$/i, /^back$/i], 6000).catch(()=>{});
    await sleep(1000);
    // Check storage again
    const stor2 = await page.evaluate(() => {
      const dump = (s) => {
        const out = {};
        for (let i = 0; i < s.length; i++) {
          const k = s.key(i);
          out[k] = s.getItem(k);
        }
        return out;
      };
      return { ls: dump(localStorage), ss: dump(sessionStorage) };
    });
    const blobs2 = [...Object.values(stor2.ls || {}), ...Object.values(stor2.ss || {})];
    for (const v of blobs2) {
      try {
        const obj = JSON.parse(v);
        const cats = extractCategoriesShape(obj);
        if (cats) { foundCats = cats; break; }
      } catch {}
    }
  }

  if (!foundCats) {
    throw new Error('Could not capture categories from network or storage.');
  }

  // 8) Output in your preferred format
  const out = {
    date: new Date().toISOString().slice(0,10),
    groups: foundCats.map(c => ({ title: c.title, words: c.words }))
  };
  console.log(JSON.stringify(out, null, 2));

  await browser.close();
}

run().catch(err => { console.error(err); process.exit(1); });
