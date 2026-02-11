/**
 * Background Service Worker v2.0.0
 * - Proper URL throttling (per-URL map, not single variable)
 * - TokyoMotion / site-specific download support
 * - Download history persistence (chrome.storage.local)
 * - Service Worker keep-alive via alarms
 * - Notification-based progress when popup is closed
 * - Filename extraction from Content-Disposition / URL
 * - MIME type enforcement for downloads
 */

// ---- State ----
let store = {};
let contentMediaCache = {};
let activeTabId = null;
const recentUrls = new Map(); // url -> timestamp (proper per-URL throttle)
const THROTTLE_MS = 1000;
const RECENT_URLS_MAX = 200;

// Active download tracking
const activeDownloads = new Map(); // downloadId -> { url, tabId, progress, status, filename }

// ---- Site Exclusion ----
function isExcluded(url) {
  if (!url) return false;
  return /youtube\.com|x\.com|twitter\.com/i.test(url);
}

// ---- Site-specific configuration ----
function getSiteConfig(url) {
  if (!url) return {};
  try {
    const hostname = new URL(url).hostname;

    if (/tokyomotion/i.test(hostname)) {
      return {
        forceReferer: true,
        forceMimeType: 'video/mp4',
        fileExtension: '.mp4',
        customHeaders: { 'Accept': 'video/mp4,video/*;q=0.9,*/*;q=0.8' }
      };
    }

    if (/pornhub/i.test(hostname)) {
      return { forceReferer: true, fileExtension: '.mp4' };
    }

    if (/candfans|cien/i.test(hostname)) {
      return { forceReferer: true };
    }
  } catch (e) { /* invalid URL */ }
  return {};
}

// ---- Media Storage with Priority ----
function addMediaWithPriority(tabId, mediaList, source) {
  if (tabId !== activeTabId) return;
  if (!store[tabId]) store[tabId] = [];

  let changed = false;
  mediaList.forEach(item => {
    if (!item.url) return;

    const existing = store[tabId].find(m => m.url === item.url);
    if (existing) {
      if (item.priority && item.priority > existing.priority) {
        existing.priority = item.priority;
        changed = true;
      }
      existing.source = source;
    } else {
      store[tabId].push({
        url: item.url,
        type: item.type || 'Unknown',
        priority: item.priority || 0,
        source,
        width: item.width,
        height: item.height,
        timestamp: Date.now()
      });
      changed = true;
    }
  });

  if (changed) {
    store[tabId].sort((a, b) => (b.priority || 0) - (a.priority || 0));
    chrome.action.setBadgeText({
      text: store[tabId].length.toString(),
      tabId
    }).catch(() => { });
    chrome.action.setBadgeBackgroundColor({ color: '#1d9bf0', tabId }).catch(() => { });
  }
}

// ---- Throttle cleanup ----
function cleanRecentUrls() {
  if (recentUrls.size <= RECENT_URLS_MAX) return;
  const now = Date.now();
  for (const [url, time] of recentUrls) {
    if (now - time > THROTTLE_MS * 2) recentUrls.delete(url);
  }
}

// ---- Active Tab Tracking ----
chrome.tabs.onActivated.addListener(({ tabId }) => {
  activeTabId = tabId;
  chrome.tabs.get(tabId, (tab) => {
    if (chrome.runtime.lastError) return;
    if (tab && isExcluded(tab.url)) {
      chrome.action.setBadgeText({ text: '', tabId }).catch(() => { });
    }
  });
});

// ---- Tab Update ----
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (tabId === activeTabId && changeInfo.url) {
    if (isExcluded(changeInfo.url)) {
      chrome.action.setBadgeText({ text: '', tabId }).catch(() => { });
    }
  }
});

// ---- Tab Removed: cleanup ----
chrome.tabs.onRemoved.addListener((tabId) => {
  delete store[tabId];
  delete contentMediaCache[tabId];
});

// ---- Navigation: clear store & set headers ----
chrome.webNavigation.onBeforeNavigate.addListener((d) => {
  if (d.frameId !== 0) return;

  store[d.tabId] = [];
  contentMediaCache[d.tabId] = [];

  chrome.tabs.get(d.tabId, (tab) => {
    if (chrome.runtime.lastError) return;
    if (tab && isExcluded(tab.url)) {
      chrome.action.setBadgeText({ text: '', tabId: d.tabId }).catch(() => { });
    }
  });

  try {
    const origin = new URL(d.url).origin;
    chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [1],
      addRules: [{
        id: 1,
        priority: 1,
        action: {
          type: 'modifyHeaders',
          requestHeaders: [
            { header: 'referer', operation: 'set', value: origin + '/' },
            { header: 'origin', operation: 'set', value: origin }
          ]
        },
        condition: {
          urlFilter: '*',
          resourceTypes: ['xmlhttprequest', 'media', 'other']
        }
      }]
    }).catch(() => { });
  } catch (e) { /* invalid URL */ }
});

