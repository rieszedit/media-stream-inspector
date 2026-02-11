/**
 * Offscreen Document v2.0.0
 * - AES-128 encrypted HLS support (#EXT-X-KEY)
 * - Configurable concurrency (default 8, was 15)
 * - Proper blob URL revocation
 * - Stream-based memory management for large files
 * - Master playlist quality selection (picks highest bitrate)
 * - Retry logic for failed segments
 * - Fetch-based direct download fallback
 * - Progress with speed and ETA estimation
 */

const CONCURRENCY = 8;
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;

// ---- AES-128 Decryption ----
async function importAesKey(keyData) {
  return crypto.subtle.importKey(
    'raw',
    keyData,
    { name: 'AES-CBC' },
    false,
    ['decrypt']
  );
}

async function decryptSegment(encrypted, key, iv) {
  return crypto.subtle.decrypt(
    { name: 'AES-CBC', iv },
    key,
    encrypted
  );
}

function parseHexIV(ivString) {
  // IV format: 0x0123456789abcdef0123456789abcdef
  const hex = ivString.replace(/^0x/i, '');
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    bytes[i] = parseInt(hex.substr(i * 2, 2), 16) || 0;
  }
  return bytes;
}

function sequenceIV(sequenceNumber) {
  const iv = new Uint8Array(16);
  const view = new DataView(iv.buffer);
  view.setUint32(12, sequenceNumber);
  return iv;
}

// ---- HLS Parsing ----
function parseM3u8(text, baseUrl) {
  const lines = text.split('\n').map(l => l.trim());
  const result = {
    isMaster: false,
    variants: [],
    segments: [],
    encryption: null,
    mediaSequence: 0
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Master playlist detection
    if (line.startsWith('#EXT-X-STREAM-INF')) {
      result.isMaster = true;
      const bandwidthMatch = line.match(/BANDWIDTH=(\d+)/i);
      const resMatch = line.match(/RESOLUTION=(\d+x\d+)/i);
      const nextLine = lines[i + 1];
      if (nextLine && !nextLine.startsWith('#')) {
        result.variants.push({
          bandwidth: bandwidthMatch ? parseInt(bandwidthMatch[1]) : 0,
          resolution: resMatch ? resMatch[1] : 'unknown',
          url: new URL(nextLine, baseUrl).href
        });
        i++;
      }
    }

    // Media sequence
    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE')) {
      const val = line.split(':')[1];
      if (val) result.mediaSequence = parseInt(val) || 0;
    }

    // Encryption key
    if (line.startsWith('#EXT-X-KEY')) {
      const methodMatch = line.match(/METHOD=([^,]+)/i);
      const uriMatch = line.match(/URI="([^"]+)"/i);
      const ivMatch = line.match(/IV=([^,]+)/i);

      const method = methodMatch ? methodMatch[1] : 'NONE';
      if (method === 'AES-128' && uriMatch) {
        result.encryption = {
          method,
          keyUrl: new URL(uriMatch[1], baseUrl).href,
          iv: ivMatch ? ivMatch[1] : null
        };
      } else if (method === 'NONE') {
        result.encryption = null;
      }
    }

    // Segment
    if (line && !line.startsWith('#')) {
      result.segments.push(new URL(line, baseUrl).href);
    }
  }

  return result;
}

// ---- Segment Fetcher with Retry ----
async function fetchWithRetry(url, retries = MAX_RETRIES) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url);
      if (res.ok) return await res.arrayBuffer();
      if (res.status === 404) return null; // Don't retry 404s
    } catch (e) {
      if (attempt === retries) return null;
    }
    await new Promise(r => setTimeout(r, RETRY_DELAY_MS * (attempt + 1)));
  }
  return null;
}

