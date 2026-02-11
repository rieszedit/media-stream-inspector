/**
 * Popup UI v2.0.0
 * - Proper progress tracking per URL
 * - No innerHTML wiping during active downloads
 * - Indeterminate progress support
 * - Speed/ETA display
 * - Download continues when popup closes (handled by background + offscreen)
 * - XSS-safe DOM construction (no innerHTML with user data)
 * - Inline SVG icons (no external CDN dependency)
 */

// Inline SVG icons (replaces boxicons CDN for CWS compliance)
const ICONS = {
  video: '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M18 7c0-1.103-.897-2-2-2H4c-1.103 0-2 .897-2 2v10c0 1.103.897 2 2 2h12c1.103 0 2-.897 2-2v-3.333L22 17V7l-4 3.333V7z"/></svg>',
  hls: '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M4 6h2v12H4zm5 0h2v12H9zm5 0h2v12h-2zm5 0h2v12h-2z"/></svg>',
  download: '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M12 16l-5-5 1.41-1.41L11 12.17V4h2v8.17l2.59-2.58L17 11l-5 5zm-7 2v2h14v-2H5z"/></svg>',
  link: '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M3.9 12c0-1.71 1.39-3.1 3.1-3.1h4V7H7c-2.76 0-5 2.24-5 5s2.24 5 5 5h4v-1.9H7c-1.71 0-3.1-1.39-3.1-3.1zM8 13h8v-2H8v2zm9-6h-4v1.9h4c1.71 0 3.1 1.39 3.1 3.1s-1.39 3.1-3.1 3.1h-4V17h4c2.76 0 5-2.24 5-5s-2.24-5-5-5z"/></svg>',
  check: '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z"/></svg>',
  shield: '<svg viewBox="0 0 24 24" width="16" height="16" fill="#00ba7c"><path d="M12 2L4 5v6.09c0 5.05 3.41 9.76 8 10.91 4.59-1.15 8-5.86 8-10.91V5l-8-3zm-1.06 13.54L7.4 12l1.41-1.41 2.12 2.12 4.24-4.24 1.41 1.41-5.64 5.66z"/></svg>',
  search: '<svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="#8b98a5" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>'
};

