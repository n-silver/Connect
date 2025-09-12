// Replace your existing parseCMT(...) with this DOM-first version.
async function parseCMT(page) {
  // Accept cookie banner if it appears
  await Promise.race([
    page.click('text=/^(Accept|I Agree|Agree|OK)$/i', { timeout: 3000 }).catch(() => {}),
    new Promise(r => setTimeout(r, 500))
  ]);

  return await page.evaluate(() => {
    // Helpers inside the page context
    const colors = ['Yellow','Green','Blue','Purple'];
    const getText = el => (el?.textContent || '').replace(/\s+/g, ' ').trim();
    const cleanTitle = s => (s || '').replace(/[“”"’]+/g, '').replace(/\s+/g, ' ').trim();
    const cleanWord  = s => (s || '').replace(/[“”"’]+/g, '').replace(/[^A-Za-z'’-]/g,'').trim();
    const isWord     = s => /^[A-Za-z][A-Za-z'’-]*$/.test(s);

    // All potentially relevant nodes in document order
    const nodes = Array.from(document.querySelectorAll('h1,h2,h3,h4,strong,b,p,li,div,section,article'));

    function nextWordsBlock(startEl) {
      // Scan a few forward siblings looking for UL/OL or a comma list
      let cur = startEl;
      for (let i = 0; i < 6; i++) {
        cur = cur?.nextElementSibling || null;
        if (!cur) break;

        // List form: <ul><li>…</li>×4</ul>
        const lis = Array.from(cur.querySelectorAll('li')).map(n => cleanWord(getText(n))).filter(isWord);
        if (lis.length >= 4) return lis.slice(0, 4);

        // Paragraph form: "W1, W2, W3, W4"
        const t = getText(cur);
        const comma = t.split(',').map(s => cleanWord(s)).filter(isWord);
        if (comma.length >= 4) return comma.slice(0, 4);
      }
      return [];
    }

    const groups = [];
    for (const color of colors) {
      // Find a heading-ish node that mentions the color and looks like an "Answer/Category/Group" header
      const header =
        nodes.find(el => {
          const t = getText(el).toLowerCase();
          return t.includes(color.toLowerCase()) &&
                 (t.includes('answer') || t.includes('category') || t.includes('group') || /[:–—-]/.test(t));
        }) ||
        nodes.find(el => new RegExp(`^${color}\\b`, 'i').test(getText(el)));

      if (!header) continue;

      // Try to pull the title from the same line (after colon/dash), else we’ll leave it blank
      const hText = getText(header);
      const mSame = hText.match(new RegExp(
        `${color}\\s*(?:answer|category|group)?\\s*[:–—-]\\s*([^:–—-]{2,100})`, 'i'
      ));
      let title = cleanTitle(mSame ? mSame[1] : '');

      // Now read the 4 words from the next list/paragraph block
      const words = nextWordsBlock(header);
      if (words.length === 4) groups.push({ color, title, words });
    }

    if (groups.length !== 4) return null;
    // Normalize output (title cleaning already applied)
    return {
      date: new Date().toISOString().slice(0,10),
      categories: groups.map(g => ({ title: g.title, words: g.words }))
    };
  });
}