// ---- Network Request Monitoring ----
chrome.webRequest.onBeforeRequest.addListener(
  (d) => {
    if (d.tabId !== activeTabId || d.tabId < 0) return;

    const url = d.url;

    // Per-URL throttle
    const now = Date.now();
    if (recentUrls.has(url) && now - recentUrls.get(url) < THROTTLE_MS) return;
    recentUrls.set(url, now);
    cleanRecentUrls();

    chrome.tabs.get(d.tabId, (tab) => {
      if (chrome.runtime.lastError || !tab || isExcluded(tab.url)) return;

      // Skip segment files
      if (/\.(ts|m4s)(\?|$|&)/i.test(url)) return;

      // Detect HLS / MP4 / WebM
      if (/\.(m3u8|mp4|webm)(\?|$|&|#)/i.test(url)) {
        let priority = 10;

        if (/master/i.test(url)) priority += 30;
        else if (url.includes('.m3u8')) priority += 20;

        if (/1080|1920/i.test(url)) priority += 15;
        else if (/720/i.test(url)) priority += 10;
        else if (/480/i.test(url)) priority += 5;

        let type = 'MP4';
        if (url.includes('.m3u8')) type = 'HLS';
        else if (url.includes('.webm')) type = 'WebM';

        addMediaWithPriority(d.tabId, [{
          url,
          type,
          priority
        }], 'network');
      }
    });
  },
  { urls: ['<all_urls>'] }
);

// ---- Offscreen Document Management ----
async function ensureOffscreen() {
  try {
    const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    if (contexts.length === 0) {
      await chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: ['BLOBS'],
        justification: 'HLS segment download and blob assembly'
      });
    }
  } catch (e) {
    console.error('Offscreen creation failed:', e);
  }
}

// ---- Filename Extraction ----
function extractFilename(url, contentDisposition) {
  // Try Content-Disposition first
  if (contentDisposition) {
    const match = contentDisposition.match(/filename\*?=(?:UTF-8'')?["']?([^"';\n]+)/i);
    if (match) return decodeURIComponent(match[1].trim());
  }

  // Extract from URL path
  try {
    const pathname = new URL(url).pathname;
    const segments = pathname.split('/').filter(Boolean);
    if (segments.length > 0) {
      const last = segments[segments.length - 1];
      // Remove query-like suffixes and decode
      const clean = decodeURIComponent(last.split('?')[0].split('#')[0]);
      if (/\.(mp4|webm|m3u8|mkv|avi|flv)$/i.test(clean)) {
        return clean;
      }
    }
  } catch (e) { /* ignore */ }

  return null;
}

// ---- Download History Persistence ----
async function saveDownloadRecord(record) {
  try {
    const { downloadHistory = [] } = await chrome.storage.local.get('downloadHistory');
    downloadHistory.unshift(record);
    // Keep last 100 records
    if (downloadHistory.length > 100) downloadHistory.length = 100;
    await chrome.storage.local.set({ downloadHistory });
  } catch (e) { /* ignore */ }
}

// ---- Service Worker Keep-Alive ----
chrome.alarms.create('keepAlive', { periodInMinutes: 0.4 }); // Every 24 seconds
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'keepAlive') {
    // Keep service worker alive during active downloads
    if (activeDownloads.size > 0) {
      // Touch storage to prevent idle
      chrome.storage.local.get('_keepAlive', () => { });
    }
  }
});

// ---- Notification Helper ----
function showNotification(title, message) {
  chrome.notifications.create({
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title,
    message
  }).catch(() => { });
}