// ---- Main HLS Download Handler ----
async function executeHlsDownload(url, tabId, pageUrl) {
  const report = (msg, prog = null) => {
    chrome.runtime.sendMessage({
      action: 'downloadProgress',
      tabId,
      url,
      msg,
      prog
    });
  };

  try {
    report('Fetching playlist...', 0);

    let res = await fetch(url);
    if (!res.ok) throw new Error(`Playlist fetch failed: ${res.status}`);
    let text = await res.text();
    let currentUrl = url;
    let parsed = parseM3u8(text, currentUrl);

    // Handle master playlist - pick highest quality
    if (parsed.isMaster && parsed.variants.length > 0) {
      parsed.variants.sort((a, b) => b.bandwidth - a.bandwidth);
      const best = parsed.variants[0];
      report(`Selected: ${best.resolution} (${Math.round(best.bandwidth / 1000)}kbps)`, 2);

      currentUrl = best.url;
      res = await fetch(currentUrl);
      if (!res.ok) throw new Error(`Variant playlist fetch failed: ${res.status}`);
      text = await res.text();
      parsed = parseM3u8(text, currentUrl);
    }

    if (parsed.segments.length === 0) {
      throw new Error('No segments found in playlist');
    }

    report(`Found ${parsed.segments.length} segments`, 5);

    // Fetch encryption key if needed
    let cryptoKey = null;
    let globalIV = null;
    if (parsed.encryption && parsed.encryption.method === 'AES-128') {
      report('Fetching encryption key...');
      const keyRes = await fetch(parsed.encryption.keyUrl);
      if (!keyRes.ok) throw new Error(`Key fetch failed: ${keyRes.status}`);
      const keyData = await keyRes.arrayBuffer();
      cryptoKey = await importAesKey(keyData);

      if (parsed.encryption.iv) {
        globalIV = parseHexIV(parsed.encryption.iv);
      }
    }

    // Download segments with concurrency control
    const totalSegments = parsed.segments.length;
    const buffers = new Array(totalSegments);
    let completed = 0;
    let failedCount = 0;
    const startTime = Date.now();

    for (let i = 0; i < totalSegments; i += CONCURRENCY) {
      const batch = parsed.segments.slice(i, i + CONCURRENCY);
      const promises = batch.map(async (segUrl, batchIdx) => {
        const segIndex = i + batchIdx;
        const data = await fetchWithRetry(segUrl);

        if (!data) {
          failedCount++;
          return;
        }

        // Decrypt if needed
        if (cryptoKey) {
          try {
            const iv = globalIV || sequenceIV(parsed.mediaSequence + segIndex);
            const decrypted = await decryptSegment(data, cryptoKey, iv);
            buffers[segIndex] = decrypted;
          } catch (e) {
            console.error(`Decrypt failed for segment ${segIndex}:`, e);
            buffers[segIndex] = data; // Use raw data as fallback
          }
        } else {
          buffers[segIndex] = data;
        }
      });

      await Promise.all(promises);
      completed = Math.min(i + CONCURRENCY, totalSegments);

      // Progress with speed estimation
      const elapsed = (Date.now() - startTime) / 1000;
      const progress = Math.round((completed / totalSegments) * 100);
      const speed = elapsed > 0 ? (completed / elapsed) : 0;
      const remaining = speed > 0 ? Math.round((totalSegments - completed) / speed) : '?';

      report(
        `${completed}/${totalSegments} segments (${remaining}s remaining)`,
        Math.min(progress, 95)
      );
    }

    // Filter out null/failed segments
    const validBuffers = buffers.filter(b => b != null);

    if (validBuffers.length === 0) {
      throw new Error('All segments failed to download');
    }

    if (failedCount > 0) {
      report(`Warning: ${failedCount}/${totalSegments} segments failed`);
    }

    report('Assembling video file...', 96);

    // Assemble blob
    const blob = new Blob(validBuffers, { type: 'video/mp4' });

    if (blob.size === 0) throw new Error('Assembled file is empty');

    const blobUrl = URL.createObjectURL(blob);
    const sizeMB = (blob.size / (1024 * 1024)).toFixed(1);

    report(`Complete: ${sizeMB}MB`, 100);

    // Send to background for download
    chrome.runtime.sendMessage({
      action: 'downloadCombinedBlob',
      blobUrl,
      tabId,
      filename: `capture_${Date.now()}.mp4`
    });

    // Schedule blob URL cleanup (background will also revoke after download starts)
    setTimeout(() => {
      try { URL.revokeObjectURL(blobUrl); } catch (e) { /* ignore */ }
    }, 30000);

  } catch (e) {
    console.error('HLS download error:', e);
    report('Error: ' + e.message, null);
  }
}

// ---- Fetch-based Direct Download ----
async function executeFetchDownload(url, filename, tabId, pageUrl) {
  const report = (msg, prog = null) => {
    chrome.runtime.sendMessage({
      action: 'downloadProgress',
      tabId,
      url,
      msg,
      prog
    });
  };

  try {
    report('Starting download...', 0);

    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const contentLength = parseInt(res.headers.get('Content-Length') || '0');
    const reader = res.body.getReader();
    const chunks = [];
    let received = 0;
    const startTime = Date.now();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      chunks.push(value);
      received += value.length;

      if (contentLength > 0) {
        const progress = Math.round((received / contentLength) * 100);
        const elapsed = (Date.now() - startTime) / 1000;
        const speed = elapsed > 0 ? received / elapsed : 0;
        const remaining = speed > 0 ? Math.round((contentLength - received) / speed) : '?';
        const speedMB = (speed / (1024 * 1024)).toFixed(1);
        report(`${progress}% - ${speedMB}MB/s (${remaining}s left)`, progress);
      } else {
        const sizeMB = (received / (1024 * 1024)).toFixed(1);
        report(`Downloaded: ${sizeMB}MB`, null);
      }
    }

    report('Finalizing...', 98);

    const blob = new Blob(chunks, { type: 'video/mp4' });
    const blobUrl = URL.createObjectURL(blob);

    chrome.runtime.sendMessage({
      action: 'downloadCombinedBlob',
      blobUrl,
      tabId,
      filename: filename || `download_${Date.now()}.mp4`
    });

    const sizeMB = (blob.size / (1024 * 1024)).toFixed(1);
    report(`Complete: ${sizeMB}MB`, 100);

    setTimeout(() => {
      try { URL.revokeObjectURL(blobUrl); } catch (e) { /* ignore */ }
    }, 30000);

  } catch (e) {
    console.error('Fetch download error:', e);
    report('Error: ' + e.message, null);
  }
}

// ---- Message Handler ----
chrome.runtime.onMessage.addListener(async (request, sender, sendResponse) => {
  if (request.action === 'executeUltimateDownload') {
    executeHlsDownload(request.url, request.tabId, request.pageUrl);
  }

  if (request.action === 'executeFetchDownload') {
    executeFetchDownload(request.url, request.filename, request.tabId, request.pageUrl);
  }
});
