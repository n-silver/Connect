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
