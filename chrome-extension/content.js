// Warframe Toolkit Chrome Extension — content script
// Two panels share this script:
//   - Dynamic Price Automator: warframe.market/profile/<slug>
//   - Ducanator 2.0: Ducanator page (under /tools/...)
// Each panel has its own master toggle (default OFF, persisted). The toggle is the
// only thing that authorises auto-runs — status flipping to "ingame" never auto-flips
// the toggle from off→on.

(function () {
  const isProfilePage = () => location.pathname.startsWith('/profile/');
  const isDucanatorPage = () => location.pathname === '/tools/ducats' || location.pathname.startsWith('/tools/ducats');
  // Quick top-level filter: if the URL isn't even one we care about, exit immediately.
  if (!isProfilePage() && !isDucanatorPage()) return;

  // ════════════════════════════════════════════════════════════
  // SHARED HELPERS (used by both panels)
  // ════════════════════════════════════════════════════════════

  const ENDO_COSTS = {
    'Common': 10230,
    'Uncommon': 20460,
    'Galv/Rare': 30690,
    'Archon/Primed': 40920,
  };
  const PACE_MS = 350;
  const APPLY_PACE_MS = 500;

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  function makeDraggable(el, handle) {
    let dx = 0, dy = 0, startX = 0, startY = 0, dragging = false;
    handle.addEventListener('mousedown', (e) => {
      // don't start a drag if the user clicked an interactive element in the header
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'BUTTON' ||
          e.target.closest('label, button, input')) return;
      dragging = true;
      const rect = el.getBoundingClientRect();
      startX = e.clientX; startY = e.clientY;
      dx = rect.left; dy = rect.top;
      el.style.right = 'auto';
      el.style.left = `${dx}px`;
      el.style.top = `${dy}px`;
      e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      el.style.left = `${dx + e.clientX - startX}px`;
      el.style.top = `${dy + e.clientY - startY}px`;
    });
    document.addEventListener('mouseup', () => { dragging = false; });
  }

  // ─── API ───
  // Crossplay: true tells warframe.market to include cross-platform sellers (Xbox, PS,
  // mobile) who have crossplay enabled. Switch is auto-excluded by the API since it
  // can't trade with PC. Without this header, ~7% of competing ingame sells are missed.
  async function api(path) {
    const resp = await fetch(`https://api.warframe.market${path}`, {
      headers: { 'Language': 'en', 'Platform': 'pc', 'Crossplay': 'true' },
      credentials: 'include',
    });
    if (!resp.ok) throw new Error(`${path} → HTTP ${resp.status}`);
    return resp.json();
  }

  let _itemsBySlug = null, _itemsById = null;
  async function getItemsMaps() {
    if (_itemsBySlug) return { bySlug: _itemsBySlug, byId: _itemsById };
    const data = await api('/v2/items');
    _itemsBySlug = {}; _itemsById = {};
    for (const item of (data.data || [])) {
      _itemsBySlug[item.slug] = item;
      _itemsById[item.id] = item;
    }
    return { bySlug: _itemsBySlug, byId: _itemsById };
  }

  async function getMyOrders(slug) {
    const data = await api(`/v2/orders/user/${encodeURIComponent(slug)}`);
    return data.data || [];
  }
  async function getItemOrders(slug) {
    const data = await api(`/v2/orders/item/${encodeURIComponent(slug)}`);
    return data.data || [];
  }
  function getCsrfToken() {
    return document.querySelector('meta[name="csrf-token"]')?.content || '';
  }
  async function patchOrder(orderId, body) {
    const headers = {
      'Content-Type': 'application/json',
      'Language': 'en',
      'Platform': 'pc',
      'Crossplay': 'true',
    };
    const csrf = getCsrfToken();
    if (csrf) headers['X-CSRFToken'] = csrf;
    const resp = await fetch(`https://api.warframe.market/v2/order/${encodeURIComponent(orderId)}`, {
      method: 'PATCH', headers, credentials: 'include',
      body: JSON.stringify(body),
    });
    if (!resp.ok) throw new Error(`PATCH /v2/order/${orderId} → HTTP ${resp.status}`);
    return resp.json();
  }

  // Post a review on a seller's profile. review_type: 1 = positive (also valid:
  // 0 = neutral, -1 = negative, but we only ever post positive). Endpoint is
  // v1 (not v2) — confirmed via DevTools network capture.
  // Friendly mapping for known API error codes — failed responses come back
  // as either {error: "..."} or {_form: ["app.review.limit_exc"]}.
  const REVIEW_ERROR_MESSAGES = {
    'app.review.limit_exc': 'daily review limit',
    'app.review.duplicate': 'already reviewed',
    'app.review.exists': 'already reviewed',
    'app.review.self': "can't review yourself",
  };
  async function postReview(sellerSlug, text) {
    const headers = {
      'Content-Type': 'application/json',
      'Language': 'en',
      'Platform': 'pc',
      'Crossplay': 'true',
    };
    const csrf = getCsrfToken();
    if (csrf) headers['X-CSRFToken'] = csrf;
    const resp = await fetch(`https://api.warframe.market/v1/profile/${encodeURIComponent(sellerSlug)}/review`, {
      method: 'POST', headers, credentials: 'include',
      body: JSON.stringify({ review_type: 1, text }),
    });
    if (!resp.ok) {
      let detail = `HTTP ${resp.status}`;
      try {
        const data = await resp.json();
        const formErr = Array.isArray(data?._form) ? data._form[0] : null;
        const code = formErr || (typeof data?.error === 'string' ? data.error : null);
        if (code && REVIEW_ERROR_MESSAGES[code]) {
          detail = REVIEW_ERROR_MESSAGES[code];
        } else if (formErr) {
          detail = `${detail} ${formErr}`;
        } else if (data?.error) {
          detail += ` ${typeof data.error === 'string' ? data.error : JSON.stringify(data.error)}`;
        }
      } catch {}
      throw new Error(detail);
    }
    return resp.json();
  }

  // ─── Status detection (shared by both panels) ───
  function scrapeStatusFromDOM() {
    const headerEl = document.querySelector('header, .header, [class*="header"]');
    const headerText = (headerEl?.innerText || '').toLowerCase();
    if (!headerText) return null;
    if (/in[-_ ]?game/.test(headerText)) return 'ingame';
    if (/\binvisible\b/.test(headerText)) return 'invisible';
    if (/\bonline\b/.test(headerText)) return 'online';
    if (/\boffline\b/.test(headerText)) return 'offline';
    return null;
  }
  async function detectMyStatus(mySlug) {
    const dom = scrapeStatusFromDOM();
    if (dom) return { status: dom, source: 'dom' };
    if (!mySlug) return { status: 'unknown', source: 'no-slug' };
    try {
      const data = await api(`/v2/user/${encodeURIComponent(mySlug)}`);
      return { status: data.data?.status || 'unknown', source: 'api' };
    } catch (e) {
      return { status: 'unknown', source: 'error' };
    }
  }

  // The logged-in user's slug, scraped from the avatar link in the page header.
  // Works on any warframe.market page once the SPA has rendered the header widget.
  function getLoggedInSlug() {
    const link = document.querySelector(
      'header a[href^="/profile/"], .header a[href^="/profile/"], [class*="header"] a[href^="/profile/"]'
    );
    if (!link) return '';
    const m = (link.getAttribute('href') || '').match(/^\/profile\/([^/?#]+)/);
    return m ? decodeURIComponent(m[1]) : '';
  }

  // Polls for the header avatar link until it's rendered (SPA can hydrate after document_idle).
  async function waitForLoggedInSlug(maxMs = 10000) {
    const start = Date.now();
    while (Date.now() - start < maxMs) {
      const slug = getLoggedInSlug();
      if (slug) return slug;
      await sleep(500);
    }
    return '';
  }

  // The user's cached profile slug, set via the one-time claim prompt
  // (see injectClaimProfilePrompt). Empty string if not set yet.
  function getCachedMySlug() {
    return (localStorage.getItem('wfaap-my-slug') || '').toLowerCase();
  }

  // The current URL's profile slug, lowercased; '' if not on a profile page.
  function getUrlProfileSlug() {
    if (!isProfilePage()) return '';
    return decodeURIComponent(location.pathname.split('/')[2] || '').toLowerCase();
  }

  // The user's own slug. Prefers the cached value (reliable across pages).
  // Falls back to the URL slug on profile pages, or the header-avatar slug elsewhere.
  function getMySlug() {
    const cached = getCachedMySlug();
    if (cached) return cached;
    if (isProfilePage()) {
      return decodeURIComponent(location.pathname.split('/')[2] || '');
    }
    return getLoggedInSlug();
  }

  // ─── Shared CSS for both panels ───
  function injectSharedCss() {
    if (document.getElementById('wfaap-shared-style')) return;
    const style = document.createElement('style');
    style.id = 'wfaap-shared-style';
    style.textContent = `
      .wfaap-panel { position: fixed; top: 80px; right: 16px; width: 360px; max-height: 75vh;
        overflow-y: auto; background: #0d1117; border: 1px solid #1e2a3a; border-radius: 8px;
        color: #e0e0e0; font-family: 'Segoe UI', 'Inter', sans-serif; font-size: 13px;
        z-index: 9999; box-shadow: 0 4px 20px rgba(0,0,0,0.4); }
      .wfaap-header { display: flex; justify-content: space-between; align-items: center;
        padding: 10px 12px; background: #131a27; border-bottom: 1px solid #1e2a3a;
        font-weight: 700; color: #00e5ff; cursor: move; user-select: none;
        border-radius: 8px 8px 0 0; gap: 8px; }
      .wfaap-header > span:first-child { font-size: 13px; letter-spacing: 0.3px; flex: 1; }
      .wfaap-header-controls { display: flex; align-items: center; gap: 6px; }
      .wfaap-btn-icon { background: transparent; border: none; color: #00e5ff;
        font-size: 16px; cursor: pointer; padding: 0 4px; line-height: 1; }
      .wfaap-toggle { position: relative; display: inline-block; width: 32px; height: 18px;
        cursor: pointer; flex-shrink: 0; }
      .wfaap-toggle input { display: none; }
      .wfaap-toggle-track { position: absolute; top: 0; left: 0; right: 0; bottom: 0;
        background: #2a3a4a; border-radius: 9px; transition: background 0.2s; }
      .wfaap-toggle-track:before { position: absolute; content: ''; height: 14px; width: 14px;
        left: 2px; top: 2px; background: #8899aa; border-radius: 50%; transition: 0.2s; }
      .wfaap-toggle input:checked + .wfaap-toggle-track { background: #00b4d8; }
      .wfaap-toggle input:checked + .wfaap-toggle-track:before {
        transform: translateX(14px); background: #fff; }
      .wfaap-body { padding: 12px; }
      .wfaap-row-label { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
      .wfaap-row-label > span { color: #8899aa; font-size: 12px; flex: 1; }
      .wfaap-row-label input { width: 70px; padding: 4px 6px; background: #131a27;
        color: #e0e0e0; border: 1px solid #2a3a4a; border-radius: 3px; font-size: 12px;
        text-align: right; font-family: inherit; }
      .wfaap-row-label input:focus { outline: none; border-color: #00b4d8; }
      .wfaap-row-label select { padding: 4px 6px; background: #131a27;
        color: #e0e0e0; border: 1px solid #2a3a4a; border-radius: 3px; font-size: 12px;
        font-family: inherit; cursor: pointer; }
      .wfaap-row-label select:focus { outline: none; border-color: #00b4d8; }
      .wfbh-ducats-group { display: flex; gap: 6px; flex-wrap: wrap; justify-content: flex-end; }
      .wfbh-tier-list { display: flex; flex-direction: column; gap: 4px; margin-bottom: 10px; }
      .wfbh-tier-row { display: flex; align-items: center; gap: 4px; font-size: 11px; color: #8899aa; }
      .wfbh-tier-row input { width: 50px; padding: 3px 4px; background: #131a27;
        color: #e0e0e0; border: 1px solid #2a3a4a; border-radius: 3px; font-size: 11px;
        text-align: right; font-family: inherit; }
      .wfbh-tier-row input:focus { outline: none; border-color: #00b4d8; }
      .wfbh-tier-row .wfbh-tier-remove { background: none; border: none; color: #ff6b6b;
        font-size: 14px; cursor: pointer; padding: 0 4px; line-height: 1; margin-left: auto; }
      .wfbh-tier-row .wfbh-tier-remove:hover { color: #ff4444; }
      .wfbh-tier-empty { color: #556677; font-size: 11px; font-style: italic; }
      .wfbh-ducats-group label { display: inline-flex; align-items: center; gap: 2px;
        font-size: 11px; color: #8899aa; cursor: pointer; user-select: none; }
      .wfbh-ducats-group input[type="checkbox"] { width: auto; margin: 0;
        cursor: pointer; accent-color: #00b4d8; }
      .wfaap-profile-footer { margin-top: 10px; padding-top: 8px; border-top: 1px solid #1e2a3a;
        font-size: 10px; color: #556677; text-align: center; }
      .wfaap-profile-footer a { color: #00b4d8; text-decoration: none; }
      .wfaap-profile-footer a:hover { text-decoration: underline; }
      .wfaap-claim-input { width: 100%; padding: 6px; background: #131a27; color: #e0e0e0;
        border: 1px solid #2a3a4a; border-radius: 3px; font-size: 12px;
        font-family: inherit; margin-bottom: 10px; box-sizing: border-box; }
      .wfaap-claim-input:focus { outline: none; border-color: #00b4d8; }
      .wfaap-claim-blurb { font-size: 12px; color: #cdd; margin-bottom: 10px; line-height: 1.4; }
      .wfaap-blocklist-details { margin-top: 10px; padding-top: 8px; border-top: 1px solid #1e2a3a; }
      .wfaap-blocklist-details summary { cursor: pointer; font-size: 12px; color: #8899aa; user-select: none; outline: none; }
      .wfaap-blocklist-details[open] summary { margin-bottom: 8px; }
      .wfaap-blocklist-body { display: flex; flex-direction: column; gap: 4px;
        max-height: 200px; overflow-y: auto; }
      .wfaap-blocklist-row { display: flex; justify-content: space-between; align-items: center;
        padding: 4px 6px; background: #131a27; border: 1px solid #2a3a4a;
        border-radius: 3px; font-size: 12px; }
      .wfaap-blocklist-row a { color: #00b4d8; text-decoration: none; }
      .wfaap-blocklist-row a:hover { text-decoration: underline; }
      .wfaap-blocklist-remove { background: none; border: none; color: #ff6b6b;
        font-size: 14px; cursor: pointer; padding: 0 4px; line-height: 1; }
      .wfaap-blocklist-remove:hover { color: #ff4444; }
      .wfaap-blocklist-empty { font-size: 11px; color: #556677; text-align: center; padding: 4px; }
      .wfaap-block-seller { color: #ff6b6b; text-decoration: none; font-size: 11px;
        margin-left: 4px; cursor: pointer; }
      .wfaap-block-seller:hover { text-decoration: underline; color: #ff4444; }
      .wfaap-copy-msg { color: #00e5ff; text-decoration: none; font-size: 11px;
        margin-left: 4px; cursor: pointer; }
      .wfaap-copy-msg:hover { text-decoration: underline; color: #5af0ff; }
      .wfaap-copy-msg.copied { color: #4ade80; }
      .wfaap-run { width: 100%; padding: 8px; color: #fff; border: none;
        border-radius: 4px; cursor: pointer; font-weight: 600; font-size: 12px;
        transition: all 0.2s; background: linear-gradient(135deg, #00b4d8, #0077b6); }
      .wfaap-run:hover { background: linear-gradient(135deg, #00e5ff, #0096c7); }
      .wfaap-run:disabled { opacity: 0.5; cursor: not-allowed; }
      .wfaap-run-mini { padding: 3px 10px; color: #cdd; border: 1px solid #2a3a4a;
        border-radius: 3px; cursor: pointer; font-weight: 500; font-size: 11px;
        background: #131a27; font-family: inherit; }
      .wfaap-run-mini:hover { background: #1a2333; border-color: #00b4d8; color: #fff; }
      .wfaap-run-mini:disabled { opacity: 0.5; cursor: not-allowed; }
      .wfaap-meta { font-size: 11px; color: #667788; margin-top: 8px; }
      .wfaap-meta .ingame { color: #4ade80; font-weight: 600; }
      .wfaap-meta .online { color: #00e5ff; }
      .wfaap-meta .offline, .wfaap-meta .invisible { color: #8899aa; }
      .wfaap-status { font-size: 11px; color: #8899aa; margin-top: 6px; min-height: 14px; }
      .wfaap-results { margin-top: 8px; max-height: 50vh; overflow-y: auto; }
      .wfaap-rec { padding: 6px 4px; border-bottom: 1px solid #1a2332; }
      .wfaap-rec:last-child { border-bottom: none; }
      .wfaap-rec-name { font-weight: 600; color: #e0e0e0; font-size: 12px; }
      .wfaap-rec-ratio { font-weight: 500; font-size: 11px; color: #667788; margin-left: 4px; }
      .wfaap-rec-detail { font-size: 11px; color: #8899aa; margin-top: 2px; line-height: 1.4; }
      .wfaap-rec-detail a { color: #00b4d8; text-decoration: none; }
      .wfaap-rec-detail a:hover { text-decoration: underline; }
      .wfaap-rec.move .wfaap-rec-name { color: #4ade80; }
      .wfaap-rec.applied .wfaap-rec-name { color: #00e5ff; }
      .wfaap-rec.floor .wfaap-rec-name { color: #fbbf24; }
      .wfaap-rec.noop .wfaap-rec-name { color: #8899aa; }
      .wfaap-rec.error .wfaap-rec-name { color: #f87171; }
      .wfaap-rec.deal .wfaap-rec-name { color: #4ade80; }
      .wfaap-panel.collapsed .wfaap-body { display: none; }
    `;
    document.head.appendChild(style);
  }

  // ─── Generic rec renderer (shared) ───
  function renderRecs(container, recs) {
    container.innerHTML = recs.length === 0
      ? '<div class="wfaap-rec-detail">No results.</div>'
      : recs.map(r => {
          const ratio = (r.ratio != null) ? ` <span class="wfaap-rec-ratio">${r.ratio.toFixed(2)} ${r.unit || ''}</span>` : '';
          // Optional secondary metric (e.g., total ducats per trade for Ducanator items).
          // Rendered with a leading "· " separator and no space between value
          // and unit2, so callers using e.g. unit2: "D total" produce "270D total".
          const ratio2 = (r.ratio2 != null) ? ` <span class="wfaap-rec-ratio">· ${r.ratio2.toFixed(0)}${r.unit2 || ''}</span>` : '';
          return `<div class="wfaap-rec ${r.kind}">
            <div class="wfaap-rec-name">${escapeHtml(r.name)}${ratio}${ratio2}</div>
            <div class="wfaap-rec-detail">${r.detail || ''}</div>
          </div>`;
        }).join('');
  }

  // ════════════════════════════════════════════════════════════
  // DYNAMIC PRICE AUTOMATOR (warframe.market/profile/<slug>)
  // ════════════════════════════════════════════════════════════
  const AP = {
    FLOOR: 'wfaap-floor',
    INTERVAL: 'wfaap-interval',
    COLLAPSED: 'wfaap-collapsed',
    ENABLED: 'wfaap-enabled',
    LAST_SCAN: 'wfaap-last-scan',
    SKIP_INITIAL: 'wfaap-skip-initial',
    LAST_RUN: 'wfaap-last-run',
    MY_SLUG: 'wfaap-my-slug',
    FLOOR_MODE: 'wfaap-floor-mode',     // 'static' | 'count'
    TARGET_COUNT: 'wfaap-target-count',
    DEFAULT_FLOOR: 2.5,
    DEFAULT_INTERVAL: 300,
    DEFAULT_FLOOR_MODE: 'static',
    DEFAULT_TARGET_COUNT: 5,
    POST_APPLY_REFRESH_MS: 2000,
  };

  function classifyTier(name, tags) {
    const n = (name || '').toLowerCase();
    if (n.startsWith('primed ') || n.startsWith('archon ') ||
        tags.includes('legendary') || tags.includes('archon')) return 'Archon/Primed';
    if (n.startsWith('galvanized ') || tags.includes('rare')) return 'Galv/Rare';
    if (tags.includes('uncommon')) return 'Uncommon';
    if (tags.includes('common')) return 'Common';
    return null;
  }
  function isModItem(tags) {
    return tags.includes('mod') && !tags.includes('riven_mod');
  }

  function competingIngameSells(orders, mySlug, rank) {
    const me = (mySlug || '').toLowerCase();
    return orders
      .filter(o => o.type === 'sell')
      .filter(o => o.user?.status === 'ingame')
      .filter(o => (o.user?.slug || '').toLowerCase() !== me)
      .filter(o => o.platinum > 0)
      .filter(o => rank == null || o.rank === rank)
      .sort((a, b) => a.platinum - b.platinum);
  }
  function findOptimalPriceTier(competitors, endoCost, floor) {
    for (let i = 0; i < competitors.length; i++) {
      const newPrice = competitors[i].platinum - 1;
      const ratio = (newPrice / endoCost) * 1000;
      if (ratio >= floor) {
        return {
          position: i + 1, totalCompetitors: competitors.length,
          competitor: competitors[i], newPrice, ratio,
        };
      }
    }
    return null;
  }


  function injectAutoPricerPanel() {
    if (document.getElementById('wfap-panel')) return;
    const panel = document.createElement('div');
    panel.id = 'wfap-panel';
    panel.className = 'wfaap-panel';
    panel.innerHTML = `
      <div class="wfaap-header">
        <span>Dynamic Price Automator</span>
        <div class="wfaap-header-controls">
          <label class="wfaap-toggle" title="Enable auto-runs"><input type="checkbox" id="wfap-enabled"><span class="wfaap-toggle-track"></span></label>
          <button class="wfaap-btn-icon" id="wfap-collapse" title="Collapse">−</button>
        </div>
      </div>
      <div class="wfaap-body">
        <div class="wfaap-row-label" title="Static value: you set a fixed plat/1k endo floor; mods only undercut to tiers above it. Target #1 count: you set how many of your mods you want at position 1 (cheapest), and the floor is derived dynamically every scan as the highest value that achieves that count given the current market."><span>Floor mode</span>
          <select id="wfap-floor-mode">
            <option value="static">Static value</option>
            <option value="count">Target #1 count</option>
          </select>
        </div>
        <div class="wfaap-row-label" id="wfap-floor-static-row"><span>Plat/1k Endo floor</span>
          <input id="wfap-floor" type="number" step="0.1" min="0"></div>
        <div class="wfaap-row-label" id="wfap-floor-count-row" style="display: none;"><span>Target #1 count</span>
          <input id="wfap-target-count" type="number" step="1" min="1"></div>
        <div class="wfaap-meta" id="wfap-computed-floor" style="display: none;">Computed floor: ?</div>
        <div class="wfaap-row-label"><span>Auto-run interval (sec)</span>
          <input id="wfap-interval" type="number" step="1" min="60"></div>
        <button class="wfaap-run" id="wfap-run">Run Now</button>
        <div class="wfaap-meta" id="wfap-meta">Status: ?</div>
        <div class="wfaap-status" id="wfap-status">Idle.</div>
        <div class="wfaap-results" id="wfap-results"></div>
        <div class="wfaap-profile-footer" id="wfap-profile-footer"></div>
      </div>
    `;
    document.body.appendChild(panel);

    // Inputs (persisted)
    const floorInput = panel.querySelector('#wfap-floor');
    floorInput.value = localStorage.getItem(AP.FLOOR) || String(AP.DEFAULT_FLOOR);
    floorInput.addEventListener('input', () => localStorage.setItem(AP.FLOOR, floorInput.value));

    const targetCountInput = panel.querySelector('#wfap-target-count');
    targetCountInput.value = localStorage.getItem(AP.TARGET_COUNT) || String(AP.DEFAULT_TARGET_COUNT);
    targetCountInput.addEventListener('input', () => localStorage.setItem(AP.TARGET_COUNT, targetCountInput.value));

    // Floor mode select: 'static' uses #wfap-floor as the literal floor;
    // 'count' uses #wfap-target-count and derives the floor dynamically each
    // scan from the live market data. Mode-dependent rows are toggled below.
    const floorModeSelect = panel.querySelector('#wfap-floor-mode');
    const floorStaticRow = panel.querySelector('#wfap-floor-static-row');
    const floorCountRow = panel.querySelector('#wfap-floor-count-row');
    const computedFloorEl = panel.querySelector('#wfap-computed-floor');
    function refreshFloorModeUi() {
      const m = floorModeSelect.value || AP.DEFAULT_FLOOR_MODE;
      floorStaticRow.style.display = m === 'static' ? '' : 'none';
      floorCountRow.style.display = m === 'count' ? '' : 'none';
      computedFloorEl.style.display = m === 'count' ? '' : 'none';
    }
    floorModeSelect.value = localStorage.getItem(AP.FLOOR_MODE) || AP.DEFAULT_FLOOR_MODE;
    refreshFloorModeUi();
    floorModeSelect.addEventListener('change', () => {
      localStorage.setItem(AP.FLOOR_MODE, floorModeSelect.value);
      refreshFloorModeUi();
    });

    const intervalInput = panel.querySelector('#wfap-interval');
    intervalInput.value = localStorage.getItem(AP.INTERVAL) || String(AP.DEFAULT_INTERVAL);
    intervalInput.addEventListener('input', () => {
      localStorage.setItem(AP.INTERVAL, intervalInput.value);
      scheduleAutoPricer(panel);
    });

    // Toggle (persisted, default OFF)
    const enabledInput = panel.querySelector('#wfap-enabled');
    enabledInput.checked = localStorage.getItem(AP.ENABLED) === '1';
    enabledInput.addEventListener('change', () => {
      const enabled = enabledInput.checked;
      localStorage.setItem(AP.ENABLED, enabled ? '1' : '0');
      if (enabled) {
        scheduleAutoPricer(panel);
        // immediate scan if currently ingame
        (async () => {
          const status = await refreshAutoPricerStatus(panel);
          if (status === 'ingame') runAutoPricerScan(panel);
        })();
      } else {
        cancelAutoPricerSchedule(panel);
        refreshAutoPricerStatus(panel);
      }
    });

    // Collapsed
    const collapseBtn = panel.querySelector('#wfap-collapse');
    if (localStorage.getItem(AP.COLLAPSED) === '1') {
      panel.classList.add('collapsed');
      collapseBtn.textContent = '+';
    }
    collapseBtn.addEventListener('click', () => {
      const collapsed = panel.classList.toggle('collapsed');
      collapseBtn.textContent = collapsed ? '+' : '−';
      localStorage.setItem(AP.COLLAPSED, collapsed ? '1' : '0');
    });

    // Manual Run Now: works regardless of toggle state
    panel.querySelector('#wfap-run').addEventListener('click', () => runAutoPricerScan(panel));

    // Cached-profile footer: shows whose listings the panel is targeting and lets
    // the user reset the cache (re-prompts on the next profile-page load).
    const footer = panel.querySelector('#wfap-profile-footer');
    const cached = getCachedMySlug();
    footer.innerHTML = `Profile: <b>${escapeHtml(cached)}</b> · <a href="#" id="wfap-change-profile">change</a>`;
    panel.querySelector('#wfap-change-profile').addEventListener('click', (e) => {
      e.preventDefault();
      if (confirm('Clear cached profile? You will be asked for a profile URL on the next profile page load.')) {
        localStorage.removeItem(AP.MY_SLUG);
        try { chrome.storage.local.remove(AP.MY_SLUG); } catch {}
        location.reload();
      }
    });

    makeDraggable(panel, panel.querySelector('.wfaap-header'));
  }

  // Shown on profile pages when no profile slug is cached yet. The user pastes
  // their own warframe.market profile URL; we extract the slug and cache it.
  // On the next profile page load, the auto-pricer only injects when the URL
  // slug matches the cached one.
  function injectClaimProfilePrompt(urlSlug) {
    if (document.getElementById('wfap-claim')) return;
    const panel = document.createElement('div');
    panel.id = 'wfap-claim';
    panel.className = 'wfaap-panel';
    panel.innerHTML = `
      <div class="wfaap-header">
        <span>Dynamic Price Automator setup</span>
        <button class="wfaap-btn-icon" id="wfap-claim-close" title="Dismiss">×</button>
      </div>
      <div class="wfaap-body">
        <div class="wfaap-claim-blurb">
          Paste <b>your own</b> warframe.market profile URL to enable Dynamic Price Automator.
          The panel will only inject on that exact profile from now on.
        </div>
        <input id="wfap-claim-input" class="wfaap-claim-input" type="text"
               placeholder="https://warframe.market/profile/your_slug"
               value="${escapeHtml(urlSlug ? `https://warframe.market/profile/${urlSlug}` : '')}">
        <button class="wfaap-run" id="wfap-claim-save">Save profile</button>
        <div class="wfaap-status" id="wfap-claim-status"></div>
      </div>
    `;
    document.body.appendChild(panel);

    panel.querySelector('#wfap-claim-close').addEventListener('click', () => panel.remove());

    const input = panel.querySelector('#wfap-claim-input');
    const statusEl = panel.querySelector('#wfap-claim-status');
    function save() {
      const value = input.value.trim();
      const m = value.match(/\/profile\/([^/?#]+)/);
      const slug = (m ? m[1] : value.replace(/^\/+|\/+$/g, '')).toLowerCase();
      if (!slug || /\s/.test(slug) || slug.length > 64) {
        statusEl.textContent = 'Invalid URL or slug.';
        return;
      }
      localStorage.setItem(AP.MY_SLUG, slug);
      try { chrome.storage.local.set({ [AP.MY_SLUG]: slug }); } catch {}
      statusEl.textContent = 'Saved. Reloading...';
      setTimeout(() => location.reload(), 500);
    }
    panel.querySelector('#wfap-claim-save').addEventListener('click', save);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });

    makeDraggable(panel, panel.querySelector('.wfaap-header'));
  }

  async function refreshAutoPricerStatus(panel) {
    const mySlug = getMySlug();
    const { status, source } = await detectMyStatus(mySlug);
    const enabled = localStorage.getItem(AP.ENABLED) === '1';
    const meta = panel.querySelector('#wfap-meta');
    if (meta) {
      let auto;
      if (!enabled) auto = 'auto-run off';
      else if (status === 'ingame') auto = 'auto-run on';
      else auto = 'auto-run paused';
      meta.innerHTML = `Status: <span class="${escapeHtml(status)}">${escapeHtml(status)}</span> · ${escapeHtml(auto)} <span style="color:#445">(via ${source})</span>`;
    }
    return status;
  }

  function cancelAutoPricerSchedule(panel) {
    if (panel._wfapTimer) clearInterval(panel._wfapTimer);
    if (panel._wfapTimeout) clearTimeout(panel._wfapTimeout);
    panel._wfapTimer = null;
    panel._wfapTimeout = null;
  }

  function scheduleAutoPricer(panel) {
    cancelAutoPricerSchedule(panel);
    if (localStorage.getItem(AP.ENABLED) !== '1') return; // disabled → no schedule

    const intervalMs = Math.max(30, parseInt(panel.querySelector('#wfap-interval').value, 10) || AP.DEFAULT_INTERVAL) * 1000;
    const lastScan = parseInt(localStorage.getItem(AP.LAST_SCAN) || '0', 10);
    const elapsed = Date.now() - lastScan;
    const initialDelay = lastScan > 0 ? Math.max(0, intervalMs - elapsed) : intervalMs;

    const tick = async () => {
      if (localStorage.getItem(AP.ENABLED) !== '1') return; // toggle flipped off mid-wait
      const status = await refreshAutoPricerStatus(panel);
      if (status === 'ingame') runAutoPricerScan(panel);
    };

    panel._wfapTimeout = setTimeout(() => {
      tick();
      panel._wfapTimer = setInterval(tick, intervalMs);
    }, initialDelay);
  }

  async function runAutoPricerScan(panel) {
    if (panel._wfapBusy) return;
    panel._wfapBusy = true;

    const status = panel.querySelector('#wfap-status');
    const results = panel.querySelector('#wfap-results');
    const runBtn = panel.querySelector('#wfap-run');
    const computedFloorEl = panel.querySelector('#wfap-computed-floor');
    const floorMode = (localStorage.getItem(AP.FLOOR_MODE) || AP.DEFAULT_FLOOR_MODE);
    const staticFloor = parseFloat(panel.querySelector('#wfap-floor').value) || AP.DEFAULT_FLOOR;
    const targetCount = Math.max(1, parseInt(panel.querySelector('#wfap-target-count').value, 10) || AP.DEFAULT_TARGET_COUNT);

    runBtn.disabled = true;
    results.innerHTML = '';
    status.textContent = 'Loading item catalog...';

    try {
      const mySlug = getMySlug();
      if (!mySlug) throw new Error('No profile slug in URL.');
      const { byId } = await getItemsMaps();
      status.textContent = 'Loading your listings...';
      const myOrders = await getMyOrders(mySlug);

      const sells = myOrders.filter(o => o.type === 'sell');
      const targets = sells.filter(o => {
        if (o.visible !== true) return false;
        if (o.rank !== 10) return false;
        const item = byId[o.itemId];
        if (!item) return false;
        return isModItem(item.tags || []);
      });
      const skipped = sells.length - targets.length;

      // Phase 1: per-mod fetch + classify. We collect ALL the data first so
      // count-mode can derive the floor from the full set before deciding any
      // individual rec. Static-mode just uses the data immediately afterwards.
      const scanned = [];
      for (let i = 0; i < targets.length; i++) {
        const order = targets[i];
        const item = byId[order.itemId];
        const slug = item.slug;
        const itemName = item.i18n?.en?.name || slug;
        status.textContent = `Scanning ${i + 1}/${targets.length}: ${itemName}`;
        try {
          const orders = await getItemOrders(slug);
          const competitors = competingIngameSells(orders, mySlug, order.rank);
          const tier = classifyTier(itemName, item.tags || []);
          const endoCost = tier ? ENDO_COSTS[tier] : null;
          const currentRatio = endoCost ? (order.platinum / endoCost) * 1000 : null;
          // The "would-be #1 ratio" — what we'd land at if we took position 1
          // (i.e., undercut the cheapest competitor by 1p). Drives count mode.
          const undercutP1Ratio = (competitors.length > 0 && endoCost && competitors[0].platinum > 1)
            ? (competitors[0].platinum - 1) / endoCost * 1000
            : null;
          scanned.push({ order, item, slug, itemName, competitors, tier, endoCost, currentRatio, undercutP1Ratio });
        } catch (err) {
          scanned.push({ order, item, slug: item.slug, itemName, error: String(err.message || err) });
        }
        if (i < targets.length - 1) await sleep(PACE_MS);
      }

      // Phase 2: derive the effective floor for this scan.
      let effectiveFloor;
      let computedFloorMessage = null;
      if (floorMode === 'count') {
        // Mods with no competitor are always #1 unopposed — they count toward
        // the target without needing the floor to allow anything.
        const noCompCount = scanned.filter(s => !s.error && s.competitors && s.competitors.length === 0).length;
        const ratiosDesc = scanned
          .filter(s => !s.error && s.undercutP1Ratio != null)
          .map(s => s.undercutP1Ratio)
          .sort((a, b) => b - a);
        const need = targetCount - noCompCount;
        if (need <= 0) {
          // Already at or over target from no-comp mods alone; pick a floor
          // high enough to reject all undercuts. The walk-up logic will then
          // hold each contested mod (kind='floor').
          effectiveFloor = Number.POSITIVE_INFINITY;
          computedFloorMessage = `Computed floor: ∞ (target ${targetCount}, ${noCompCount} unopposed mods already at #1; no undercut needed)`;
        } else if (need > ratiosDesc.length) {
          // Want more #1 than we have undercut-eligible mods. Set to 0 so all
          // available #1 slots are taken; the actual count will be capped by
          // (noCompCount + ratiosDesc.length).
          effectiveFloor = 0;
          computedFloorMessage = `Computed floor: 0 (target ${targetCount} but only ${noCompCount + ratiosDesc.length} mods can reach #1)`;
        } else {
          effectiveFloor = ratiosDesc[need - 1];
          computedFloorMessage = `Computed floor: ${effectiveFloor.toFixed(2)} P/1k (target ${targetCount} #1: ${noCompCount} unopposed + ${need} cheapest-tier above floor)`;
        }
      } else {
        effectiveFloor = staticFloor;
      }
      if (computedFloorEl) {
        computedFloorEl.textContent = floorMode === 'count' ? (computedFloorMessage || '') : '';
        computedFloorEl.style.display = floorMode === 'count' ? '' : 'none';
      }

      // Phase 3: build recs using the derived floor.
      const recs = [];
      for (const s of scanned) {
        if (s.error) {
          recs.push({ name: s.itemName, kind: 'error', detail: s.error });
          continue;
        }
        const { order, slug, itemName, competitors, endoCost, currentRatio, tier } = s;
        if (competitors.length === 0) {
          recs.push({ name: itemName, kind: 'noop', ratio: currentRatio, unit: 'P/1k', detail: 'no ingame competitor: leave as is' });
        } else if (!endoCost) {
          recs.push({ name: itemName, kind: 'error', detail: `unknown tier "${tier}"` });
        } else {
          const pick = findOptimalPriceTier(competitors, endoCost, effectiveFloor);
          if (!pick) {
            const floorLabel = Number.isFinite(effectiveFloor) ? effectiveFloor.toFixed(1) : '∞';
            recs.push({
              name: itemName, kind: 'floor', ratio: currentRatio, unit: 'P/1k',
              detail: `every undercut tier (1–${competitors.length}) lands below floor ${floorLabel} P/1k. Hold at ${order.platinum}p.`,
            });
          } else if (pick.newPrice === order.platinum) {
            recs.push({
              name: itemName, kind: 'noop', ratio: currentRatio, unit: 'P/1k',
              detail: `already at ${order.platinum}p: position ${pick.position}/${pick.totalCompetitors}`,
              position: pick.position,
              totalCompetitors: pick.totalCompetitors,
            });
          } else {
            recs.push({
              name: itemName, kind: 'move', ratio: pick.ratio, unit: 'P/1k',
              detail: `${order.platinum}p → ${pick.newPrice}p · position ${pick.position}/${pick.totalCompetitors}`,
              orderId: order.id,
              oldPrice: order.platinum,
              newPrice: pick.newPrice,
              position: pick.position,
              totalCompetitors: pick.totalCompetitors,
              patch: {
                visible: order.visible,
                platinum: pick.newPrice,
                quantity: order.quantity,
                rank: order.rank,
              },
            });
          }
        }
      }

      // Sort: ascending position (best/cheapest leaderboard slot first),
      // then descending plat/1k endo for ties (more efficient one wins).
      // Recs without a position (no-competitor noop, floor, errors) sink to the bottom.
      recs.sort((a, b) => {
        const aPos = (a.position != null) ? a.position : Infinity;
        const bPos = (b.position != null) ? b.position : Infinity;
        if (aPos !== bPos) return aPos - bPos;
        const aRatio = (a.ratio != null) ? a.ratio : -Infinity;
        const bRatio = (b.ratio != null) ? b.ratio : -Infinity;
        return bRatio - aRatio;
      });

      panel._wfapAllRecs = recs;
      renderRecs(results, recs);

      // Auto-apply moves (iterates in the same sorted order)
      const moves = recs.filter(r => r.kind === 'move');
      let ok = 0, fail = 0;
      if (moves.length > 0) {
        for (let i = 0; i < moves.length; i++) {
          const m = moves[i];
          status.textContent = `Applying ${i + 1}/${moves.length}: ${m.name}...`;
          try {
            await patchOrder(m.orderId, m.patch);
            m.kind = 'applied';
            m.detail = `Applied: now ${m.newPrice}p (was ${m.oldPrice}p) · position ${m.position}/${m.totalCompetitors}`;
            ok++;
          } catch (err) {
            m.kind = 'error';
            m.detail = `Failed: ${err.message || err}`;
            fail++;
          }
          renderRecs(results, recs);
          if (i < moves.length - 1) await sleep(APPLY_PACE_MS);
        }
        status.textContent = `Scanned ${targets.length} (${skipped} skipped). ${ok} applied, ${fail} failed.`;
      } else {
        status.textContent = `Scanned ${targets.length} (${skipped} skipped). No price changes needed.`;
      }

      localStorage.setItem(AP.LAST_SCAN, String(Date.now()));

      // Refresh on any successful apply (warframe.market doesn't live-update list prices)
      if (ok > 0) {
        try {
          sessionStorage.setItem(AP.LAST_RUN, JSON.stringify({
            recs: recs,
            status: status.textContent,
            computedFloor: floorMode === 'count' ? computedFloorMessage : null,
          }));
        } catch (e) {}
        sessionStorage.setItem(AP.SKIP_INITIAL, '1');
        status.textContent += ` Refreshing page to show new prices...`;
        setTimeout(() => location.reload(), AP.POST_APPLY_REFRESH_MS);
      }
    } catch (err) {
      status.textContent = `Error: ${err.message || err}`;
    } finally {
      runBtn.disabled = false;
      panel._wfapBusy = false;
    }
  }

  async function initAutoPricer() {
    injectAutoPricerPanel();
    const panel = document.getElementById('wfap-panel');
    if (!panel) return;

    const skipInitial = sessionStorage.getItem(AP.SKIP_INITIAL) === '1';
    sessionStorage.removeItem(AP.SKIP_INITIAL);

    if (skipInitial) {
      try {
        const stashed = JSON.parse(sessionStorage.getItem(AP.LAST_RUN) || 'null');
        sessionStorage.removeItem(AP.LAST_RUN);
        if (stashed?.recs) {
          panel._wfapAllRecs = stashed.recs;
          renderRecs(panel.querySelector('#wfap-results'), stashed.recs);
          if (stashed.status) panel.querySelector('#wfap-status').textContent = stashed.status;
          // Restore the computed-floor display so the user can see what
          // floor was actually used in the scan that just triggered the
          // page reload — otherwise it'd reset to "?" until the next scan.
          if (stashed.computedFloor) {
            const cfEl = panel.querySelector('#wfap-computed-floor');
            if (cfEl) {
              cfEl.textContent = stashed.computedFloor;
              cfEl.style.display = '';
            }
          }
        }
      } catch (e) {}
    }

    const enabled = localStorage.getItem(AP.ENABLED) === '1';
    const status = await refreshAutoPricerStatus(panel);
    if (!skipInitial && enabled && status === 'ingame') {
      await runAutoPricerScan(panel);
    }
    if (enabled) scheduleAutoPricer(panel);
  }

  // ════════════════════════════════════════════════════════════
  // DUCANATOR 2.0 (Ducanator page)
  // ════════════════════════════════════════════════════════════
  // Background-tab note: setInterval/setTimeout keep running in hidden tabs
  // (Chrome throttles to 1s floor, irrelevant at our 300s/600s intervals).
  // The Auto-Pricer profile tab and the Ducanator tab are on separate pages
  // and use disjoint localStorage namespaces (wfaap-* vs wfbh-*), so two tabs
  // both out of focus run safely in parallel. Constants used only by the
  // scan (NOTIFIED_DEALS, NOTIFY_PRUNE_MS, LAST_SCAN, DUCAT_DENOMS) live in
  // background.js where the scan runs; this dict only carries keys/defaults
  // the panel UI itself reads or writes.
  const BH = {
    ENABLED: 'wfbh-enabled',
    INTERVAL: 'wfbh-interval',
    TOP_M: 'wfbh-top-m',
    MIN_DPP: 'wfbh-min-dpp',
    MIN_DPT: 'wfbh-min-dpt',                   // min ducats/trade (live)
    MIN_TOTAL_D: 'wfbh-min-total-d',           // min total ducats from listing
    MIN_CACHE_DPP: 'wfbh-min-cache-dpp',       // min D/p from page table (cache filter)
    TIERED_FLOOR: 'wfbh-tiered-floor',         // JSON [{dtrade, dpp}, ...] piecewise D/p floor by D/trade
    DUCATS_ALLOWED: 'wfbh-ducats-allowed',
    BLOCKLIST: 'wfbh-blocklist',
    COLLAPSED: 'wfbh-collapsed',
    SOURCE_CACHE: 'wfbh-source-cache',         // {ts, items: [{slug, name, ducats}]}
    PARTS_CACHE: 'wfbh-parts-cache',           // {setSlug: parts_count}
    NOTIFY_ENABLED: 'wfbh-notify-enabled',     // '1' / '0'
    MIN_TRADE_EFF: 'wfbh-min-trade-eff',       // 1..6
    SORT_BY: 'wfbh-sort-by',                   // 'dpp' | 'dpt' | 'total'
    SECONDARY_SORT_BY: 'wfbh-secondary-sort-by', // 'none' | 'dpp' | 'dpt' | 'total'
    DEFAULT_INTERVAL: 600,
    DEFAULT_TOP_M: 10,
    DEFAULT_NOTIFY_ENABLED: true,
    REVIEW_TEXT: 'fast, friendly, and great prices', // text posted by the [+rep] button
    DEFAULT_MIN_TRADE_EFF: 1,         // 1..6 — partial-trade efficiency floor
    DEFAULT_SORT_BY: 'dpp',
    DEFAULT_SECONDARY_SORT_BY: 'none',
    SOURCE_CACHE_SIZE: 500,           // hard cap on cached source rows
    PARTS_CACHE_VERSION: 2,           // bump when fetchPartsForSet formula changes; old caches silently discarded
    DEFAULT_MIN_DPP: 0,
    DEFAULT_MIN_DPT: 0,
    DEFAULT_MIN_TOTAL_D: 0,
    DEFAULT_MIN_CACHE_DPP: 0,
    DUCAT_DENOMS: [15, 25, 45, 65, 100], // the 5 prime-part ducat values
    DEFAULT_DUCATS_ALLOWED: '15,25,45,65,100',
  };

  // ─── Source-list cache helpers ───
  // The Ducanator page uses react-virtuoso, which doesn't mount rows when
  // the tab is hidden. To make scans work in backgrounded tabs, we keep a
  // user-managed cache of up to 500 source rows (slug, name, ducats).
  // The cache is built/refreshed only via the "Refresh source cache"
  // button (foreground only, since the scrape needs the page painted).
  // Regular scans always pull from the cache.
  function getSourceCache() {
    try {
      const raw = JSON.parse(localStorage.getItem(BH.SOURCE_CACHE) || 'null');
      if (!raw || !Array.isArray(raw.items)) return null;
      return raw;
    } catch {
      return null;
    }
  }
  function setSourceCache(cache) {
    syncBHSetting(BH.SOURCE_CACHE, JSON.stringify(cache));
  }

  // ─── Parts-per-set cache ───
  // Source: warframe.market /v2/items/{slug} returns:
  //   - For sets: { setRoot: true, setParts: [...IDs including own] }
  //   - For parts: { setRoot: false, quantityInSet: N, setParts: [same list] }
  // Total parts in a set = sum of `quantityInSet` across its constituent parts
  // (excluding the set itself). Some sets have stackable parts that craft 2x
  // or more (e.g. dual weapons need 2 blades + 2 handles), so we can't just
  // count unique IDs. The cache is wrapped with a version number so when this
  // formula changes, old caches get silently discarded on read and rebuilt.
  function getPartsCache() {
    try {
      const raw = JSON.parse(localStorage.getItem(BH.PARTS_CACHE) || '{}');
      if (raw && typeof raw === 'object' && raw.version === BH.PARTS_CACHE_VERSION
          && raw.parts && typeof raw.parts === 'object') {
        return raw.parts;
      }
      return {};
    } catch {
      return {};
    }
  }
  function setPartsCache(map) {
    syncBHSetting(BH.PARTS_CACHE, JSON.stringify({
      version: BH.PARTS_CACHE_VERSION,
      parts: map,
    }));
  }
  // Fetches the part count for a set and caches it. The set's setParts gives
  // us the part IDs; we then look up each part's quantityInSet (preferring
  // the /v2/items catalog map; falling back to /v2/items/{partSlug} if the
  // catalog doesn't carry that field). Returns the total count, or null
  // on failure / non-set response.
  async function fetchPartsForSet(slug) {
    try {
      const data = await api(`/v2/items/${encodeURIComponent(slug)}`);
      const item = data?.data;
      if (!item || !item.setRoot || !Array.isArray(item.setParts)) return null;

      const partIds = item.setParts.filter(id => id !== item.id);
      if (partIds.length === 0) return null;

      const { byId } = await getItemsMaps();
      let totalParts = 0;
      for (const partId of partIds) {
        const partItem = byId[partId];
        let qty = null;
        // Fast path: catalog has quantityInSet on the part item.
        if (partItem && typeof partItem.quantityInSet === 'number' && partItem.quantityInSet > 0) {
          qty = partItem.quantityInSet;
        } else if (partItem && partItem.slug) {
          // Slow path: fetch the part directly to read quantityInSet.
          try {
            const partData = await api(`/v2/items/${encodeURIComponent(partItem.slug)}`);
            const q = partData?.data?.quantityInSet;
            if (typeof q === 'number' && q > 0) qty = q;
            await sleep(PACE_MS);
          } catch { /* leave qty null → falls through to default 1 */ }
        }
        // Default to 1 if we couldn't determine — better an under-count than
        // crashing on an unmappable part. Worst case the row is dropped by
        // the trade-eff filter; user can flag it and we adjust.
        totalParts += (qty || 1);
      }
      if (totalParts <= 0) return null;
      const m = getPartsCache();
      m[slug] = totalParts;
      setPartsCache(m);
      return totalParts;
    } catch {
      return null;
    }
  }

  // ─── Tiered D/p floor helpers (UI-side) ───
  // Stored as a JSON array of {dtrade, dpp} objects. The scan-time consumer
  // (background.js tieredFloorFor) reads from chrome.storage.local; we keep
  // these helpers here so the panel UI can edit/persist the list, and we
  // mirror to chrome.storage.local on every write via setTierList.
  function getTierList() {
    try {
      const raw = JSON.parse(localStorage.getItem(BH.TIERED_FLOOR) || '[]');
      if (!Array.isArray(raw)) return [];
      return raw
        .filter(t => t && typeof t.dtrade === 'number' && typeof t.dpp === 'number'
          && t.dtrade > 0 && t.dpp >= 0);
    } catch {
      return [];
    }
  }
  function setTierList(list) {
    syncBHSetting(BH.TIERED_FLOOR, JSON.stringify(list));
  }

  // ─── BH settings/cache mirror to chrome.storage.local ───
  // The service worker runs scans on chrome.alarms and reads its config
  // from chrome.storage.local. We mirror every BH setting write here so
  // the SW always sees current values. localStorage stays the panel's
  // source of truth for synchronous UI reads.
  function syncBHSetting(key, value) {
    localStorage.setItem(key, value);
    try { chrome.storage.local.set({ [key]: value }); } catch {}
  }
  function syncAllBHSettings() {
    // One-shot full mirror used on panel inject so a freshly-installed
    // extension (or one whose chrome.storage was wiped) gets a complete
    // settings snapshot before the SW's first scan tick. Includes
    // 'wfaap-my-slug' so the SW can filter the user's own listings out
    // of Ducanator scan results (you can't trade with yourself).
    const keys = [
      BH.ENABLED, BH.INTERVAL, BH.TOP_M, BH.MIN_DPP, BH.MIN_DPT, BH.MIN_TOTAL_D,
      BH.MIN_CACHE_DPP, BH.TIERED_FLOOR, BH.DUCATS_ALLOWED, BH.BLOCKLIST,
      BH.NOTIFY_ENABLED, BH.MIN_TRADE_EFF, BH.SORT_BY, BH.SECONDARY_SORT_BY,
      BH.SOURCE_CACHE, BH.PARTS_CACHE,
      'wfaap-my-slug',
    ];
    const items = {};
    for (const k of keys) {
      const v = localStorage.getItem(k);
      if (v != null) items[k] = v;
    }
    try { chrome.storage.local.set(items); } catch {}
  }

  // Send a message to the background service worker. Wrapped in try/catch
  // because chrome.runtime can be temporarily unavailable mid-update or if
  // the SW errored on startup; non-fatal in either case.
  function sendToSW(message) {
    try {
      chrome.runtime.sendMessage(message, () => { void chrome.runtime.lastError; });
    } catch {}
  }

  // Blocklist helpers — flat array of lowercase seller slugs persisted to
  // localStorage AND mirrored to chrome.storage.local so the SW filters
  // blocklisted sellers out of scan results.
  function getBlocklist() {
    try {
      const raw = JSON.parse(localStorage.getItem(BH.BLOCKLIST) || '[]');
      return Array.isArray(raw) ? raw : [];
    } catch {
      return [];
    }
  }
  function setBlocklist(arr) {
    syncBHSetting(BH.BLOCKLIST, JSON.stringify(arr));
  }
  function addToBlocklist(slug) {
    const s = (slug || '').toLowerCase().trim();
    if (!s) return;
    const list = getBlocklist();
    if (!list.includes(s)) {
      list.push(s);
      setBlocklist(list);
    }
  }
  function removeFromBlocklist(slug) {
    const s = (slug || '').toLowerCase().trim();
    setBlocklist(getBlocklist().filter(x => x !== s));
  }

  // Click a column header (matched by partial wrapper class, e.g.
  // 'ducanator__dpp-sort') until the first two visible rows are in descending
  // order on the column's value (matched by partial cell class, e.g.
  // '__wa--' or 'per-platinum'). The page's sort-state class isn't reliable
  // (we've seen multiple columns simultaneously carrying `down--`), so we
  // verify by observable row order instead.
  async function ensureColumnSortedDescending(wrapperFragment, valueClassFragment, doc = document) {
    const extract = row => {
      const cell = row.querySelector(`[class*="${valueClassFragment}"]`);
      if (!cell) return null;
      const m = (cell.textContent || '').match(/[\d.]+/);
      return m ? parseFloat(m[0]) : null;
    };
    // Take the two rendered rows with the LOWEST data-item-index currently in the
    // DOM (virtuoso only mounts a window — `data-item-index="0"` may not exist if
    // the user has scrolled mid-list). Consecutive indices in the data array still
    // make the desc-vs-asc comparison valid.
    const headOf = () => {
      const rows = [...doc.querySelectorAll('[data-item-index]')];
      if (rows.length < 2) return [null, null];
      rows.sort((a, b) =>
        parseInt(a.getAttribute('data-item-index') || '0', 10) -
        parseInt(b.getAttribute('data-item-index') || '0', 10)
      );
      return [extract(rows[0]), extract(rows[1])];
    };

    for (let attempt = 0; attempt < 3; attempt++) {
      const [v0, v1] = headOf();
      if (v0 == null || v1 == null) return false;
      if (v0 >= v1) return true; // already descending

      const wrapper = doc.querySelector(`[class*="${wrapperFragment}"]`);
      const button = wrapper?.querySelector('[role="button"]');
      if (!button) return false;
      button.click();
      await new Promise(r => setTimeout(r, 300));
    }
    return false;
  }

  // Scrape the Ducanator table: { slug, name, ducats, dpp }
  // The page uses react-virtuoso for virtualized scrolling, so only ~17 rows are
  // mounted at any given time. We scroll the window in steps and dedupe by slug
  // until we have topN unique items (or stop making progress). Scroll position
  // is restored at the end. Assumes the table is sorted by DPP descending — the
  // caller (`refreshSourceCache`) ensures that via `ensureColumnSortedDescending`.
  async function scrapeDucanatorRows(topN, doc = document) {
    const win = doc.defaultView || window;
    const scroller = doc.querySelector('[data-virtuoso-scroller="true"]');

    const seen = new Map();
    function scrapeVisible() {
      const rows = doc.querySelectorAll('[data-item-index]');
      rows.forEach(row => {
        const link = row.querySelector('a[href*="/items/"]');
        if (!link) return;
        const m = (link.getAttribute('href') || '').match(/\/items\/([^/?#]+)/);
        if (!m) return;
        const slug = m[1];
        if (seen.has(slug)) return;

        const nameEl = link.querySelector('[class*="itemName-text"], [class*="itemName"]') || link;
        const name = (nameEl.textContent || '').trim();

        // Ducats: prefer a cell whose class includes "__ducats" and is purely numeric.
        let ducats = null;
        const ducatCell = [...row.querySelectorAll('[class*="__ducats"]')]
          .find(el => el !== row && /^\s*\d+\s*$/.test(el.textContent || ''));
        if (ducatCell) {
          const dm = ducatCell.textContent.match(/\d+/);
          if (dm) ducats = parseInt(dm[0], 10);
        }
        // Fallback: known prime-part ducat denominations in the row text.
        // (For sets, this would miss — but the per-item-ducats fallback is
        // for the original part-only Ducanator. Set ducats are read from
        // the __ducats cell which works for both kinds.)
        if (!ducats) {
          const txt = row.textContent || '';
          const dm = txt.match(/\b(100|65|45|25|15)\b/);
          if (dm) ducats = parseInt(dm[1], 10);
        }
        if (!ducats) return;

        // Page D/p: a numeric cell whose class includes 'per-platinum'. This
        // is the value the page sorts by (descending). Used by the
        // Min D/p (page) filter to cull low-value rows pre-API-call.
        let dpp = null;
        const dppCell = [...row.querySelectorAll('[class*="per-platinum"]')]
          .find(el => /^\s*\d+(?:\.\d+)?\s*$/.test(el.textContent || ''));
        if (dppCell) {
          const dm = dppCell.textContent.match(/[\d.]+/);
          if (dm) dpp = parseFloat(dm[0]);
        }

        seen.set(slug, { slug, name, ducats, dpp });
      });
    }

    const startScrollY = win.scrollY;
    const startScrollerTop = scroller ? scroller.scrollTop : 0;

    scrapeVisible();

    if (scroller && seen.size < topN) {
      const viewport = scroller.querySelector('[data-viewport-type]');
      const useWindow = !viewport || viewport.getAttribute('data-viewport-type') === 'window';

      let stableCount = 0;
      let lastSize = seen.size;
      const MAX_ITERS = Math.max(30, topN * 2);
      for (let i = 0; i < MAX_ITERS && seen.size < topN; i++) {
        if (useWindow) {
          win.scrollBy(0, 600);
        } else {
          scroller.scrollTop += 600;
        }
        await new Promise(r => setTimeout(r, 200));
        scrapeVisible();
        if (seen.size === lastSize) {
          stableCount++;
          if (stableCount >= 4) break;
        } else {
          stableCount = 0;
        }
        lastSize = seen.size;
      }
    }

    // Restore scroll so the user doesn't see the page jump after a scan.
    if (scroller) scroller.scrollTop = startScrollerTop;
    win.scrollTo(0, startScrollY);

    return [...seen.values()].slice(0, topN);
  }

  function injectBargainHunterPanel() {
    if (document.getElementById('wfbh-panel')) return;
    const panel = document.createElement('div');
    panel.id = 'wfbh-panel';
    panel.className = 'wfaap-panel';
    panel.innerHTML = `
      <div class="wfaap-header">
        <span>Ducanator 2.0</span>
        <div class="wfaap-header-controls">
          <label class="wfaap-toggle" title="Enable auto-runs"><input type="checkbox" id="wfbh-enabled"><span class="wfaap-toggle-track"></span></label>
          <button class="wfaap-btn-icon" id="wfbh-collapse" title="Collapse">−</button>
        </div>
      </div>
      <div class="wfaap-body">
        <div class="wfaap-row-label" title="Only evaluate cached rows whose page-table D/p is at or above this. The page sorts by D/p descending, so this is a clean upper-end filter that reflects market value at the time of the last cache refresh. 0 = process every row in cache (up to 500)."><span>Min D/p (page)</span>
          <input id="wfbh-min-cache-dpp" type="number" step="0.1" min="0"></div>
        <div class="wfaap-row-label"><span>Top-M results to show</span>
          <input id="wfbh-top-m" type="number" step="1" min="1"></div>
        <div class="wfaap-row-label"><span>Min ducats/plat</span>
          <input id="wfbh-min-dpp" type="number" step="0.1" min="0"></div>
        <div class="wfaap-row-label" title="Drop result rows whose D/trade (ducats per in-game trade) falls below this. 0 = off."><span>Min ducats/trade</span>
          <input id="wfbh-min-dpt" type="number" step="1" min="0"></div>
        <div class="wfaap-row-label" title="Drop result rows whose total ducats (extracted from K units across all trades) falls below this. 0 = off."><span>Min total ducats</span>
          <input id="wfbh-min-total-d" type="number" step="1" min="0"></div>
        <div class="wfaap-row-label" title="Minimum partial-trade size (out of 6 items per trade). Listings whose last partial trade falls below this are scaled down to drop the partial entirely; if no full trades remain, the listing is excluded. 1 = any non-zero trade OK; 6 = only fully-loaded trades."><span>Min trade efficiency (X/6)</span>
          <input id="wfbh-min-trade-eff" type="number" step="1" min="1" max="6"></div>
        <div class="wfaap-row-label" title="Sort the result list by D/p (page's native ranking), D/trade (ducats per in-game trade, best when trade-limited), or total D (raw ducats from the listing, best for stockpiling)."><span>Sort by</span>
          <select id="wfbh-sort-by">
            <option value="dpp">D/p</option>
            <option value="dpt">D/trade</option>
            <option value="total">total D</option>
          </select>
        </div>
        <div class="wfaap-row-label" title="Secondary sort: when two listings tie on the primary metric, break the tie by this. None = preserve discovery order on ties."><span>Then by</span>
          <select id="wfbh-secondary-sort-by">
            <option value="none">None</option>
            <option value="dpp">D/p</option>
            <option value="dpt">D/trade</option>
            <option value="total">total D</option>
          </select>
        </div>
        <div class="wfaap-row-label" title="Tiered D/p floor: piecewise overrides on Min ducats/plat for high-D/trade listings. Each row is &quot;if D/trade ≥ X, require D/p ≥ Y&quot;. The HIGHEST matching tier wins per listing. Listings whose D/trade is below all tiers fall back to Min ducats/plat."><span>Tiered D/p floor</span>
          <button class="wfaap-run-mini" id="wfbh-tier-add" type="button">+ Add tier</button>
        </div>
        <div id="wfbh-tier-list" class="wfbh-tier-list"></div>
        <div class="wfaap-row-label"><span>Auto-run interval (sec)</span>
          <input id="wfbh-interval" type="number" step="1" min="60"></div>
        <div class="wfaap-row-label" id="wfbh-ducats-row" title="Restrict which prime-part ducat denominations pass. Sets are always exempt (their ducats are sums, not single denominations). All checked = no filter."><span>Ducats (item)</span>
          <div class="wfbh-ducats-group" id="wfbh-ducats-group">
            <label><input type="checkbox" data-ducats="15">15</label>
            <label><input type="checkbox" data-ducats="25">25</label>
            <label><input type="checkbox" data-ducats="45">45</label>
            <label><input type="checkbox" data-ducats="65">65</label>
            <label><input type="checkbox" data-ducats="100">100</label>
          </div>
        </div>
        <div class="wfaap-row-label" title="Show a Windows notification when a Ducanator scan turns up at least one fresh deal that hasn't been notified about in the last hour. Click the notification to focus this tab and copy the top deal's whisper to clipboard. Notifications fire even when this tab is closed (the service worker handles scans on a chrome.alarms timer)."><span>Notify on new deals</span>
          <input id="wfbh-notify-enabled" type="checkbox"></div>
        <div class="wfaap-row-label" title="Manually refresh the cached source list (up to 500 rows). The cache backs every scan, so scans work even when this tab is closed (the service worker reads the cache from chrome.storage). Refreshing requires the tab to be visible (the page's virtualized list won't render rows otherwise)."><span>Source cache</span>
          <button class="wfaap-run-mini" id="wfbh-cache-refresh" type="button">Refresh</button></div>
        <div class="wfaap-meta" id="wfbh-cache-info">Cache: empty</div>
        <button class="wfaap-run" id="wfbh-run">Run Now</button>
        <div class="wfaap-meta" id="wfbh-meta">Auto-run off</div>
        <div class="wfaap-status" id="wfbh-status">Idle.</div>
        <div class="wfaap-results" id="wfbh-results"></div>
        <details class="wfaap-blocklist-details" id="wfbh-blocklist-section">
          <summary>Blocklist (<span id="wfbh-blocklist-count">0</span>)</summary>
          <div id="wfbh-blocklist-body" class="wfaap-blocklist-body"></div>
        </details>
      </div>
    `;
    document.body.appendChild(panel);

    const minCacheDppInput = panel.querySelector('#wfbh-min-cache-dpp');
    minCacheDppInput.value = localStorage.getItem(BH.MIN_CACHE_DPP) || String(BH.DEFAULT_MIN_CACHE_DPP);
    minCacheDppInput.addEventListener('input', () => syncBHSetting(BH.MIN_CACHE_DPP, minCacheDppInput.value));

    const topMInput = panel.querySelector('#wfbh-top-m');
    topMInput.value = localStorage.getItem(BH.TOP_M) || String(BH.DEFAULT_TOP_M);
    topMInput.addEventListener('input', () => syncBHSetting(BH.TOP_M, topMInput.value));

    const minTradeEffInput = panel.querySelector('#wfbh-min-trade-eff');
    minTradeEffInput.value = localStorage.getItem(BH.MIN_TRADE_EFF) || String(BH.DEFAULT_MIN_TRADE_EFF);
    minTradeEffInput.addEventListener('input', () => syncBHSetting(BH.MIN_TRADE_EFF, minTradeEffInput.value));

    // Validate persisted select values against current options. Otherwise
    // a removed option (like the old 'composite') leaves the select rendered
    // empty after upgrades, since assigning an unknown value to a <select>
    // results in no option being selected.
    const sortBySelect = panel.querySelector('#wfbh-sort-by');
    const validSorts = new Set(['dpp', 'dpt', 'total']);
    const persistedSort = localStorage.getItem(BH.SORT_BY);
    sortBySelect.value = validSorts.has(persistedSort) ? persistedSort : BH.DEFAULT_SORT_BY;
    if (sortBySelect.value !== persistedSort) syncBHSetting(BH.SORT_BY, sortBySelect.value);

    const secondarySortBySelect = panel.querySelector('#wfbh-secondary-sort-by');
    const validSecondarySorts = new Set(['none', 'dpp', 'dpt', 'total']);
    const persistedSecondary = localStorage.getItem(BH.SECONDARY_SORT_BY);
    secondarySortBySelect.value = validSecondarySorts.has(persistedSecondary) ? persistedSecondary : BH.DEFAULT_SECONDARY_SORT_BY;
    if (secondarySortBySelect.value !== persistedSecondary) syncBHSetting(BH.SECONDARY_SORT_BY, secondarySortBySelect.value);

    // Disable the Then-by option that matches the current Sort-by primary
    // (it'd be a no-op tiebreaker). If Then-by was already pointing at the
    // newly-disabled option, reset it to 'none'.
    function refreshSecondaryOptions() {
      const primary = sortBySelect.value;
      for (const opt of secondarySortBySelect.options) {
        opt.disabled = (opt.value !== 'none' && opt.value === primary);
      }
      if (secondarySortBySelect.value === primary && primary !== 'none') {
        secondarySortBySelect.value = 'none';
        syncBHSetting(BH.SECONDARY_SORT_BY, 'none');
      }
    }
    refreshSecondaryOptions();

    sortBySelect.addEventListener('change', () => {
      syncBHSetting(BH.SORT_BY, sortBySelect.value);
      refreshSecondaryOptions();
    });
    secondarySortBySelect.addEventListener('change', () => syncBHSetting(BH.SECONDARY_SORT_BY, secondarySortBySelect.value));

    // Tiered D/p floor: dynamic add/remove rows. Each row has D/trade ≥ X
    // and D/p ≥ Y inputs. Rows with non-positive values are ignored at
    // scan time. The list is persisted as JSON; render rebuilds on change.
    const tierListEl = panel.querySelector('#wfbh-tier-list');
    const tierAddBtn = panel.querySelector('#wfbh-tier-add');
    function renderTierList() {
      const tiers = getTierList();
      if (tiers.length === 0) {
        tierListEl.innerHTML = '<div class="wfbh-tier-empty">No tiers, base Min ducats/plat applies to all listings.</div>';
        return;
      }
      tierListEl.innerHTML = tiers.map((t, i) => `
        <div class="wfbh-tier-row" data-idx="${i}">
          <span>D/trade ≥</span>
          <input type="number" step="1" min="1" class="wfbh-tier-dtrade" value="${t.dtrade}">
          <span>→ D/p ≥</span>
          <input type="number" step="0.1" min="0" class="wfbh-tier-dpp" value="${t.dpp}">
          <button class="wfbh-tier-remove" type="button" title="Remove this tier">×</button>
        </div>
      `).join('');
    }
    tierAddBtn.addEventListener('click', () => {
      const tiers = getTierList();
      tiers.push({ dtrade: 270, dpp: 10 });
      setTierList(tiers);
      renderTierList();
    });
    // Delegated input handler — saves on every keystroke; remove handler deletes.
    tierListEl.addEventListener('input', (e) => {
      const row = e.target.closest('.wfbh-tier-row');
      if (!row) return;
      const idx = parseInt(row.dataset.idx, 10);
      const tiers = getTierList();
      if (!Number.isFinite(idx) || idx < 0 || idx >= tiers.length) return;
      const dtradeEl = row.querySelector('.wfbh-tier-dtrade');
      const dppEl = row.querySelector('.wfbh-tier-dpp');
      tiers[idx] = {
        dtrade: parseFloat(dtradeEl.value) || 0,
        dpp: parseFloat(dppEl.value) || 0,
      };
      setTierList(tiers);
    });
    tierListEl.addEventListener('click', (e) => {
      if (!e.target.classList.contains('wfbh-tier-remove')) return;
      const row = e.target.closest('.wfbh-tier-row');
      if (!row) return;
      const idx = parseInt(row.dataset.idx, 10);
      const tiers = getTierList();
      if (!Number.isFinite(idx) || idx < 0 || idx >= tiers.length) return;
      tiers.splice(idx, 1);
      setTierList(tiers);
      renderTierList();
    });
    renderTierList();

    const minDppInput = panel.querySelector('#wfbh-min-dpp');
    minDppInput.value = localStorage.getItem(BH.MIN_DPP) || String(BH.DEFAULT_MIN_DPP);
    minDppInput.addEventListener('input', () => syncBHSetting(BH.MIN_DPP, minDppInput.value));

    const minDptInput = panel.querySelector('#wfbh-min-dpt');
    minDptInput.value = localStorage.getItem(BH.MIN_DPT) || String(BH.DEFAULT_MIN_DPT);
    minDptInput.addEventListener('input', () => syncBHSetting(BH.MIN_DPT, minDptInput.value));

    const minTotalDInput = panel.querySelector('#wfbh-min-total-d');
    minTotalDInput.value = localStorage.getItem(BH.MIN_TOTAL_D) || String(BH.DEFAULT_MIN_TOTAL_D);
    minTotalDInput.addEventListener('input', () => syncBHSetting(BH.MIN_TOTAL_D, minTotalDInput.value));


    // Ducats(item) checkboxes — restrict which prime-part denominations
    // pass through. Stored as a comma-separated string of selected values;
    // an empty list (all unchecked) is treated as "filter off" downstream
    // so the user doesn't accidentally drop every part.
    const ducatsGroup = panel.querySelector('#wfbh-ducats-group');
    const ducatsAllowedRaw = localStorage.getItem(BH.DUCATS_ALLOWED);
    const ducatsAllowedInit = ducatsAllowedRaw == null ? BH.DEFAULT_DUCATS_ALLOWED : ducatsAllowedRaw;
    const ducatsInitSet = new Set(ducatsAllowedInit.split(',').map(s => parseInt(s, 10)).filter(n => Number.isFinite(n)));
    ducatsGroup.querySelectorAll('input[type="checkbox"][data-ducats]').forEach(cb => {
      const v = parseInt(cb.dataset.ducats, 10);
      cb.checked = ducatsInitSet.has(v);
    });
    ducatsGroup.addEventListener('change', () => {
      const selected = [...ducatsGroup.querySelectorAll('input[type="checkbox"][data-ducats]:checked')]
        .map(cb => cb.dataset.ducats);
      syncBHSetting(BH.DUCATS_ALLOWED, selected.join(','));
    });

    const intervalInput = panel.querySelector('#wfbh-interval');
    intervalInput.value = localStorage.getItem(BH.INTERVAL) || String(BH.DEFAULT_INTERVAL);
    intervalInput.addEventListener('input', () => {
      syncBHSetting(BH.INTERVAL, intervalInput.value);
      // Re-arm the SW alarm so the new period takes effect immediately.
      sendToSW({ type: 'wfbh-set-schedule' });
    });

    const enabledInput = panel.querySelector('#wfbh-enabled');
    enabledInput.checked = localStorage.getItem(BH.ENABLED) === '1';
    enabledInput.addEventListener('change', () => {
      const enabled = enabledInput.checked;
      syncBHSetting(BH.ENABLED, enabled ? '1' : '0');
      refreshBargainHunterMeta(panel);
      // Tell the SW to (re)arm or clear the alarm based on the new state.
      sendToSW({ type: 'wfbh-set-schedule' });
      // Trigger an immediate scan when flipping on so the user sees results
      // without waiting for the first alarm tick.
      if (enabled) sendToSW({ type: 'wfbh-run-now' });
    });

    const collapseBtn = panel.querySelector('#wfbh-collapse');
    if (localStorage.getItem(BH.COLLAPSED) === '1') {
      panel.classList.add('collapsed');
      collapseBtn.textContent = '+';
    }
    collapseBtn.addEventListener('click', () => {
      const collapsed = panel.classList.toggle('collapsed');
      collapseBtn.textContent = collapsed ? '+' : '−';
      localStorage.setItem(BH.COLLAPSED, collapsed ? '1' : '0');
    });

    // Manual Run Now: triggers a scan in the SW (which is the only place
    // scan logic lives now). The SW broadcasts status + results back via
    // chrome.runtime.sendMessage which the listener below renders.
    panel.querySelector('#wfbh-run').addEventListener('click', () => {
      const status = panel.querySelector('#wfbh-status');
      if (status) status.textContent = 'Requesting scan from background...';
      sendToSW({ type: 'wfbh-run-now' });
    });

    // Notify-on-new-deals toggle (defaults ON). Persisted to localStorage
    // and mirrored to chrome.storage.local so the SW honours the setting.
    const notifyEnabledInput = panel.querySelector('#wfbh-notify-enabled');
    const notifyRaw = localStorage.getItem(BH.NOTIFY_ENABLED);
    notifyEnabledInput.checked = notifyRaw == null ? BH.DEFAULT_NOTIFY_ENABLED : notifyRaw === '1';
    notifyEnabledInput.addEventListener('change', () => {
      syncBHSetting(BH.NOTIFY_ENABLED, notifyEnabledInput.checked ? '1' : '0');
    });

    // Source-cache refresh button. Manually-triggered foreground scrape of
    // up to 500 rows; the resulting list backs every regular scan from then on
    // (so scans work in hidden tabs without needing the page rendered).
    panel.querySelector('#wfbh-cache-refresh').addEventListener('click', () => refreshSourceCache(panel));
    updateCacheInfoDisplay(panel);

    // Delegated click handler on the results container. Handles three links:
    //  - [block]  → adds seller to blocklist + removes their rows from results
    //  - [/w]     → copies a pre-formatted whisper to the clipboard
    //  - [+rep]   → POSTs a positive review on the seller's profile
    // (no confirmation prompt — fires on click, debounced via data-busy).
    panel.querySelector('#wfbh-results').addEventListener('click', (e) => {
      const target = e.target;
      if (!target || !target.classList) return;

      if (target.classList.contains('wfaap-block-seller')) {
        e.preventDefault();
        const slug = target.dataset.slug;
        if (slug) {
          addToBlocklist(slug);
          const sel = `.wfaap-block-seller[data-slug="${CSS.escape(slug)}"]`;
          panel.querySelectorAll(sel).forEach(el => el.closest('.wfaap-rec')?.remove());
          updateBlocklistDisplay(panel);
        }
        return;
      }

      if (target.classList.contains('wfaap-copy-msg')) {
        e.preventDefault();
        const message = target.dataset.message || '';
        if (!message) return;
        const original = target.textContent;
        const flash = (label) => {
          target.textContent = label;
          target.classList.add('copied');
          setTimeout(() => {
            target.textContent = original;
            target.classList.remove('copied');
          }, 1200);
        };
        // Prefer the async clipboard API; fall back to a hidden textarea +
        // execCommand if it isn't available (e.g., older browsers, or when
        // the document hasn't been clicked yet — should be fine here since
        // this fires from a click event).
        const fallback = () => {
          const ta = document.createElement('textarea');
          ta.value = message;
          ta.style.position = 'fixed';
          ta.style.opacity = '0';
          document.body.appendChild(ta);
          ta.select();
          let ok = false;
          try { ok = document.execCommand('copy'); } catch (_) {}
          document.body.removeChild(ta);
          flash(ok ? 'copied!' : 'copy failed');
        };
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(message).then(
            () => flash('copied!'),
            () => fallback()
          );
        } else {
          fallback();
        }
        return;
      }

      if (target.classList.contains('wfaap-rep-seller')) {
        e.preventDefault();
        if (target.dataset.busy === '1') return; // debounce double-clicks
        const sellerSlug = target.dataset.slug;
        if (!sellerSlug) return;
        const original = target.textContent;
        target.dataset.busy = '1';
        target.textContent = 'rep...';
        postReview(sellerSlug, BH.REVIEW_TEXT)
          .then(() => {
            target.textContent = "rep'd!";
            target.classList.add('copied');
            setTimeout(() => {
              target.textContent = original;
              target.classList.remove('copied');
              target.dataset.busy = '0';
            }, 1500);
          })
          .catch((err) => {
            target.textContent = `failed (${String(err.message || err).slice(0, 40)})`;
            target.style.color = '#f87171';
            setTimeout(() => {
              target.textContent = original;
              target.style.color = '';
              target.dataset.busy = '0';
            }, 2500);
          });
      }
    });

    // Blocklist remove buttons: delegated click on the blocklist body.
    panel.querySelector('#wfbh-blocklist-body').addEventListener('click', (e) => {
      const target = e.target;
      if (target && target.classList && target.classList.contains('wfaap-blocklist-remove')) {
        const slug = target.dataset.slug;
        if (slug) {
          removeFromBlocklist(slug);
          updateBlocklistDisplay(panel);
        }
      }
    });

    updateBlocklistDisplay(panel);
    makeDraggable(panel, panel.querySelector('.wfaap-header'));

    // Listen for messages from the service worker:
    //   copy-whisper       — SW round-tripping clipboard write after notif click
    //   wfbh-scan-status   — progress text during a scan
    //   wfbh-scan-results  — final results array + summary text
    //   wfbh-scan-error    — fatal scan error to surface in the status line
    if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
      chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
        if (!msg || !msg.type) return false;

        if (msg.type === 'copy-whisper') {
          writeWhisperToClipboard(String(msg.text || ''), sendResponse);
          return true;
        }

        if (msg.type === 'wfbh-scan-status') {
          const status = panel.querySelector('#wfbh-status');
          if (status) status.textContent = String(msg.text || '');
          return false;
        }

        if (msg.type === 'wfbh-scan-results') {
          const status = panel.querySelector('#wfbh-status');
          const results = panel.querySelector('#wfbh-results');
          const sortBy = localStorage.getItem(BH.SORT_BY) || BH.DEFAULT_SORT_BY;
          const display = buildBHRecsForDisplay(msg.recs || [], sortBy);
          if (results) renderRecs(results, display);
          if (status) status.textContent = String(msg.statusText || '');
          panel._wfbhLatestResults = msg.recs || [];
          return false;
        }

        if (msg.type === 'wfbh-scan-error') {
          const status = panel.querySelector('#wfbh-status');
          if (status) status.textContent = String(msg.error || 'Scan error');
          return false;
        }

        return false;
      });
    }
  }

  // Shared helper for both the on-init pending whisper and the SW-triggered
  // copy-whisper message. `done` is called with {ok: bool, fallback?: bool, error?: string}.
  function writeWhisperToClipboard(text, done) {
    if (!text) { done?.({ ok: false }); return; }
    const fallback = () => {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        done?.({ ok: true, fallback: true });
      } catch (err) {
        done?.({ ok: false, error: String(err.message || err) });
      }
    };
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text)
        .then(() => done?.({ ok: true }))
        .catch(() => fallback());
      return;
    }
    fallback();
  }

  // Convert the SW's scan-result objects (slug, name, ducats, ingamePrice,
  // K, dpp, dPerTrade, totalD, totalTrades, breakdownStr, sellerName,
  // sellerSlug, isSet, whisperText) into the {name, kind, ratio, unit,
  // ratio2, unit2, detail} shape that renderRecs expects. Detail HTML
  // includes [block] [/w] [+rep] links plus item/seller links — the page's
  // delegated click handlers wire them up.
  function buildBHRecsForDisplay(recs, sortBy) {
    return recs.map(e => {
      // Show whichever of {D/trade, total D} the user did NOT sort by, so
      // they always see all three metrics on screen (D/p in name line,
      // primary metric implied by sort, secondary metric in the ratio2 slot).
      const showTotalSecondary = sortBy === 'total';
      const ratio2Val = showTotalSecondary ? e.totalD : e.dPerTrade;
      const unit2Str = showTotalSecondary ? 'D total' : 'D/trade';
      let breakdownLine = e.breakdownStr;
      if (e.totalTrades > 1) {
        breakdownLine += showTotalSecondary
          ? ` · ${e.dPerTrade}D/trade`
          : ` · ${e.totalD}D total`;
      }
      const ducatsNoun = e.isSet ? 'D/set' : 'D each';
      return {
        name: e.name,
        kind: 'deal',
        ratio: e.dpp,
        unit: 'D/p',
        ratio2: ratio2Val,
        unit2: unit2Str,
        detail: `${breakdownLine} · ${e.ingamePrice}p × ${e.quantity} (seller <a href="/profile/${encodeURIComponent(e.sellerSlug || e.sellerName)}" target="_blank">${escapeHtml(e.sellerName)}</a> <a href="#" class="wfaap-block-seller" data-slug="${escapeHtml(e.sellerSlug || '')}" title="Add seller to blocklist">[block]</a> <a href="#" class="wfaap-copy-msg" data-message="${escapeHtml(e.whisperText || '')}" title="Copy whisper message to clipboard">[/w]</a> <a href="#" class="wfaap-rep-seller" data-slug="${escapeHtml(e.sellerSlug || '')}" title="Post a positive review on this seller's profile">[+rep]</a>) · ${e.ducats} ${ducatsNoun} · <a href="/items/${encodeURIComponent(e.slug)}" target="_blank">view item</a>`,
      };
    });
  }

  // Render the blocklist entries (with remove buttons) and update the count
  // shown next to the <details> summary.
  function updateBlocklistDisplay(panel) {
    const list = getBlocklist();
    const countEl = panel.querySelector('#wfbh-blocklist-count');
    const bodyEl = panel.querySelector('#wfbh-blocklist-body');
    if (countEl) countEl.textContent = String(list.length);
    if (!bodyEl) return;
    if (list.length === 0) {
      bodyEl.innerHTML = '<div class="wfaap-blocklist-empty">Blocklist empty.</div>';
      return;
    }
    bodyEl.innerHTML = list.map(slug => `
      <div class="wfaap-blocklist-row">
        <a href="/profile/${encodeURIComponent(slug)}" target="_blank">${escapeHtml(slug)}</a>
        <button class="wfaap-blocklist-remove" data-slug="${escapeHtml(slug)}" title="Remove from blocklist">×</button>
      </div>
    `).join('');
  }

  // Ducanator 2.0 doesn't gate on online/ingame status — finding deals
  // works from any session, so the meta line just reflects the auto-run toggle.
  function refreshBargainHunterMeta(panel) {
    const enabled = localStorage.getItem(BH.ENABLED) === '1';
    const meta = panel.querySelector('#wfbh-meta');
    if (meta) meta.textContent = enabled ? 'Auto-run on' : 'Auto-run off';
  }

  // Scheduling lives in the service worker (chrome.alarms) now, not here.
  // Local setInterval/setTimeout get throttled to seconds-resolution and
  // frozen entirely when the tab is hidden long enough; chrome.alarms keep
  // firing on time regardless of tab focus state. The panel just tells the
  // SW when to (re)arm or clear the alarm via wfbh-set-schedule messages.

  // Update the "Cache: N rows · Xh ago" line based on current localStorage.
  function updateCacheInfoDisplay(panel) {
    const el = panel.querySelector('#wfbh-cache-info');
    if (!el) return;
    const cache = getSourceCache();
    if (!cache) {
      el.textContent = 'Cache: empty. Click Refresh to build it.';
      return;
    }
    const ageMs = Date.now() - cache.ts;
    let ageStr;
    if (ageMs < 60_000) ageStr = `${Math.round(ageMs / 1000)}s ago`;
    else if (ageMs < 3_600_000) ageStr = `${Math.round(ageMs / 60_000)}m ago`;
    else if (ageMs < 86_400_000) ageStr = `${Math.round(ageMs / 3_600_000)}h ago`;
    else ageStr = `${Math.round(ageMs / 86_400_000)}d ago`;
    el.textContent = `Cache: ${cache.items.length} rows · ${ageStr}`;
  }

  // Manual cache refresh — foreground only (page must be painted for the
  // virtuoso scrape to mount rows). Runs auto-sort, scrapes up to
  // SOURCE_CACHE_SIZE rows, then fetches parts data for any new sets in
  // the source list and folds them into the parts cache. All persisted.
  async function refreshSourceCache(panel) {
    const status = panel.querySelector('#wfbh-status');
    const refreshBtn = panel.querySelector('#wfbh-cache-refresh');
    if (document.hidden) {
      status.textContent = 'Cache refresh requires this tab to be visible (the page only renders rows when visible). Switch to this tab and try again.';
      return;
    }
    refreshBtn.disabled = true;
    status.textContent = `Refreshing source cache (scraping up to ${BH.SOURCE_CACHE_SIZE} rows)...`;
    try {
      await ensureColumnSortedDescending('ducanator__dpp-sort', 'per-platinum');
      const scraped = await scrapeDucanatorRows(BH.SOURCE_CACHE_SIZE, document);
      if (!scraped || scraped.length === 0) {
        status.textContent = 'Cache refresh failed: no rows scraped. Is the Ducanator table loaded?';
        return;
      }
      setSourceCache({ ts: Date.now(), items: scraped });
      updateCacheInfoDisplay(panel);

      // Backfill parts data for any sets we don't already have a count for.
      // /v2/items/{slug} per set, paced PACE_MS apart. Cached forever once
      // fetched (set composition only changes on new prime releases).
      const isSetSlug = s => /_set$/i.test(s || '');
      const partsCache = getPartsCache();
      const setsToFetch = scraped
        .filter(it => isSetSlug(it.slug))
        .map(it => it.slug)
        .filter(slug => !(slug in partsCache));
      if (setsToFetch.length > 0) {
        for (let i = 0; i < setsToFetch.length; i++) {
          status.textContent = `Fetching set parts data ${i + 1}/${setsToFetch.length}: ${setsToFetch[i]}`;
          await fetchPartsForSet(setsToFetch[i]);
          if (i < setsToFetch.length - 1) await sleep(PACE_MS);
        }
        status.textContent = `Source cache refreshed: ${scraped.length} rows · backfilled parts data for ${setsToFetch.length} new set${setsToFetch.length === 1 ? '' : 's'}.`;
      } else {
        status.textContent = `Source cache refreshed: ${scraped.length} rows · all sets already in parts cache.`;
      }
    } catch (err) {
      status.textContent = `Cache refresh error: ${err.message || err}`;
    } finally {
      refreshBtn.disabled = false;
    }
  }

  // Scan logic lives in the service worker (background.js). The panel sends
  // wfbh-run-now for manual runs; the SW broadcasts wfbh-scan-status and
  // wfbh-scan-results back to all open Ducanator tabs as the scan
  // progresses. See the chrome.runtime.onMessage listener above for the
  // receiver side. This keeps scans firing on chrome.alarms even when the
  // tab is hidden, throttled, or fully closed.

  async function initBargainHunter() {
    injectBargainHunterPanel();
    const panel = document.getElementById('wfbh-panel');
    if (!panel) return;

    // One-shot mirror of every BH setting + cache to chrome.storage.local
    // so the SW has a complete snapshot from the get-go (covers fresh
    // installs and the case where chrome.storage was wiped but localStorage
    // wasn't, e.g. extension reinstall on the same profile).
    syncAllBHSettings();

    refreshBargainHunterMeta(panel);

    // Tab handshake with the SW. If a notification fired while no
    // Ducanator tab was open, the SW opened this tab and queued the
    // top deal's whisper text under PENDING_WHISPER_KEY. Pull and consume.
    sendToSWAndAwait({ type: 'wfbh-tab-hello' }).then((resp) => {
      if (resp?.pendingWhisper) {
        writeWhisperToClipboard(resp.pendingWhisper, () => {});
      }
    }).catch(() => {});

    if (localStorage.getItem(BH.ENABLED) === '1') {
      // Make sure the SW alarm is in sync with current settings (the alarm
      // may have been cleared by an extension reload), and request an
      // immediate scan so the panel shows fresh results without waiting.
      sendToSW({ type: 'wfbh-set-schedule' });
      sendToSW({ type: 'wfbh-run-now' });
      const status = panel.querySelector('#wfbh-status');
      if (status) status.textContent = 'Requesting scan from background...';
    }
  }

  // Thin Promise wrapper around chrome.runtime.sendMessage for cases where
  // we want the SW's response (vs. fire-and-forget via sendToSW).
  function sendToSWAndAwait(message) {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage(message, (resp) => {
          if (chrome.runtime.lastError) return reject(chrome.runtime.lastError);
          resolve(resp);
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  // ════════════════════════════════════════════════════════════
  // INIT DISPATCH
  // ════════════════════════════════════════════════════════════
  async function init() {
    injectSharedCss();

    // Dynamic Price Automator: only on the cached profile URL. The user
    // claims their profile once via injectClaimProfilePrompt; from then on
    // we only inject the panel when the URL slug matches the cached slug.
    if (isProfilePage()) {
      const cached = getCachedMySlug();
      const urlSlug = getUrlProfileSlug();
      if (!cached) {
        injectClaimProfilePrompt(urlSlug);
      } else if (cached === urlSlug) {
        initAutoPricer();
      }
      return;
    }

    // Ducanator 2.0: only on the Ducanator page itself.
    if (isDucanatorPage()) {
      initBargainHunter();
    }
  }

  if (document.body) init();
  else document.addEventListener('DOMContentLoaded', init);
})();
