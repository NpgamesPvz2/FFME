(() => {
  if (window.__fbTimeMarkerV074) return;
  window.__fbTimeMarkerV074 = true;

  const SYNC_KEYS = ['fbTimeFilterStart', 'fbTimeFilterEnabled'];
  // Remove records left by older versions; this build never writes post data.
  try { chrome.storage.local.remove(['fbTimeFilterCaptured', 'fbTimeMarkerDataVersion']); } catch { /* Ignore cleanup if storage is unavailable. */ }
  const hoverRetryDelays = [80, 160, 300, 500, 800, 1200, 1800, 2600];
  let settings = { start: NaN, enabled: false };
  let currentAnchor = null;
  let currentHoverTarget = null;
  let currentCard = null;
  let hoverAt = 0;
  let hoverRetryTimer = 0;
  let hoverRetryIndex = 0;
  let hoverObserver = null;
  let hoverObserverStopTimer = 0;
  let mutationTimer = 0;
  let applying = false;
  const queuedNodes = new Set();

  const cleanUrl = (raw) => {
    try {
      const u = new URL(raw, location.href);
      if (!/(^|\.)facebook\.com$/i.test(u.hostname)) return '';
      const path = u.pathname.replace(/\/$/, '') || '/';
      // Group-feed permalink links use the group URL plus multi_permalinks=<post id>.
      // Normalize these URLs so tracking parameters do not make one post look like several.
      if (/\/groups\//i.test(path) && u.searchParams.has('multi_permalinks')) {
        return u.origin + path + '?multi_permalinks=' + encodeURIComponent(u.searchParams.get('multi_permalinks'));
      }
      return u.origin + path + u.search;
    } catch { return ''; }
  };
  function isPostUrl(raw) {
    try {
      const u = new URL(raw, location.href);
      if (!/(^|\.)facebook\.com$/i.test(u.hostname)) return false;
      return /\/posts\/|\/permalink\/|photo\.php|\/watch\/?$|\/reel\/|\/videos\/|\/story\.php/i.test(u.pathname) ||
        u.searchParams.has('story_fbid') || (/\/groups\//i.test(u.pathname) && u.searchParams.has('multi_permalinks'));
    } catch { return false; }
  }
  function validDate(d, y, m, day) {
    const now = Date.now();
    return Number.isFinite(d.getTime()) && d.getFullYear() === y && d.getMonth() === m - 1 && d.getDate() === day && d.getTime() <= now + 86400000 && d.getTime() >= now - 10 * 366 * 86400000;
  }
  function parseDateText(raw) {
    const s = String(raw || '').replace(/[\u200B-\u200F\u2060\uFEFF]/g, '').replace(/\s+/g, ' ').trim();
    if (!s || s.length > 300) return null;
    const iso = s.match(/\b(20\d{2})-(\d{1,2})-(\d{1,2})[T ](\d{1,2}):(\d{2})(?::(\d{2}))?/);
    if (iso) {
      const explicitZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(s);
      const d = explicitZone ? new Date(s) : new Date(+iso[1], +iso[2] - 1, +iso[3], +iso[4], +iso[5], +(iso[6] || 0));
      if (Number.isFinite(d.getTime()) && (explicitZone || validDate(d, +iso[1], +iso[2], +iso[3]))) return d;
    }
    const vi = s.match(/(\d{1,2})\s+tháng\s+(\d{1,2}),?\s*(20\d{2}).*?(\d{1,2}):(\d{2})/i);
    if (vi) {
      const d = new Date(+vi[3], +vi[2] - 1, +vi[1], +vi[4], +vi[5]);
      if (validDate(d, +vi[3], +vi[2], +vi[1])) return d;
    }
    const unix = s.match(/^\s*(\d{10,13})\s*$/);
    if (unix) {
      const n = Number(unix[1]);
      const d = new Date(n < 1e12 ? n * 1000 : n);
      if (Number.isFinite(d.getTime()) && d.getTime() <= Date.now() + 86400000 && d.getTime() >= Date.now() - 10 * 366 * 86400000) return d;
    }
    return null;
  }
  function labelForAnchor(anchor) {
    if (!anchor) return '';
    return (anchor.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean)
      .map(id => document.getElementById(id)).filter(Boolean)
      .map(el => (el.innerText || el.textContent || '').trim()).join(' ');
  }
  function isRelativeTimeLabel(text) {
    return /(?:\b\d+\s*(?:giây|phút|giờ|ngày|tuần|tháng|năm)\s+trước\b|\b(?:vừa xong|hôm qua|hôm kia|yesterday|just now|\d+\s+(?:seconds?|minutes?|hours?|days?|weeks?|months?|years?)\s+ago)\b)/i.test(text || '');
  }
  function isTimestampAnchor(anchor) {
    if (!anchor) return false;
    const label = labelForAnchor(anchor);
    const ownText = (anchor.innerText || anchor.textContent || '').trim();
    return isRelativeTimeLabel(label) || !!parseDateText(label) || !!parseDateText(ownText) ||
      !!parseDateText(anchor.getAttribute('aria-label') || '') || !!parseDateText(anchor.getAttribute('title') || '') ||
      ['datetime', 'data-utime', 'data-timestamp'].some(attr => anchor.hasAttribute(attr));
  }
  function hasNearbyTimeLabel(anchor) {
    // Some Facebook timestamp links receive aria-labelledby/title only after the first hover.
    // Before hovering, inspect only a few short neighboring nodes—not the whole post text.
    let node = anchor?.parentElement;
    for (let depth = 0; node && depth < 3; depth++, node = node.parentElement) {
      const children = node.children ? Array.from(node.children) : [];
      for (const child of children) {
        if (child === anchor || child.contains?.(anchor)) continue;
        const text = (child.innerText || child.textContent || '').trim();
        if (text.length <= 100 && (isRelativeTimeLabel(text) || !!parseDateText(text))) return true;
      }
      const own = (node.innerText || '').trim();
      if (own.length > 350) break;
    }
    return false;
  }
  function isPotentialTimestampAnchor(anchor) {
    return isTimestampAnchor(anchor) || (!!anchor?.href && isPostUrl(anchor.href) && hasNearbyTimeLabel(anchor));
  }
  function findTimestampAnchorFromTarget(target) {
    const direct = target?.closest?.('a[href]');
    if (direct && isPotentialTimestampAnchor(direct)) return direct;

    // In group-feed markup, the visible relative-time label can be a sibling of the
    // permalink anchor (the anchor points back to the label with aria-labelledby).
    // Pointer events land on the label, not on the anchor, so resolve that relationship.
    let node = target?.nodeType === Node.ELEMENT_NODE ? target : target?.parentElement;
    for (let depth = 0; node && depth < 5; depth++, node = node.parentElement) {
      if (!node.id) continue;
      const id = node.id;
      const linked = [...document.querySelectorAll('a[href][aria-labelledby]')].find(a =>
        (a.getAttribute('aria-labelledby') || '').split(/\s+/).includes(id)
      );
      if (linked && isPotentialTimestampAnchor(linked)) return linked;
    }
    return null;
  }
  function isCurrentHoverActive(anchor) {
    return !!(anchor?.matches?.(':hover') ||
      (currentHoverTarget?.isConnected && currentHoverTarget.matches?.(':hover')));
  }
  function findCard(anchor) {
    if (!anchor) return null;
    const candidates = [];
    const feedUnit = anchor.closest?.('[data-pagelet^="FeedUnit"]');
    const article = anchor.closest?.('[role="article"]');
    if (feedUnit) candidates.push(feedUnit);
    if (article && article !== feedUnit) candidates.push(article);
    const validSinglePost = node => {
      if (!node || node === document.body || node === document.documentElement) return false;
      const length = (node.innerText || '').trim().length;
      if (length < 80 || length > 18000) return false;
      const urls = new Set();
      let count = 0;
      for (const a of node.querySelectorAll('a[href]')) {
        if (!isPostUrl(a.href)) continue;
        const key = cleanUrl(a.href);
        if (key) urls.add(key);
        if (urls.size > 1 || ++count > 100) return false;
      }
      return urls.size === 1 || (urls.size === 0 && node === article);
    };
    for (const node of candidates) if (validSinglePost(node)) return node;
    let node = anchor.parentElement;
    let best = null;
    for (let i = 0; node && i < 12; i++, node = node.parentElement) {
      if (node.matches?.('[role="main"], body, #facebook')) break;
      const length = (node.innerText || '').trim().length;
      if (length > 18000) break;
      let found = '';
      for (const a of node.querySelectorAll('a[href]')) {
        if (!isPostUrl(a.href)) continue;
        const key = cleanUrl(a.href);
        if (!key) continue;
        if (found && found !== key) { found = '__multiple__'; break; }
        found = key;
      }
      if (found === '__multiple__') break;
      if (found && length >= 80) best = node;
    }
    return best;
  }
  function timestampFromAnchor(anchor) {
    if (!anchor) return null;
    for (const id of (anchor.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean)) {
      const label = document.getElementById(id);
      const text = (label?.innerText || label?.textContent || '').trim();
      const date = parseDateText(text);
      if (date) return { date, text };
    }
    for (const attr of ['datetime', 'data-utime', 'data-timestamp', 'aria-label', 'title', 'data-tooltip-content']) {
      const val = anchor.getAttribute(attr);
      if (!val) continue;
      let date = null;
      if ((attr === 'data-utime' || attr === 'data-timestamp') && /^\d{9,13}$/.test(val.trim())) {
        const n = Number(val.trim()); date = new Date(n < 1e12 ? n * 1000 : n);
      } else date = parseDateText(val);
      if (date && Number.isFinite(date.getTime())) return { date, text: val.trim() };
    }
    const ownText = (anchor.innerText || anchor.textContent || '').trim();
    const date = parseDateText(ownText);
    return date ? { date, text: ownText } : null;
  }
  function timestampFromCard(card, anchor) {
    const direct = timestampFromAnchor(anchor);
    if (direct) return direct;
    // Only machine-readable timestamp fields are accepted as fallback; relative labels are never estimated.
    const nodes = card ? card.querySelectorAll('time[datetime], abbr[data-utime], [data-utime], [data-timestamp]') : [];
    for (const el of nodes) {
      const attr = el.hasAttribute('datetime') ? 'datetime' : (el.hasAttribute('data-utime') ? 'data-utime' : 'data-timestamp');
      const val = el.getAttribute(attr);
      if (!val) continue;
      let date = null;
      if ((attr === 'data-utime' || attr === 'data-timestamp') && /^\d{9,13}$/.test(val.trim())) {
        const n = Number(val.trim()); date = new Date(n < 1e12 ? n * 1000 : n);
      } else date = parseDateText(val);
      if (date && Number.isFinite(date.getTime())) return { date, text: val.trim() };
    }
    return null;
  }
  function clearMark(card) {
    if (card?.dataset?.fbTimeMarkerMarked) delete card.dataset.fbTimeMarkerMarked;
  }
  function applyTimestamp(anchor, found, card = null) {
    if (!settings.enabled || !Number.isFinite(settings.start) || !found?.date || !Number.isFinite(found.date.getTime())) return;
    const targetCard = card || findCard(anchor);
    if (!targetCard || targetCard === document.body || targetCard === document.documentElement) return;
    // No post URLs, text, timestamps or records are stored. Only the current DOM node gets a visual state.
    targetCard.dataset.fbTimeMarkerMarked = found.date.getTime() < settings.start ? 'before' : 'after';
  }
  function scanAnchor(anchor) {
    if (!anchor?.href || !isPotentialTimestampAnchor(anchor)) return;
    const label = labelForAnchor(anchor);
    const directText = (anchor.innerText || anchor.textContent || '').trim();
    const hasExact = !!parseDateText(label) || !!parseDateText(directText) ||
      !!parseDateText(anchor.getAttribute('aria-label') || '') || !!parseDateText(anchor.getAttribute('title') || '');
    const hasMachineTime = ['datetime', 'data-utime', 'data-timestamp'].some(attr => anchor.hasAttribute(attr));
    if (!isRelativeTimeLabel(label) && !hasExact && !hasMachineTime) return;
    const card = findCard(anchor);
    const found = timestampFromCard(card, anchor);
    if (found) applyTimestamp(anchor, found, card);
  }
  const TIMESTAMP_LINK_SELECTOR = 'a[href][aria-labelledby], a[href][datetime], a[href][data-utime], a[href][data-timestamp], a[href][aria-label], a[href][title]';
  function scanRoot(root = document) {
    const anchors = [];
    if (root?.matches?.(TIMESTAMP_LINK_SELECTOR)) anchors.push(root);
    root?.querySelectorAll?.(TIMESTAMP_LINK_SELECTOR).forEach(a => anchors.push(a));
    for (const anchor of anchors) scanAnchor(anchor);
  }
  function ensureMarkerStyle() {
    if (document.getElementById('fb-time-marker-style')) return;
    const style = document.createElement('style');
    style.id = 'fb-time-marker-style';
    style.textContent = `
      [data-fb-time-marker-marked="before"]::before,
      [data-fb-time-marker-marked="after"]::before {
        content: ""; display: block; width: fit-content; max-width: 90%;
        margin: 8px auto; padding: 6px 12px; text-align: center;
        background: transparent; border: 2px solid currentColor; border-radius: 7px;
        font: 800 12px/1.35 system-ui, -apple-system, "Segoe UI", sans-serif;
        letter-spacing: .2px; box-shadow: none; pointer-events: none;
      }
      [data-fb-time-marker-marked="before"]::before { content: "TRƯỚC MỐC T"; color: #7f1010; border-color: #a61b1b; background: #ffe1df; }
      [data-fb-time-marker-marked="after"]::before { content: "TỪ MỐC T TRỞ ĐI"; color: #003b82; border-color: #005fcc; background: #dceaff; }
    `;
    (document.head || document.documentElement).appendChild(style);
  }
  async function refreshSettings() {
    try {
      const sync = await chrome.storage.sync.get(SYNC_KEYS);
      settings = { start: Date.parse(sync.fbTimeFilterStart || ''), enabled: !!sync.fbTimeFilterEnabled };
    } catch { settings = { start: NaN, enabled: false }; }
  }
  async function applyFilter() {
    if (applying) return;
    applying = true;
    try {
      await refreshSettings();
      ensureMarkerStyle();
      document.querySelectorAll('[data-fb-time-marker-marked]').forEach(clearMark);
      if (settings.enabled && Number.isFinite(settings.start)) scanRoot(document);
      // Restore cards hidden by older versions; current version never hides posts.
      document.querySelectorAll('[data-fb-time-filter-hidden="1"]').forEach(card => {
        card.style.removeProperty('display');
        delete card.dataset.fbTimeFilterHidden;
        delete card.dataset.fbTimeFilterUrl;
      });
    } finally { applying = false; }
  }
  function scanCurrentTooltip() {
    const anchor = currentAnchor;
    if (!anchor || !anchor.isConnected || Date.now() - hoverAt > 12000) return;
    // Re-resolve the card during retries: Facebook can finish mounting the post after pointerover.
    currentCard = findCard(anchor) || currentCard;
    // Re-run direct timestamp detection because Facebook may update aria-labelledby/title in place.
    scanAnchor(anchor);
    const describedBy = (anchor.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean);
    const labelledBy = (anchor.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean);
    const ids = [...new Set([...describedBy, ...labelledBy])];
    for (const id of ids) {
      const tip = document.getElementById(id);
      const text = (tip?.innerText || tip?.textContent || '').trim();
      const date = parseDateText(text);
      if (date) { applyTimestamp(anchor, { date, text }, currentCard); return; }
    }
    // Facebook sometimes mounts the tooltip outside the post and without aria-describedby.
    if (isRelativeTimeLabel(labelForAnchor(anchor))) {
      for (const tip of document.querySelectorAll('[role="tooltip"], [data-visualcompletion="ignore-dynamic"] [role="tooltip"]')) {
        if (!tip.isConnected || (tip.getClientRects && tip.getClientRects().length === 0)) continue;
        const text = (tip.innerText || tip.textContent || '').trim();
        const date = parseDateText(text);
        if (date) { applyTimestamp(anchor, { date, text }, currentCard); return; }
      }
    }
    const found = timestampFromCard(currentCard, anchor);
    if (found) applyTimestamp(anchor, found, currentCard);
  }
  function stopHoverObserver() {
    if (hoverObserver) { hoverObserver.disconnect(); hoverObserver = null; }
    clearTimeout(hoverObserverStopTimer);
    hoverObserverStopTimer = 0;
  }
  function startHoverObserver(anchor) {
    stopHoverObserver();
    // Observe briefly only while hovering, so delayed tooltip text/attributes are handled without a permanent heavy observer.
    hoverObserver = new MutationObserver(() => {
      if (currentAnchor === anchor && anchor.isConnected && isCurrentHoverActive(anchor)) scanCurrentTooltip();
    });
    try {
      hoverObserver.observe(document.body || document.documentElement, {
        subtree: true, childList: true, characterData: true, attributes: true,
        attributeFilter: ['aria-label', 'aria-labelledby', 'aria-describedby', 'title', 'datetime', 'data-utime', 'data-timestamp']
      });
      hoverObserverStopTimer = setTimeout(stopHoverObserver, 9000);
    } catch { stopHoverObserver(); }
  }
  function scheduleHoverRetry(anchor) {
    if (hoverRetryIndex >= hoverRetryDelays.length) { stopHoverObserver(); return; }
    hoverRetryTimer = setTimeout(() => {
      if (currentAnchor !== anchor || !anchor.isConnected || !isCurrentHoverActive(anchor)) { stopHoverObserver(); return; }
      scanCurrentTooltip();
      hoverRetryIndex++;
      scheduleHoverRetry(anchor);
    }, hoverRetryDelays[hoverRetryIndex]);
  }
  function onHover(e) {
    const rawTarget = e.target;
    const anchor = findTimestampAnchorFromTarget(rawTarget);
    if (!anchor) return;

    const directInsideAnchor = anchor.contains(rawTarget);
    const hoverTarget = directInsideAnchor
      ? anchor
      : (rawTarget?.closest?.('[id]') || rawTarget);
    if (e.relatedTarget && (anchor.contains(e.relatedTarget) || hoverTarget?.contains?.(e.relatedTarget))) return;

    currentAnchor = anchor;
    currentHoverTarget = hoverTarget;
    currentCard = findCard(anchor);
    hoverAt = Date.now();
    scanAnchor(anchor);
    clearTimeout(hoverRetryTimer);
    hoverRetryIndex = 0;
    startHoverObserver(anchor);
    scheduleHoverRetry(anchor);
  }
  function onMutations(records) {
    for (const rec of records) {
      if (rec.type !== 'childList') continue;
      rec.addedNodes?.forEach(node => {
        if (node.nodeType === Node.ELEMENT_NODE && node.id !== 'fb-time-marker-style') queuedNodes.add(node);
      });
    }
    if (!queuedNodes.size) return;
    clearTimeout(mutationTimer);
    mutationTimer = setTimeout(() => {
      const nodes = [...queuedNodes]; queuedNodes.clear();
      for (const node of nodes) scanRoot(node);
    }, 110);
  }

  function createFloatingControls() {
    if (!document.body || document.getElementById('fb-time-marker-floating-host')) return;

    const host = document.createElement('div');
    host.id = 'fb-time-marker-floating-host';
    Object.assign(host.style, {
      position: 'fixed',
      inset: '0',
      zIndex: '2147483647',
      pointerEvents: 'none',
      width: '0',
      height: '0'
    });

    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>
        * { box-sizing: border-box; }
        .toggle {
          position: fixed;
          right: 0;
          top: 50%;
          transform: translateY(-50%);
          width: 46px;
          height: 54px;
          border: 0;
          border-radius: 12px 0 0 12px;
          background: #1769e0;
          color: #fff;
          font: 700 23px/1 system-ui, sans-serif;
          cursor: pointer;
          box-shadow: 0 2px 12px #0004;
          pointer-events: auto;
        }
        .panel {
          display: none;
          position: fixed;
          right: 54px;
          top: 50%;
          transform: translateY(-50%);
          width: min(360px, calc(100vw - 68px));
          height: min(650px, 82vh);
          border: 1px solid #cbd0d8;
          border-radius: 13px;
          overflow: hidden;
          background: #f5f6f7;
          box-shadow: 0 5px 28px #0004;
          pointer-events: auto;
        }
        .panel.open { display: block; }
        .panel iframe {
          display: block;
          width: 100%;
          height: 100%;
          border: 0;
          background: #f5f6f7;
        }
        @media (max-width: 420px) {
          .panel { right: 50px; width: calc(100vw - 60px); }
        }
        @media (max-height: 520px) {
          .panel { height: 90vh; top: 5vh; transform: none; }
        }
      </style>
      <button class="toggle" type="button"
        title="Mở Facebook Feed Marker Extension"
        aria-label="Mở Facebook Feed Marker Extension"
        aria-expanded="false">⏱</button>
      <section class="panel" role="dialog" aria-label="Cài đặt Facebook Feed Marker Extension">
        <iframe title="Cài đặt Facebook Feed Marker Extension" loading="eager"></iframe>
      </section>
    `;

    const toggle = shadow.querySelector('.toggle');
    const panel = shadow.querySelector('.panel');
    const frame = shadow.querySelector('iframe');
    frame.src = chrome.runtime.getURL('popup/popup.html');

    function setOpen(open) {
      panel.classList.toggle('open', open);
      toggle.setAttribute('aria-expanded', String(open));
    }

    toggle.addEventListener('click', () => {
      setOpen(!panel.classList.contains('open'));
    });

    shadow.addEventListener('keydown', event => {
      if (event.key === 'Escape') setOpen(false);
    });

    document.addEventListener('pointerdown', event => {
      if (!panel.classList.contains('open')) return;
      const path = event.composedPath?.() || [];
      if (path.includes(host) || path.includes(shadow)) return;
      // A click inside the embedded popup is handled by its own document.
      if (event.target === host || host.contains(event.target)) return;
      setOpen(false);
    }, true);

    document.documentElement.appendChild(host);
  }

  createFloatingControls();

  document.addEventListener('pointerover', onHover, true);
  const observer = new MutationObserver(onMutations);
  if (document.body) observer.observe(document.body, { childList: true, subtree: true });
  ensureMarkerStyle();
  refreshSettings().then(() => { if (settings.enabled && Number.isFinite(settings.start)) scanRoot(document); });
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'FB_TIME_FILTER_APPLY' || msg?.type === 'FB_TIME_FILTER_SCAN') {
      applyFilter().then(() => sendResponse({ ok: true }));
      return true;
    }
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && SYNC_KEYS.some(key => changes[key])) applyFilter();
  });
  console.info('[FB Time Marker v0.7.4] Đánh dấu bằng nhãn viền giữa bài; không lưu hay thu thập dữ liệu bài viết.');
})();
