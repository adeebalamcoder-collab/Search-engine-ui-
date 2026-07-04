  // ══════════════════════════ STATE & DOM REFS ══════════════════════════
  const inp = document.getElementById('q');
  const xBtn = document.getElementById('xBtn');
  const sugBox = document.getElementById('sugBox');
  const resultsContainer = document.getElementById('resultsContainer');
  const kgContainer = document.getElementById('kgContainer');
  const resultStats = document.getElementById('resultStats');
  const pagerEl = document.getElementById('pager');
  const imagesContainer = document.getElementById('imagesContainer');
  const imgGrid = document.getElementById('imgGrid');
  const imgLoader = document.getElementById('imgLoader');
  const endFootEl = document.querySelector('.end-foot');
  const endBrandEl = document.querySelector('.end-brand');
  const sideImagesEl = document.getElementById('sideImages');
  let active = -1, tmr;
  const PAGE_SIZE = 10;
  const MAX_IMAGES = 300;
  let currentQuery = '';
  let currentPage = 1;
  let activeTab = 'web';

  // ── images tab state ──
  let imgLoading = false, imgDone = false, imgTotalLoaded = 0, imgFirstLoad = true, imagesLoadedForQuery = null;
  let imgSeenUrls = new Set();
  let imgCombos = [], imgComboIdx = 0;

  // Serper's "page" param on /images doesn't reliably deepen results the way
  // web search does — a single call tends to return whatever Google's cache
  // has for that query/region. To get real additional unique images we cycle
  // through different regions (gl) and pages, since Google Images genuinely
  // returns different sets per region — not duplicated content.
  function buildImgCombos() {
    const regions = [
      { gl: 'us', hl: 'en' }, { gl: 'in', hl: 'en' }, { gl: 'gb', hl: 'en' },
      { gl: 'ca', hl: 'en' }, { gl: 'au', hl: 'en' }, { gl: 'de', hl: 'de' },
      { gl: 'fr', hl: 'fr' }, { gl: 'jp', hl: 'ja' }, { gl: 'br', hl: 'pt' },
      { gl: 'it', hl: 'it' }, { gl: 'es', hl: 'es' }, { gl: 'nl', hl: 'nl' }
    ];
    const combos = [];
    for (let page = 1; page <= 3; page++) {
      regions.forEach(r => combos.push({ page, gl: r.gl, hl: r.hl }));
    }
    return combos;
  }

  // ══════════════════════════ TAB SWITCHING (web / images) ══════════════════════════
  document.querySelectorAll('.nav-tab').forEach(tab => {
    tab.addEventListener('click', e => {
      e.preventDefault();
      document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('on'));
      tab.classList.add('on');
      switchTab(tab.dataset.tab);
    });
  });

  // tapping the arrow tile at the end of the images rail jumps to the Images tab —
  // reuses the exact same nav-tab click handler above, nothing duplicated
  if (sideImagesEl) {
    sideImagesEl.addEventListener('click', e => {
      const moreBtn = e.target.closest('.side-img-more');
      if (!moreBtn) return;
      e.preventDefault();
      const imagesTab = document.querySelector('.nav-tab[data-tab="images"]');
      if (imagesTab) imagesTab.click();
    });
  }

  function switchTab(tab) {
    activeTab = tab;
    document.body.classList.toggle('tab-images', tab === 'images');
    if (tab === 'images') {
      [resultStats, kgContainer, resultsContainer, pagerEl, sideImagesEl].forEach(el => el && (el.style.display = 'none'));
      if (endFootEl) endFootEl.style.display = 'none';
      if (endBrandEl) endBrandEl.style.display = 'none';
      imagesContainer.style.display = 'block';
      if (imagesLoadedForQuery !== currentQuery) {
        resetImages();
        renderImgSkeleton();
        loadMoreImages();
      }
    } else {
      imagesContainer.style.display = 'none';
      [resultStats, kgContainer, resultsContainer, pagerEl].forEach(el => el && (el.style.display = ''));
      if (sideImagesEl) sideImagesEl.style.display = '';
      if (endFootEl) endFootEl.style.display = '';
      if (endBrandEl) endBrandEl.style.display = '';
    }
  }

  // ══════════════════════════ IMAGES TAB — masonry, infinite scroll ══════════════════════════
  function resetImages() {
    imgLoading = false; imgDone = false; imgTotalLoaded = 0; imgFirstLoad = true;
    imgSeenUrls = new Set();
    imgCombos = buildImgCombos();
    imgComboIdx = 0;
    imgGrid.innerHTML = '';
    const oldMsg = document.getElementById('imgEndMsg');
    if (oldMsg) oldMsg.remove();
  }

  function renderImgSkeleton() {
    const heights = [170, 230, 145, 200, 255, 165, 215, 185, 150, 225, 190, 160];
    imgGrid.innerHTML = heights.map(h => `<div class="img-skel" style="height:${h}px"></div>`).join('');
  }

  function appendImages(images) {
    const frag = document.createDocumentFragment();
    images.forEach((img, idx) => {
      // use the small thumbnail for the grid (fast, Google-style) — the full-res
      // image only ever loads if the person clicks through to the source
      const gridSrc = img.thumbnailUrl || img.imageUrl;
      if (!gridSrc) return;
      const a = document.createElement('a');
      a.className = 'img-item';
      a.href = img.link || img.imageUrl;
      a.target = '_blank';
      a.rel = 'noopener';
      // reserve the exact box size up-front using Serper's reported dimensions
      // so nothing shifts once the image actually loads (no "earthquake")
      const w = img.thumbnailWidth || img.imageWidth, h = img.thumbnailHeight || img.imageHeight;
      if (w && h) a.style.aspectRatio = w + ' / ' + h;
      else a.style.aspectRatio = '1 / 1';
      const im = document.createElement('img');
      im.loading = 'lazy';
      im.decoding = 'async';
      im.setAttribute('fetchpriority', (imgTotalLoaded + idx) < 8 ? 'high' : 'low');
      im.alt = img.title || '';
      im.referrerPolicy = 'no-referrer';
      // if the image fails to load (dead link / hotlink-blocked), remove the
      // whole card cleanly instead of showing a broken-image icon + alt text
      im.onerror = () => { a.remove(); checkFillViewport(); };
      im.src = gridSrc;
      a.appendChild(im);
      frag.appendChild(a);
    });
    imgGrid.appendChild(frag);
  }

  // if too many images in a batch failed and the page/grid is left short,
  // immediately pull another batch instead of waiting for the user to scroll
  let backfillTimer = null;
  function checkFillViewport() {
    if (imgLoading || imgDone) return;
    clearTimeout(backfillTimer);
    backfillTimer = setTimeout(() => {
      if (activeTab === 'images' && document.body.scrollHeight <= window.innerHeight + 400) {
        loadMoreImages();
      }
    }, 100);
  }

  async function loadMoreImages() {
    if (imgLoading || imgDone) return;
    if (imgComboIdx >= imgCombos.length) { imgDone = true; showImgEndMessage(); return; }
    imgLoading = true;
    imgLoader.classList.add('show');
    const combo = imgCombos[imgComboIdx];
    try {
      const res = await fetch('/api/images', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ q: currentQuery, page: combo.page, gl: combo.gl, hl: combo.hl, num: 100 })
      });
      const data = await res.json();
      let imgs = (data.images || []).filter(i => i.imageUrl);
      // drop anything we've already shown (regions/pages can overlap)
      imgs = imgs.filter(i => !imgSeenUrls.has(i.imageUrl));
      if (imgFirstLoad) { imgGrid.innerHTML = ''; imgFirstLoad = false; }
      imgComboIdx++;
      if (imgs.length) {
        const remaining = MAX_IMAGES - imgTotalLoaded;
        const batch = imgs.slice(0, remaining);
        batch.forEach(i => imgSeenUrls.add(i.imageUrl));
        appendImages(batch);
        imgTotalLoaded += batch.length;
        if (imgTotalLoaded >= MAX_IMAGES) { imgDone = true; showImgEndMessage(); }
      }
      if (imgComboIdx >= imgCombos.length && !imgDone) { imgDone = true; showImgEndMessage(); }
      checkFillViewport();
    } catch (e) {
      if (imgFirstLoad) { imgGrid.innerHTML = ''; imgFirstLoad = false; }
      imgComboIdx++;
      if (imgComboIdx >= imgCombos.length) { imgDone = true; showImgEndMessage(); }
    } finally {
      imgLoading = false;
      imgLoader.classList.remove('show');
      imagesLoadedForQuery = currentQuery;
    }
  }

  function showImgEndMessage() {
    if (document.getElementById('imgEndMsg')) return;
    const msg = document.createElement('div');
    msg.id = 'imgEndMsg';
    msg.className = 'img-end-msg';
    msg.textContent = imgTotalLoaded > 0 ? `That's all the images we found (${imgTotalLoaded})` : 'No images found';
    imagesContainer.appendChild(msg);
  }

  const imgObserver = new IntersectionObserver(entries => {
    entries.forEach(entry => { if (entry.isIntersecting) loadMoreImages(); });
  }, { rootMargin: '1400px 0px' });
  imgObserver.observe(document.getElementById('imgSentinel'));

  // ══════════════════════════ BOOTSTRAP FROM URL ══════════════════════════
  (function initFromQuery() {
    const params = new URLSearchParams(window.location.search);
    const q = params.get('q');
    const p = parseInt(params.get('page'), 10) || 1;
    if (q) {
      inp.value = q;
      document.title = q + ' — Atkyn Search';
      if (xBtn) xBtn.classList.add('show');
      runSearch(q, p);
    } else {
      resultsContainer.innerHTML = '';
    }
  })();

  // ══════════════════════════ WEB SEARCH + KNOWLEDGE PANEL ══════════════════════════
  // Search proxy — goes through /api/search (Cloudflare Pages Function).
  // Key stays server-side in the SERPER_API_KEY environment variable, never in this file. ──
  async function searxSearch(q, page) {
    const res = await fetch('/api/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ q, page, num: 10 })
    });
    if (!res.ok) throw new Error('search failed');
    const data = await res.json();
    const hits = data.organic || [];
    const results = hits.slice(0, PAGE_SIZE).map(h => ({
      title: h.title || h.link,
      snippet: h.snippet || '',
      url: h.link,
      thumb: (h.imageUrl) || (data.images && data.images[0] && data.images[0].imageUrl) || null
    }));
    return { results, totalhits: results.length ? 1000000 : 0, knowledgeGraph: data.knowledgeGraph || null };
  }

  // ── Wikipedia extract — used to fatten the knowledge-panel summary ──
  async function getWikiExtract(title) {
    try {
      const url = `https://en.wikipedia.org/w/api.php?action=query&prop=extracts&exintro=1&explaintext=1&exchars=380&redirects=1&titles=${encodeURIComponent(title)}&format=json&origin=*`;
      const res = await fetch(url);
      const data = await res.json();
      const pages = (data.query && data.query.pages) || {};
      const page = Object.values(pages)[0];
      return page && page.extract ? page.extract : null;
    } catch (e) { return null; }
  }

  // ── Better-quality image for the knowledge panel via /api/images (Serper image search proxy) ──
  async function getBetterImage(title) {
    try {
      const res = await fetch('/api/images', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ q: title, page: 1 })
      });
      if (!res.ok) return null;
      const data = await res.json();
      const imgs = data.images || [];
      return imgs.length ? (imgs[0].imageUrl || null) : null;
    } catch (e) { return null; }
  }

  // ── Desktop-only swipeable images rail (reuses the same /api/images proxy) ──
  async function loadSideImages(q) {
    if (!sideImagesEl) return;
    try {
      const res = await fetch('/api/images', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ q, page: 1, num: 12 })
      });
      if (!res.ok) { sideImagesEl.innerHTML = ''; return; }
      const data = await res.json();
      const imgs = (data.images || []).filter(i => i.imageUrl).slice(0, 12);
      if (!imgs.length) { sideImagesEl.innerHTML = ''; return; }
      sideImagesEl.innerHTML = `
        <div class="side-images-head">Images</div>
        <div class="side-images-track">
          ${imgs.map(i => {
            const src = i.thumbnailUrl || i.imageUrl;
            const href = i.link || i.imageUrl;
            const alt = (i.title || '').replace(/"/g, '&quot;');
            const w = i.imageWidth || i.thumbnailWidth;
            const h = i.imageHeight || i.thumbnailHeight;
            const ratio = (w && h) ? ` style="aspect-ratio:${w}/${h}"` : '';
            return `<a class="side-img-item" href="${href}" target="_blank" rel="noopener"${ratio}>
              <img src="${src}" alt="${alt}" loading="lazy" decoding="async" referrerpolicy="no-referrer">
            </a>`;
          }).join('')}
          <a href="#" class="side-img-item side-img-more" aria-label="See all images">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" width="22" height="22"><polyline points="9 18 15 12 9 6"/></svg>
          </a>
        </div>`;
    } catch (e) {
      sideImagesEl.innerHTML = '';
    }
  }

  async function runSearch(q, page) {
    currentQuery = q;
    currentPage = page || 1;
    imagesLoadedForQuery = null;
    renderSkeleton();
    resultStats.textContent = '';
    pagerEl.innerHTML = '';
    kgContainer.innerHTML = '';
    if (sideImagesEl) sideImagesEl.innerHTML = '';
    try {
      const { results, totalhits, knowledgeGraph } = await searxSearch(q, currentPage);
      if (knowledgeGraph) await renderKnowledgePanel(knowledgeGraph);
      if (!results.length) { renderNoResults(q); return; }
      renderStats(totalhits);
      renderCards(results);
      renderPager(currentPage, totalhits);
      loadSideImages(q); // not awaited — runs in background, never blocks or breaks web-tab logic
    } catch (err) {
      renderNoResults(q, true);
    }
  }

  async function renderKnowledgePanel(kg) {
    if (!kg || !kg.title) { kgContainer.innerHTML = ''; return; }

    let domain = '', sourceUrl = kg.descriptionLink || kg.website || '';
    try { domain = sourceUrl ? new URL(sourceUrl).hostname.replace(/^www\./, '') : ''; } catch (e) {}

    let desc = kg.description || '';
    let imageUrl = kg.imageUrl || null;
    const [wikiExtract, betterImage] = await Promise.all([
      getWikiExtract(kg.title),
      getBetterImage(kg.title)
    ]);
    if (wikiExtract && wikiExtract.length > desc.length) desc = wikiExtract;
    if (betterImage) imageUrl = betterImage;

    const imageHtml = imageUrl
      ? `<img class="kg-image" src="${imageUrl}" alt="" referrerpolicy="no-referrer">`
      : '';

    let attrsHtml = '';
    if (kg.attributes) {
      attrsHtml = Object.entries(kg.attributes).map(([label, value]) =>
        `<div class="kg-attr-row"><span class="kg-attr-label">${label}:</span><span class="kg-attr-value">${value}</span></div>`
      ).join('');
    }

    kgContainer.innerHTML = `
      <div class="kg-card">
        <div class="kg-top">
          <div>
            <div class="kg-title">${kg.title}</div>
            ${kg.type ? `<div class="kg-type">${kg.type}</div>` : ''}
          </div>
          <div class="kg-image-box">${imageHtml}</div>
        </div>
        ${desc ? `<div class="kg-desc">${desc}</div>` : ''}
        ${domain ? `
        <a class="kg-source" href="${sourceUrl}" target="_blank" rel="noopener">
          <span class="kg-source-fav" style="background-image:url('https://www.google.com/s2/favicons?domain=${domain}&sz=64')"></span>
          <span class="kg-source-text">${domain}</span>
        </a>` : ''}
        ${attrsHtml ? `<div class="kg-attrs">${attrsHtml}</div>` : ''}
      </div>`;
  }

  function renderSkeleton() {
    let html = '';
    for (let i = 0; i < 4; i++) {
      html += `
      <div class="skel-card">
        <div class="skel-row">
          <div class="skel-dot"></div>
          <div class="skel-line skel-host"></div>
        </div>
        <div class="skel-line skel-title"></div>
        <div class="skel-line skel-snip"></div>
        <div class="skel-line skel-snip short"></div>
      </div>`;
    }
    resultsContainer.innerHTML = html;
  }

  function renderStats(totalhits) {
    if (!totalhits) { resultStats.textContent = ''; return; }
    resultStats.textContent = `About ${totalhits.toLocaleString('en-US')} results`;
  }

  function renderCards(results) {
    resultsContainer.innerHTML = results.map(r => {
      let domain = '', pathBreadcrumb = '', displayName = '';
      try {
        const u = new URL(r.url);
        domain = u.hostname.replace(/^www\./, '');
        displayName = domain.split('.')[0];
        displayName = displayName.charAt(0).toUpperCase() + displayName.slice(1);
        const segs = u.pathname.split('/').filter(Boolean);
        pathBreadcrumb = segs.length ? `${domain} › ${segs.join(' › ')}` : domain;
      } catch (e) {
        domain = r.url || '';
        displayName = domain;
        pathBreadcrumb = domain;
      }
      const thumbHtml = r.thumb
        ? `<img class="r-thumb" src="${r.thumb}" alt="" loading="lazy" referrerpolicy="no-referrer">`
        : '';
      return `
      <div class="card">
        <div class="card-body">
          <div class="card-content">
            <div class="r-host">
              <div class="r-fav" style="background-image:url('https://www.google.com/s2/favicons?domain=${domain}&sz=64')"></div>
              <div class="r-host-text">
                <span class="r-domain">${displayName}</span>
                <span class="r-path">${pathBreadcrumb}</span>
              </div>
              <button class="r-dots">
                <svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>
              </button>
            </div>
            <a href="${r.url}" target="_blank" rel="noopener" class="r-title">${r.title}</a>
            <a href="${r.url}" target="_blank" rel="noopener" class="r-snip">${r.snippet || 'No preview available.'}</a>
          </div>
          ${thumbHtml}
        </div>
      </div>`;
    }).join('');
  }

  function renderNoResults(q, isError) {
    resultsContainer.innerHTML = `
    <div class="no-results">
      <div class="no-results__icon">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" width="40" height="40"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
      </div>
      <div class="no-results__title">${isError ? "Couldn't reach search" : `No results for "${q}"`}</div>
      <div class="no-results__sub">${isError ? 'Check your connection and try again.' : 'Try different or more general keywords.'}</div>
    </div>`;
    resultStats.textContent = '';
  }

  function renderPager(page, totalhits) {
    const totalPages = Math.max(1, Math.ceil(totalhits / PAGE_SIZE));
    const maxPage = Math.min(totalPages, 20);
    const windowStart = Math.max(1, Math.min(page - 2, maxPage - 4));
    const windowEnd = Math.min(maxPage, windowStart + 4);
    let html = '';
    html += `<button class="pg" ${page <= 1 ? 'disabled' : ''} data-page="${page - 1}">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" width="18" height="18"><polyline points="15 18 9 12 15 6"/></svg>
    </button>`;
    for (let i = windowStart; i <= windowEnd; i++) {
      html += `<button class="pg ${i === page ? 'on' : ''}" data-page="${i}">${i}</button>`;
    }
    html += `<button class="pg" ${page >= maxPage ? 'disabled' : ''} data-page="${page + 1}">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" width="18" height="18"><polyline points="9 18 15 12 9 6"/></svg>
    </button>`;
    pagerEl.innerHTML = html;
    pagerEl.querySelectorAll('.pg:not([disabled])').forEach(btn => {
      btn.addEventListener('click', () => {
        const p = parseInt(btn.dataset.page, 10);
        if (!p || p === page) return;
        const params = new URLSearchParams(window.location.search);
        params.set('q', currentQuery);
        params.set('page', p);
        window.history.pushState({}, '', 'search.html?' + params.toString());
        runSearch(currentQuery, p);
        window.scrollTo({ top: 0, behavior: 'smooth' });
      });
    });
  }

  // ══════════════════════════ SEARCH-BAR SUGGESTIONS DROPDOWN ══════════════════════════
  inp.addEventListener('input', function () {
    const q = this.value.trim();
    xBtn.classList.toggle('show', q.length > 0);
    clearTimeout(tmr);
    if (!q) { hide(); return; }
    tmr = setTimeout(async () => render(await fetchSug(q)), 180);
  });

  xBtn.addEventListener('click', () => { inp.value = ''; xBtn.classList.remove('show'); hide(); inp.focus(); });

  inp.addEventListener('keydown', e => {
    const rows = sugBox.querySelectorAll('.sug-row');
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      active = Math.min(active + 1, rows.length - 1);
      hi(rows);
      if (rows[active]) inp.value = rows[active].dataset.v;
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      active = Math.max(active - 1, -1);
      hi(rows);
    } else if (e.key === 'Enter') {
      hide();
      const q = inp.value.trim();
      if (q) window.location.href = 'search.html?q=' + encodeURIComponent(q);
    } else if (e.key === 'Escape') {
      hide();
    }
  });

  document.addEventListener('click', e => { if (!e.target.closest('.pill-wrap')) hide(); });

  function hi(r) { r.forEach((x, i) => x.classList.toggle('hl', i === active)); }
  function hide() { sugBox.classList.remove('show'); active = -1; }
  function show() { sugBox.classList.add('show'); }

  function fetchSug(q) {
    return new Promise(res => {
      const cb = '_s' + Date.now(), s = document.createElement('script');
      s.src = `https://suggestqueries.google.com/complete/search?client=firefox&q=${encodeURIComponent(q)}&callback=${cb}`;
      window[cb] = d => { res(d[1] || []); delete window[cb]; s.remove(); };
      s.onerror = () => { res([]); s.remove(); };
      document.head.appendChild(s);
    });
  }

  function render(items) {
    if (!items.length) { hide(); return; }
    sugBox.innerHTML = items.slice(0, 6).map(s =>
      `<button class="sug-row" data-v="${s.replace(/"/g, '&quot;')}" onmousedown="pick(this)">
        <span class="sug-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg></span>${s}
      </button>`
    ).join('');
    show(); active = -1;
  }

  function pick(el) { inp.value = el.dataset.v; hide(); }
