/**
 * Content Script v2.0.0
 * - Throttled MutationObserver (16ms minimum interval)
 * - WeakRef for DOM element tracking (prevents memory leaks)
 * - SPA navigation support (YouTube yt-navigate-finish, popstate, etc.)
 * - <source> tag and blob URL detection
 * - requestIdleCallback for non-blocking DOM scans
 */
(() => {
  'use strict';

  // Prevent double-injection
  if (window.__mediaStreamInspectorLoaded) return;
  window.__mediaStreamInspectorLoaded = true;

  // ---- Configuration ----
  const SCAN_THROTTLE_MS = 500;
  const MUTATION_DEBOUNCE_MS = 300;
  const MAX_MEDIA_ITEMS = 50;

  // ---- State ----
  const knownUrls = new Set();
  let lastScanTime = 0;
  let mutationTimer = null;
  let observer = null;

  // WeakRef-based element tracker to avoid holding references to removed DOM nodes
  const trackedElements = new Set(); // Set of WeakRef

  function cleanTrackedElements() {
    for (const ref of trackedElements) {
      if (!ref.deref()) trackedElements.delete(ref);
    }
  }

  // ---- Priority Calculation ----
  function calculatePriority(el, index) {
    let priority = 0;
    const rect = el.getBoundingClientRect();
    const visibleSize = rect.width * rect.height;

    if (visibleSize > 0) priority += Math.min(visibleSize / 10000, 50);
    if (rect.width > 100 && rect.height > 100 && el.offsetParent !== null) {
      priority += 20;
    }

    const src = getMediaUrl(el);
    if (src) {
      if (/1080|1920/i.test(src)) priority += 15;
      else if (/720/i.test(src)) priority += 10;
      else if (/480/i.test(src)) priority += 5;
      if (/master/i.test(src)) priority += 25;
    }

    if (el.autoplay) priority += 10;
    if (el.currentTime > 0 && !el.paused) priority += 15; // Actually playing
    priority += Math.max(0, 20 - index);

    return Math.round(priority);
  }

  // ---- URL Extraction ----
  function getMediaUrl(el) {
    // Direct src
    if (el.src && !el.src.startsWith('blob:')) return el.src;

    // <source> children
    const source = el.querySelector('source');
    if (source && source.src && !source.src.startsWith('blob:')) return source.src;

    // data-src or other common attributes
    const dataSrc = el.dataset.src || el.getAttribute('data-video-src');
    if (dataSrc) return dataSrc;

    // currentSrc (may be set by JS player)
    if (el.currentSrc && !el.currentSrc.startsWith('blob:')) return el.currentSrc;

    return null;
  }

  function getMediaType(url) {
    if (!url) return 'Unknown';
    if (url.includes('.m3u8')) return 'HLS';
    if (url.includes('.mp4')) return 'MP4';
    if (url.includes('.webm')) return 'WebM';
    if (url.includes('.m4s') || url.includes('.ts')) return 'Segment';
    return 'Media';
  }

  // ---- DOM Scanning ----
  function findMediaElements() {
    const media = [];
    const elements = document.querySelectorAll('video, audio');

    elements.forEach((el, index) => {
      const url = getMediaUrl(el);
      if (!url || knownUrls.has(url)) return;

      // Skip segments
      if (/\.(ts|m4s)(\?|$)/i.test(url)) return;

      const type = getMediaType(url);
      if (type === 'Segment') return;

      const rect = el.getBoundingClientRect();
      media.push({
        url,
        type,
        priority: calculatePriority(el, index),
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      });

      knownUrls.add(url);
      trackedElements.add(new WeakRef(el));
    });

    return media;
  }

  // ---- Network Interception ----
  // Intercept fetch/XHR to detect dynamically loaded m3u8/mp4 URLs
  function interceptNetworkRequests() {
    // Intercept fetch
    const originalFetch = window.fetch;
    window.fetch = function (...args) {
      try {
        const url = typeof args[0] === 'string' ? args[0] : args[0]?.url;
        if (url && typeof url === 'string') {
          checkAndReportUrl(url);
        }
      } catch (e) { /* ignore */ }
      return originalFetch.apply(this, args);
    };

    // Intercept XMLHttpRequest
    const originalOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
      try {
        if (url && typeof url === 'string') {
          checkAndReportUrl(url);
        }
      } catch (e) { /* ignore */ }
      return originalOpen.call(this, method, url, ...rest);
    };
  }

  function checkAndReportUrl(url) {
    if (knownUrls.has(url)) return;
    // Only report media URLs
    if (!/\.(m3u8|mp4|webm)(\?|$|#)/i.test(url)) return;
    // Skip segments
    if (/\.(ts|m4s)(\?|$)/i.test(url)) return;

    knownUrls.add(url);

    let priority = 10;
    if (/master/i.test(url)) priority += 30;
    else if (url.includes('.m3u8')) priority += 20;
    if (/1080|1920/i.test(url)) priority += 15;
    else if (/720/i.test(url)) priority += 10;
    else if (/480/i.test(url)) priority += 5;

    sendMedia([{
      url,
      type: getMediaType(url),
      priority,
      width: 0,
      height: 0
    }]);
  }

  // ---- Communication ----
  function sendMedia(mediaList) {
    if (!mediaList.length) return;
    // Limit to prevent flooding
    const toSend = mediaList.slice(0, MAX_MEDIA_ITEMS);
    try {
      chrome.runtime.sendMessage({
        action: 'contentMediaFound',
        media: toSend
      });
    } catch (e) {
      // Extension context invalidated (e.g., extension updated)
    }
  }

  // ---- Throttled Scan ----
  function scheduleScan() {
    const now = Date.now();
    if (now - lastScanTime < SCAN_THROTTLE_MS) return;
    lastScanTime = now;

    if (typeof requestIdleCallback === 'function') {
      requestIdleCallback(() => {
        const found = findMediaElements();
        sendMedia(found);
        cleanTrackedElements();
      }, { timeout: 2000 });
    } else {
      setTimeout(() => {
        const found = findMediaElements();
        sendMedia(found);
        cleanTrackedElements();
      }, 0);
    }
  }

  // ---- MutationObserver with debounce ----
  function startObserver() {
    if (observer) observer.disconnect();

    observer = new MutationObserver(() => {
      if (mutationTimer) clearTimeout(mutationTimer);
      mutationTimer = setTimeout(scheduleScan, MUTATION_DEBOUNCE_MS);
    });

    observer.observe(document.body || document.documentElement, {
      childList: true,
      subtree: true,
      attributes: false,
      characterData: false
    });
  }

  // ---- SPA Navigation Support ----
  function setupSpaListeners() {
    // YouTube SPA navigation
    window.addEventListener('yt-navigate-finish', () => {
      knownUrls.clear();
      scheduleScan();
    });

    // Generic SPA: popstate, hashchange
    window.addEventListener('popstate', () => {
      knownUrls.clear();
      scheduleScan();
    });
    window.addEventListener('hashchange', () => {
      knownUrls.clear();
      scheduleScan();
    });

    // Detect URL changes via polling (fallback for pushState SPAs)
    let lastHref = location.href;
    const hrefCheck = setInterval(() => {
      if (location.href !== lastHref) {
        lastHref = location.href;
        knownUrls.clear();
        scheduleScan();
      }
    }, 1000);

    // Cleanup on unload
    window.addEventListener('unload', () => {
      clearInterval(hrefCheck);
      if (observer) observer.disconnect();
    });
  }

  // ---- Initialization ----
  function init() {
    // Initial scan
    scheduleScan();

    // Start MutationObserver
    if (document.body) {
      startObserver();
    } else {
      document.addEventListener('DOMContentLoaded', startObserver);
    }

    // SPA support
    setupSpaListeners();

    // Network interception for dynamic media loading
    interceptNetworkRequests();
  }

  init();
})();
