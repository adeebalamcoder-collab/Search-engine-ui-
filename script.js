document.addEventListener('DOMContentLoaded', function () {
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
  const MIN_RESULTS = 12;   // guaranteed minimum per load
  const FETCH_NUM  = 100;   // how many we pull from backend
  const CACHE_TTL  = 15 * 24 * 60 * 60 * 1000; // 15 days

  let currentQuery = '';
  let currentPage  = 1;
  let activeTab    = 'web';

  // ── "Show more" state ──
  let allResults      = [];   // full deduped result set for current query
  let shownCount      = 0;    // how many results currently visible
  let showMoreLoading = false;

  // ── images tab state ──
  let imgLoading = false, imgDone = false, imgTotalLoaded = 0, imgFirstLoad = true, imagesLoadedForQuery = null;
  let imgSeenUrls = new Set();
  let imgCombos = [], imgComboIdx = 0;
  const MAX_IMAGES = 300;

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

  // ══════════════════════════ TAB SWITCHING ══════════════════════════
  document.querySelectorAll('.nav-tab').forEach(tab => {
    tab.addEventListener('click', e => {
      e.preventDefault();
      document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('on'));
      tab.classList.add('on');
      switchTab(tab.dataset.tab);
    });
  });

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
      if (endFootEl)  endFootEl.style.display  = 'none';
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
      if (endFootEl)    endFootEl.style.display    = '';
      if (endBrandEl)   endBrandEl.style.display   = '';
    }
  }

  // ══════════════════════════ IMAGES TAB ══════════════════════════
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
      const gridSrc = img.thumbnailUrl || img.imageUrl;
      if (!gridSrc) return;
      const a = document.createElement('a');
      a.className = 'img-item';
      a.href = img.link || img.imageUrl;
      a.target = '_blank';
      a.rel = 'noopener';
      a.style.aspectRatio = '';
      const im = document.createElement('img');
      im.loading = 'lazy';
      im.decoding = 'async';
      im.setAttribute('fetchpriority', (imgTotalLoaded + idx) < 8 ? 'high' : 'low');
      im.alt = img.title || '';
      im.referrerPolicy = 'no-referrer';
      im.onerror = () => { a.remove(); checkFillViewport(); };
      im.src = gridSrc;
      a.appendChild(im);
      frag.appendChild(a);
    });
    imgGrid.appendChild(frag);
  }

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
    msg.textContent = imgTotalLoaded > 0
      ? `That's all the images we found (${imgTotalLoaded})`
      : 'No images found';
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

  // ══════════════════════════ CACHE (localStorage) ══════════════════════════
  function cacheGet(key) {
    try {
      const raw = localStorage.getItem('atkyn_' + key);
      if (!raw) return null;
      const { data, ts } = JSON.parse(raw);
      if (Date.now() - ts > CACHE_TTL) { localStorage.removeItem('atkyn_' + key); return null; }
      return data;
    } catch { return null; }
  }

  function cacheSet(key, data) {
    try {
      localStorage.setItem('atkyn_' + key, JSON.stringify({ data, ts: Date.now() }));
    } catch {}
  }

  // ══════════════════════════ FETCH ALL RESULTS ══════════════════════════
  // Returns full deduped array (up to FETCH_NUM). Caches the whole set.
  async function fetchAllResults(q) {
    const cacheKey = `${q}__all`;
    const cached = cacheGet(cacheKey);
    if (cached) return cached;

    const res = await fetch('/api/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ q, page: 1, num: FETCH_NUM })
    });
    if (!res.ok) throw new Error('search failed');
    const data = await res.json();

    const seen   = new Set();
    const merged = [];
    (data.organic || []).forEach(h => {
      const url = h.link || h.url || '';
      if (!url || seen.has(url)) return;
      seen.add(url);
      merged.push({
        title:   h.title   || url,
        snippet: h.snippet || h.description || '',
        url,
        thumb:   h.imageUrl || h.thumbnailUrl || null
      });
    });

    if (merged.length === 0) return [];
    cacheSet(cacheKey, merged);
    return merged;
  }

  // Prefetch — silently warm cache
  function prefetch(q) {
    if (!q || cacheGet(`${q}__all`)) return;
    fetchAllResults(q).catch(() => {});
  }

  // ══════════════════════════ WIKIPEDIA KNOWLEDGE PANEL ══════════════════════════
  async function getWikiData(q) {
    try {
      const searchUrl = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(q)}&srlimit=1&srinfo=&srprop=&format=json&origin=*`;
      const searchRes  = await fetch(searchUrl);
      const searchData = await searchRes.json();
      const hits = (searchData.query && searchData.query.search) || [];
      if (!hits.length) return null;

      const title     = hits[0].title;
      const detailUrl = `https://en.wikipedia.org/w/api.php?action=query&prop=extracts|pageimages|info&exintro=1&explaintext=1&exchars=400&piprop=thumbnail&pithumbsize=300&inprop=url&redirects=1&titles=${encodeURIComponent(title)}&format=json&origin=*`;
      const detailRes  = await fetch(detailUrl);
      const detailData = await detailRes.json();
      const pages = (detailData.query && detailData.query.pages) || {};
      const page  = Object.values(pages)[0];
      if (!page || page.missing) return null;
      if (!page.extract || page.extract.trim().length < 30) return null;

      return {
        title:       page.title,
        description: page.extract || '',
        imageUrl:    (page.thumbnail && page.thumbnail.source) || null,
        sourceUrl:   page.fullurl  || `https://en.wikipedia.org/wiki/${encodeURIComponent(page.title)}`,
        domain:      'en.wikipedia.org'
      };
    } catch { return null; }
  }

  // ══════════════════════════ SIDE IMAGES RAIL ══════════════════════════
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
            const src  = i.thumbnailUrl || i.imageUrl;
            const href = i.link || i.imageUrl;
            const alt  = (i.title || '').replace(/"/g, '&quot;');
            return `<a class="side-img-item" href="${href}" target="_blank" rel="noopener">
              <img src="${src}" alt="${alt}" loading="lazy" decoding="async" referrerpolicy="no-referrer"
                onerror="this.closest('.side-img-item').classList.add('img-hidden')">
            </a>`;
          }).join('')}
          <a href="#" class="side-img-item side-img-more" aria-label="See all images">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"
              stroke-linecap="round" stroke-linejoin="round" width="22" height="22">
              <polyline points="9 18 15 12 9 6"/>
            </svg>
          </a>
        </div>`;
    } catch { sideImagesEl.innerHTML = ''; }
  }

  // ══════════════════════════ ENTITY CHECK ══════════════════════════
  function looksLikeEntity(q) {
    const trimmed = q.trim();
    if (trimmed.length < 3 || trimmed.length > 60) return false;
    const skipPatterns = /^(what|how|why|when|where|who|is|are|was|were|can|do|does|did|will|should|which|tell|show|give|find|best|top|list|cheap|near|buy|vs|vs\.|versus)\b/i;
    if (skipPatterns.test(trimmed)) return false;
    const skipWords = /^(hello|hi|hey|yo|ok|okay|test|lol|lmao|haha|yes|no|hmm|sup|bro|yaar)$/i;
    if (skipWords.test(trimmed)) return false;
    if (/^[\d\s\W]+$/.test(trimmed)) return false;
    const words = trimmed.split(/\s+/);
    const hasProperNoun = words.some(w => w.length > 1 && w[0] === w[0].toUpperCase() && w[0] !== w[0].toLowerCase());
    if (hasProperNoun) return true;
    if (words.length === 1 && trimmed.length > 3) return true;
    return false;
  }

  // ══════════════════════════ RENDER ══════════════════════════
  function renderKnowledgePanel(wiki) {
    if (!wiki || !wiki.title) { kgContainer.innerHTML = ''; return; }
    const imageHtml = wiki.imageUrl
      ? `<img class="kg-image" src="${wiki.imageUrl}" alt="" referrerpolicy="no-referrer">`
      : '';
    const desc      = wiki.description || '';
    const domain    = wiki.domain      || '';
    const sourceUrl = wiki.sourceUrl   || '';
    kgContainer.innerHTML = `
      <div class="kg-card">
        <div class="kg-top">
          <div>
            <div class="kg-title">${wiki.title}</div>
            <div class="kg-type">Wikipedia</div>
          </div>
          <div class="kg-image-box">${imageHtml}</div>
        </div>
        ${desc   ? `<div class="kg-desc">${desc}</div>` : ''}
        ${domain ? `
        <a class="kg-source" href="${sourceUrl}" target="_blank" rel="noopener">
          <span class="kg-source-fav" style="background-image:url('https://www.google.com/s2/favicons?domain=${domain}&sz=64')"></span>
          <span class="kg-source-text">${domain}</span>
        </a>` : ''}
      </div>`;
  }

  function renderStats(total) {
    if (!total) { resultStats.textContent = ''; return; }
    resultStats.textContent = `About ${total.toLocaleString('en-US')} results`;
  }

  // Build card HTML for a single result
  function buildCard(r) {
    let domain = '', pathBreadcrumb = '', displayName = '';
    try {
      const u    = new URL(r.url);
      domain     = u.hostname.replace(/^www\./, '');
      displayName = domain.split('.')[0];
      displayName = displayName.charAt(0).toUpperCase() + displayName.slice(1);
      const segs  = u.pathname.split('/').filter(Boolean);
      pathBreadcrumb = segs.length ? `${domain} › ${segs.join(' › ')}` : domain;
    } catch {
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
              <svg viewBox="0 0 24 24" fill="currentColor">
                <circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/>
              </svg>
            </button>
          </div>
          <a href="${r.url}" target="_blank" rel="noopener" class="r-title">${r.title}</a>
          <a href="${r.url}" target="_blank" rel="noopener" class="r-snip">${r.snippet || 'No preview available.'}</a>
        </div>
        ${thumbHtml}
      </div>
    </div>`;
  }

  // Append a batch of results to the container (used by initial render + show more)
  function appendCards(results) {
    const frag = document.createElement('div');
    frag.innerHTML = results.map(buildCard).join('');
    while (frag.firstChild) resultsContainer.appendChild(frag.firstChild);
  }

  function renderNoResults(q, isError) {
    resultsContainer.innerHTML = `
    <div class="no-results">
      <div class="no-results__icon">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"
          stroke-linecap="round" width="40" height="40">
          <circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
        </svg>
      </div>
      <div class="no-results__title">${isError ? "Couldn't reach search" : `No results for "${q}"`}</div>
      <div class="no-results__sub">${isError ? 'Check your connection and try again.' : 'Try different or more general keywords.'}</div>
    </div>`;
    resultStats.textContent = '';
  }

  // ══════════════════════════ SHOW MORE ══════════════════════════
  function removeShowMoreBtn() {
    const old = document.getElementById('showMoreBtn');
    if (old) old.remove();
  }

  function renderShowMoreBtn() {
    removeShowMoreBtn();
    if (shownCount >= allResults.length) return; // nothing left

    const btn = document.createElement('button');
    btn.id        = 'showMoreBtn';
    btn.className = 'show-more-btn';
    btn.textContent = 'Show more';
    btn.addEventListener('click', onShowMore);
    pagerEl.appendChild(btn);
  }

  async function onShowMore() {
    if (showMoreLoading) return;
    showMoreLoading = true;

    const btn = document.getElementById('showMoreBtn');
    if (btn) { btn.textContent = 'Loading…'; btn.disabled = true; }

    // How many more to show — at least MIN_RESULTS, max what's left
    const nextBatch = allResults.slice(shownCount, shownCount + MIN_RESULTS);

    if (nextBatch.length > 0) {
      appendCards(nextBatch);
      shownCount += nextBatch.length;
    }

    removeShowMoreBtn();

    // If we've shown everything and still < MIN_RESULTS total, show engine switcher
    if (shownCount >= allResults.length) {
      renderEngineSwitcher();
      if (endFootEl)  endFootEl.style.display  = '';
      if (endBrandEl) endBrandEl.style.display = '';
    } else {
      renderShowMoreBtn();
    }

    showMoreLoading = false;
  }

  // ══════════════════════════ ENGINE SWITCHER ══════════════════════════
  // Shown at end of results — quick links to Google/Bing/Yandex for same query
  function renderEngineSwitcher() {
    const old = document.getElementById('engineSwitcher');
    if (old) old.remove();
    if (!currentQuery) return;

    const q  = encodeURIComponent(currentQuery);
    const el = document.createElement('div');
    el.id        = 'engineSwitcher';
    el.className = 'engine-switcher';
    el.innerHTML = `
      <span class="engine-switcher__label">Also search on</span>
      <a class="engine-btn" href="https://www.google.com/search?q=${q}" target="_blank" rel="noopener">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none">
          <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
          <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
          <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" fill="#FBBC05"/>
          <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
        </svg>
        Google
      </a>
      <a class="engine-btn" href="https://www.bing.com/search?q=${q}" target="_blank" rel="noopener">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="#0078D4"><path d="M5 3v15.3l4.3 2.4 8.4-5.1-4.5-1.7L5 3zm0 0"/></svg>
        Bing
      </a>
      <a class="engine-btn" href="https://yandex.com/search/?text=${q}" target="_blank" rel="noopener">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="#FC3F1D"><text x="2" y="19" font-size="18" font-family="Arial" font-weight="bold">Я</text></svg>
        Yandex
      </a>`;
    pagerEl.appendChild(el);
  }

  // ══════════════════════════ LOCATION AUTO-DETECT ══════════════════════════
  function injectLocationChip() {
    const old = document.getElementById('locationChip');
    if (old) old.remove();
    if (!navigator.geolocation) return;

    navigator.geolocation.getCurrentPosition(
      pos => {
        const { latitude: lat, longitude: lon } = pos.coords;
        // Reverse geocode via open nominatim (no key needed)
        fetch(`https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json`, {
          headers: { 'Accept-Language': 'en' }
        })
          .then(r => r.json())
          .then(data => {
            const city = data.address?.city || data.address?.town || data.address?.village || data.address?.county || '';
            if (!city) return;
            const chip = document.createElement('div');
            chip.id        = 'locationChip';
            chip.className = 'location-chip';
            chip.innerHTML = `
              <svg viewBox="0 0 24 24" fill="currentColor" width="13" height="13">
                <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z"/>
              </svg>
              ${city}`;
            resultStats.appendChild(chip);
          })
          .catch(() => {});
      },
      () => {} // silently ignore denied/unavailable
    );
  }

  // ══════════════════════════ MAIN SEARCH ══════════════════════════
  async function runSearch(q, page) {
    currentQuery        = q;
    currentPage         = page || 1;
    imagesLoadedForQuery = null;
    allResults          = [];
    shownCount          = 0;
    showMoreLoading     = false;

    // Clear UI
    resultsContainer.innerHTML = '';
    resultsContainer.style.opacity = '0';
    resultStats.textContent = '';
    pagerEl.innerHTML       = '';
    kgContainer.innerHTML   = '';
    if (sideImagesEl) sideImagesEl.innerHTML = '';
    if (endFootEl)    endFootEl.style.display    = 'none';
    if (endBrandEl)   endBrandEl.style.display   = 'none';

    try {
      allResults = await fetchAllResults(q);

      if (!allResults.length) { renderNoResults(q); return; }

      // ── Show first batch (min MIN_RESULTS) ──
      const firstBatch = allResults.slice(0, MIN_RESULTS);
      appendCards(firstBatch);
      shownCount = firstBatch.length;

      requestAnimationFrame(() => {
        resultsContainer.style.transition = 'opacity 0.18s ease';
        resultsContainer.style.opacity    = '1';
      });

      renderStats(allResults.length);

      // Show more button if there are more results
      if (shownCount < allResults.length) {
        renderShowMoreBtn();
      } else {
        // All results already shown
        renderEngineSwitcher();
        if (endFootEl)  endFootEl.style.display  = '';
        if (endBrandEl) endBrandEl.style.display = '';
      }

      // Location chip — inject next to stats
      injectLocationChip();

      // Wikipedia Knowledge Panel — non-blocking
      if (looksLikeEntity(q)) {
        getWikiData(q).then(wikiData => {
          if (wikiData) renderKnowledgePanel(wikiData);
        }).catch(() => {});
      }

      // Side images rail — non-blocking
      loadSideImages(q).catch(() => {});

    } catch (err) {
      renderNoResults(q, true);
      if (endFootEl)  endFootEl.style.display  = '';
      if (endBrandEl) endBrandEl.style.display = '';
    }
  }

  // ══════════════════════════ KNOWLEDGE PANEL RENDER ══════════════════════════
  // (already defined above, kept here for clarity of reading flow)

  // ══════════════════════════ SEARCH-BAR SUGGESTIONS ══════════════════════════
  inp.addEventListener('input', function () {
    const q = this.value.trim();
    xBtn.classList.toggle('show', q.length > 0);
    clearTimeout(tmr);
    if (!q) { hide(); return; }
    tmr = setTimeout(async () => {
      const sugs = await fetchSug(q);
      render(sugs);
    }, 180);
  });

  xBtn.addEventListener('click', () => {
    inp.value = '';
    xBtn.classList.remove('show');
    hide();
    inp.focus();
  });

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
      if (q) {
        const params = new URLSearchParams({ q });
        window.history.pushState({}, '', 'search.html?' + params.toString());
        document.title = q + ' — Atkyn Search';
        runSearch(q, 1);
      }
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
      const cb = '_s' + Date.now();
      const s  = document.createElement('script');
      s.src = `https://suggestqueries.google.com/complete/search?client=firefox&q=${encodeURIComponent(q)}&callback=${cb}`;
      window[cb] = d => { res(d[1] || []); delete window[cb]; s.remove(); };
      s.onerror  = () => { res([]); s.remove(); };
      document.head.appendChild(s);
    });
  }

  function render(items) {
    if (!items.length) { hide(); return; }
    sugBox.innerHTML = items.slice(0, 6).map(s =>
      `<button class="sug-row" data-v="${s.replace(/"/g, '&quot;')}" onmousedown="pick(this)">
        <span class="sug-ico">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
            <circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
          </svg>
        </span>${s}
      </button>`
    ).join('');
    show(); active = -1;
  }

  function pick(el) { inp.value = el.dataset.v; hide(); }

  window.pick     = pick;
  window.prefetch = prefetch;

}); // end DOMContentLoaded