// ---- Message Handler ----
chrome.runtime.onMessage.addListener((m, sender, sendResponse) => {
  if (m.action === 'getMedia') {
    const media = store[m.tabId] || [];
    sendResponse({ media });
    return false;
  }

  if (m.action === 'contentMediaFound') {
    if (m.media && Array.isArray(m.media)) {
      const tabId = sender.tab?.id;
      if (tabId) {
        addMediaWithPriority(tabId, m.media, 'content');
      }
    }
    sendResponse({ received: true });
    return false;
  }

  if (m.action === 'startHlsDownload') {
    (async () => {
      await ensureOffscreen();
      // Get site config for the tab
      let pageUrl = '';
      try {
        const tab = await chrome.tabs.get(m.tabId);
        pageUrl = tab.url;
      } catch (e) { /* ignore */ }

      const siteConfig = getSiteConfig(pageUrl);
      chrome.runtime.sendMessage({
        action: 'executeUltimateDownload',
        url: m.url,
        tabId: m.tabId,
        pageUrl,
        siteConfig
      });
    })();
    return true;
  }

  if (m.action === 'startDirectDownload') {
    (async () => {
      try {
        // Get page URL for referer
        let pageUrl = '';
        try {
          const tab = await chrome.tabs.get(m.tabId);
          pageUrl = tab.url;
        } catch (e) { /* ignore */ }

        const siteConfig = getSiteConfig(pageUrl);
        const urlFilename = extractFilename(m.url);
        const ext = siteConfig.fileExtension || '.mp4';
        let filename = urlFilename || `direct_${Date.now()}${ext}`;

        // Ensure correct file extension (e.g., fix .htm -> .mp4)
        if (siteConfig.fileExtension && !filename.endsWith(siteConfig.fileExtension)) {
          filename = filename.replace(/\.[^.]+$/, siteConfig.fileExtension);
        }

        // Sites requiring Referer: skip chrome.downloads (can't set Referer)
        // and go directly to fetch-based download via offscreen document
        if (siteConfig.forceReferer) {
          fetchBasedDownload(m.url, filename, m.tabId, pageUrl, siteConfig);
          return;
        }

        chrome.downloads.download({
          url: m.url,
          filename,
          saveAs: true
        }, (downloadId) => {
          if (chrome.runtime.lastError) {
            console.error('Direct download failed:', chrome.runtime.lastError.message);
            // Fallback: try fetch-based download
            fetchBasedDownload(m.url, filename, m.tabId, pageUrl, siteConfig);
          } else {
            activeDownloads.set(downloadId, {
              url: m.url,
              tabId: m.tabId,
              filename,
              status: 'downloading'
            });
          }
        });
      } catch (e) {
        console.error('Direct download error:', e);
      }
    })();
    return true;
  }

  if (m.action === 'downloadCombinedBlob') {
    const filename = m.filename || `capture_${Date.now()}.mp4`;
    chrome.downloads.download({
      url: m.blobUrl,
      filename,
      saveAs: true
    }, (downloadId) => {
      if (chrome.runtime.lastError) {
        console.error('Blob download failed:', chrome.runtime.lastError.message);
      } else {
        activeDownloads.set(downloadId, {
          url: m.blobUrl,
          tabId: m.tabId,
          filename,
          status: 'downloading'
        });
      }

      // Revoke blob URL after short delay to allow download to start
      setTimeout(() => {
        try { URL.revokeObjectURL(m.blobUrl); } catch (e) { /* ignore */ }
      }, 5000);
    });
    return false;
  }

  if (m.action === 'downloadProgress') {
    // Forward to popup (if open) - this is already handled by the message passing
    // Also track for notifications
    if (m.msg && m.msg.startsWith('Error')) {
      showNotification('Download Failed', m.msg);
    }
    return false;
  }

  if (m.action === 'getDownloadHistory') {
    chrome.storage.local.get('downloadHistory', (result) => {
      sendResponse({ history: result.downloadHistory || [] });
    });
    return true;
  }

  if (m.action === 'getActiveDownloads') {
    sendResponse({ downloads: Array.from(activeDownloads.entries()) });
    return false;
  }

  return true;
});

// ---- Fetch-based Download Fallback ----
// For sites where chrome.downloads.download fails (CORS, Content-Type issues)
async function fetchBasedDownload(url, filename, tabId, pageUrl, siteConfig) {
  try {
    await ensureOffscreen();
    chrome.runtime.sendMessage({
      action: 'executeFetchDownload',
      url,
      filename,
      tabId,
      pageUrl,
      siteConfig
    });
  } catch (e) {
    console.error('Fetch-based download failed:', e);
    showNotification('Download Failed', `Could not download: ${e.message}`);
  }
}

// ---- Download State Tracking ----
chrome.downloads.onChanged.addListener((delta) => {
  const download = activeDownloads.get(delta.id);
  if (!download) return;

  if (delta.state) {
    if (delta.state.current === 'complete') {
      download.status = 'complete';
      saveDownloadRecord({
        url: download.url,
        filename: download.filename,
        completedAt: Date.now(),
        status: 'complete'
      });
      showNotification('Download Complete', download.filename);
      activeDownloads.delete(delta.id);
    } else if (delta.state.current === 'interrupted') {
      download.status = 'interrupted';
      download.error = delta.error?.current;
      showNotification('Download Interrupted', `${download.filename}: ${delta.error?.current || 'Unknown error'}`);
      activeDownloads.delete(delta.id);
    }
  }
});

// ---- Startup: restore active tab ----
chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  if (tabs[0]) activeTabId = tabs[0].id;
});