document.addEventListener('DOMContentLoaded', async () => {
  const listContainer = document.getElementById('media-list');
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;

  // Track download state per URL
  const downloadStates = new Map();

  // ---- Progress Listener ----
  chrome.runtime.onMessage.addListener((request) => {
    if (request.action === 'downloadProgress' && request.tabId === tab.id) {
      const state = {
        progress: request.prog,
        message: request.msg || '',
        active: request.prog !== null && request.prog < 100
      };
      downloadStates.set(request.url, state);
      updateProgressUI(request.url, state);
    }
  });

  // ---- Safe Text Setter ----
  function setText(el, text) {
    if (el) el.textContent = text;
  }

  // ---- Create SVG icon element ----
  function iconEl(name) {
    const span = document.createElement('span');
    span.className = 'icon';
    span.innerHTML = ICONS[name] || '';
    return span;
  }

  // ---- Progress UI Update ----
  function updateProgressUI(url, state) {
    const card = document.querySelector(`.media-card[data-url="${CSS.escape(url)}"]`);
    if (!card) return;

    const bar = card.querySelector('.progress-fill');
    const log = card.querySelector('.log-msg');
    const wrap = card.querySelector('.progress-wrap');

    if (wrap) wrap.style.display = 'block';

    if (log) {
      log.style.display = 'block';
      setText(log, state.message);

      if (state.message.startsWith('Error')) {
        log.style.color = '#ff4444';
      } else if (state.message.startsWith('Complete') || state.message.startsWith('Success')) {
        log.style.color = '#00ba7c';
      } else {
        log.style.color = 'var(--primary)';
      }
    }

    if (bar) {
      if (state.progress !== null && state.progress >= 0) {
        bar.style.width = state.progress + '%';
        bar.classList.remove('indeterminate');
      } else {
        bar.classList.add('indeterminate');
      }
    }

    if (state.message.startsWith('Complete') || state.message.startsWith('Error') || state.message.startsWith('Success')) {
      const btn = card.querySelector('.btn-dl');
      if (btn) {
        btn.disabled = false;
        btn.textContent = '';
        btn.appendChild(iconEl('download'));
        btn.appendChild(document.createTextNode(state.message.startsWith('Error') ? ' Retry' : ' Done'));
      }
      downloadStates.delete(url);
    }
  }

  // ---- Create Media Card (XSS-safe, inline SVG) ----
  function createCard(item) {
    const card = document.createElement('div');
    card.className = 'media-card';
    card.dataset.url = item.url;

    const isHls = item.url.includes('.m3u8');

    // Card head
    const head = document.createElement('div');
    head.className = 'card-head';

    const typeIcon = document.createElement('div');
    typeIcon.className = 'type-icon';
    typeIcon.appendChild(iconEl(isHls ? 'hls' : 'video'));

    const info = document.createElement('div');
    info.className = 'info';

    const title = document.createElement('div');
    title.className = 'title';
    title.textContent = isHls ? 'HLS Stream' : 'Direct Video';

    const meta = document.createElement('div');
    meta.className = 'meta';
    let metaText = isHls ? 'Auto-Segment Mapping' : 'Direct Access';
    if (item.width && item.height) {
      metaText += ` | ${item.width}x${item.height}`;
    }
    meta.textContent = metaText;

    info.appendChild(title);
    info.appendChild(meta);

    head.appendChild(typeIcon);
    head.appendChild(info);
    head.appendChild(iconEl('shield'));

    // URL preview
    const urlPreview = document.createElement('div');
    urlPreview.className = 'url-preview';
    try {
      const parsed = new URL(item.url);
      urlPreview.textContent = parsed.pathname.split('/').pop() || parsed.hostname;
    } catch (e) {
      urlPreview.textContent = item.url.substring(0, 50);
    }

    // Actions
    const actions = document.createElement('div');
    actions.className = 'actions';

    const dlBtn = document.createElement('button');
    dlBtn.className = 'btn-main btn-dl';
    dlBtn.dataset.url = item.url;
    dlBtn.appendChild(iconEl('download'));
    dlBtn.appendChild(document.createTextNode(isHls ? ' Elite Download' : ' Direct Save'));

    const copyBtn = document.createElement('button');
    copyBtn.className = 'btn-side btn-copy';
    copyBtn.dataset.url = item.url;
    copyBtn.appendChild(iconEl('link'));

    actions.appendChild(dlBtn);
    actions.appendChild(copyBtn);

    // Progress
    const progressWrap = document.createElement('div');
    progressWrap.className = 'progress-wrap';
    const progressFill = document.createElement('div');
    progressFill.className = 'progress-fill';
    progressWrap.appendChild(progressFill);

    const logMsg = document.createElement('div');
    logMsg.className = 'log-msg';

    card.appendChild(head);
    card.appendChild(urlPreview);
    card.appendChild(actions);
    card.appendChild(progressWrap);
    card.appendChild(logMsg);

    // Event handlers
    dlBtn.addEventListener('click', () => {
      dlBtn.disabled = true;
      dlBtn.textContent = '';
      dlBtn.appendChild(document.createTextNode('Processing...'));

      if (isHls) {
        chrome.runtime.sendMessage({
          action: 'startHlsDownload',
          url: item.url,
          tabId: tab.id
        });
      } else {
        chrome.runtime.sendMessage({
          action: 'startDirectDownload',
          url: item.url,
          tabId: tab.id
        });
      }
    });

    copyBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(item.url).then(() => {
        copyBtn.textContent = '';
        copyBtn.appendChild(iconEl('check'));
        setTimeout(() => {
          copyBtn.textContent = '';
          copyBtn.appendChild(iconEl('link'));
        }, 1500);
      });
    });

    // Restore progress state if exists
    const existingState = downloadStates.get(item.url);
    if (existingState) {
      updateProgressUI(item.url, existingState);
    }

    return card;
  }

  // ---- Render ----
  const renderedUrls = new Set();

  function render() {
    chrome.runtime.sendMessage({ action: 'getMedia', tabId: tab.id }, (response) => {
      if (chrome.runtime.lastError || !response || !response.media) return;

      if (response.media.length === 0 && renderedUrls.size === 0) return;

      response.media.forEach(item => {
        if (!item.url || renderedUrls.has(item.url)) return;
        renderedUrls.add(item.url);

        const empty = listContainer.querySelector('.empty');
        if (empty) empty.remove();

        listContainer.appendChild(createCard(item));
      });
    });
  }

  render();
  setInterval(render, 3000);
});
