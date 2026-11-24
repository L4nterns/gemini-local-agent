const SETTINGS_KEY = 'localAgentSettings';
const CHAT_MODES_KEY = 'localAgentChatModes';
const MAX_STORED_CHATS = 200;

const DEFAULT_SETTINGS = {
  bridgeUrl: 'http://127.0.0.1:3847',
  token: '',
  mode: 'smart', // 'smart' (read-only auto) | 'auto'
  maxAutoTurns: 15,
  responseStableMs: 1300,
  theme: 'auto', // 'auto' | 'dark' | 'light'
};

function msg(key, subs) {
  try {
    const val = chrome.i18n.getMessage(key, subs ? [String(subs)] : undefined);
    if (val) return val;
  } catch {
    // Ignore outside extension context
  }
  return key;
}

function isAllowedLoopbackUrl(urlStr) {
  try {
    const parsed = new URL(urlStr);
    if (parsed.protocol !== 'http:') return false;
    if (parsed.username || parsed.password) return false;
    return parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost';
  } catch {
    return false;
  }
}

async function getSettings() {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  return { ...DEFAULT_SETTINGS, ...(stored[SETTINGS_KEY] || {}) };
}

async function saveSettings(patch) {
  const current = await getSettings();
  const next = { ...current, ...patch };
  if (typeof next.bridgeUrl === 'string') {
    const cleaned = next.bridgeUrl.trim().replace(/\/+$/, '') || DEFAULT_SETTINGS.bridgeUrl;
    if (!isAllowedLoopbackUrl(cleaned)) {
      throw new Error(msg('errLoopbackOnly'));
    }
    next.bridgeUrl = new URL(cleaned).origin;
  }
  if (typeof next.token === 'string') {
    next.token = next.token.trim();
  }
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  return next;
}

async function saveChatMode(chatId, record) {
  if (!chatId) return {};
  const stored = await chrome.storage.local.get(CHAT_MODES_KEY);
  const map = stored[CHAT_MODES_KEY] || {};
  map[chatId] = {
    mode: record.mode === 'agent' ? 'agent' : 'normal',
    workspace: record.workspace || null,
    mounted: Boolean(record.mounted),
    locked: Boolean(record.locked),
    updatedAt: Date.now(),
  };
  const keys = Object.keys(map);
  if (keys.length > MAX_STORED_CHATS) {
    keys
      .sort((a, b) => (map[a]?.updatedAt || 0) - (map[b]?.updatedAt || 0))
      .slice(0, keys.length - MAX_STORED_CHATS)
      .forEach((k) => delete map[k]);
  }
  await chrome.storage.local.set({ [CHAT_MODES_KEY]: map });
  return map;
}

/**
 * Automatic TOFU pairing with the local bridge.
 * Chrome attaches the unforgeable `Origin: chrome-extension://<id>` header automatically.
 */
async function attemptAutoPair(baseUrl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(`${baseUrl}/api/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client: 'gemini-local-agent' }),
      signal: controller.signal,
    });
    const data = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
    if (res.ok && data.ok && data.token) {
      await saveSettings({ token: data.token });
      return { ok: true, token: data.token, firstPair: Boolean(data.firstPair) };
    }
    return {
      ok: false,
      code: data.code || `PAIR_HTTP_${res.status}`,
      error: data.error || `Pairing failed (${res.status})`,
    };
  } catch (err) {
    if (err.name === 'AbortError') {
      return { ok: false, code: 'TIMEOUT', error: msg('errTimeout') };
    }
    return {
      ok: false,
      code: 'UNREACHABLE',
      error: msg('errUnreachable', baseUrl),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function bridgeFetch(
  endpoint,
  {
    method = 'GET',
    body = null,
    auth = true,
    timeoutMs = 15000,
    rawText = false,
    allowAutoPair = true,
  } = {}
) {
  let settings = await getSettings();
  const baseUrl = settings.bridgeUrl || DEFAULT_SETTINGS.bridgeUrl;

  if (!isAllowedLoopbackUrl(baseUrl)) {
    return { ok: false, code: 'INVALID_HOST', error: msg('errLoopbackOnly') };
  }

  if (auth && !settings.token) {
    if (!allowAutoPair) {
      return { ok: false, code: 'NO_TOKEN', error: msg('errNoToken') };
    }
    const paired = await attemptAutoPair(baseUrl);
    if (!paired.ok) return paired;
    settings = await getSettings();
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const headers = {};
    if (body) headers['Content-Type'] = 'application/json';
    if (auth) headers.Authorization = `Bearer ${settings.token}`;

    const res = await fetch(`${baseUrl}${endpoint}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });

    // Transparently re-pair once if token was rotated for the same trusted extension ID
    if (res.status === 401 && auth && allowAutoPair) {
      clearTimeout(timer);
      const paired = await attemptAutoPair(baseUrl);
      if (paired.ok) {
        return bridgeFetch(endpoint, {
          method,
          body,
          auth,
          timeoutMs,
          rawText,
          allowAutoPair: false,
        });
      }
      return {
        ok: false,
        code: paired.code || 'UNAUTHORIZED',
        error: paired.error || msg('errUnauthorized'),
      };
    }

    if (rawText) {
      const text = await res.text();
      if (!res.ok) return { ok: false, code: `HTTP_${res.status}`, error: `HTTP ${res.status}` };
      return { ok: true, raw: text };
    }

    const data = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
    if (!res.ok) {
      return {
        ok: false,
        code: data.code || `HTTP_${res.status}`,
        error: data.error || `Local bridge error (${res.status})`,
      };
    }
    return data;
  } catch (err) {
    if (err.name === 'AbortError') {
      return { ok: false, code: 'TIMEOUT', error: msg('errTimeout') };
    }
    return {
      ok: false,
      code: 'UNREACHABLE',
      error: msg('errUnreachable', baseUrl),
    };
  } finally {
    clearTimeout(timer);
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    switch (message?.type) {
      case 'GET_SETTINGS': {
        sendResponse({ ok: true, settings: await getSettings() });
        break;
      }
      case 'SAVE_SETTINGS': {
        try {
          sendResponse({ ok: true, settings: await saveSettings(message.patch || {}) });
        } catch (err) {
          sendResponse({ ok: false, error: err.message });
        }
        break;
      }
      case 'SAVE_CHAT_MODE': {
        sendResponse({
          ok: true,
          chatModes: await saveChatMode(message.chatId, message.record || {}),
        });
        break;
      }
      case 'BRIDGE_HEALTH': {
        sendResponse(await bridgeFetch('/health', { auth: false, timeoutMs: 3500 }));
        break;
      }
      case 'BRIDGE_INFO': {
        sendResponse(await bridgeFetch('/api/info', { auth: true, timeoutMs: 5000 }));
        break;
      }
      case 'BRIDGE_PICK_WORKSPACE': {
        sendResponse(
          await bridgeFetch('/api/workspaces/pick', {
            method: 'POST',
            body: {},
            auth: true,
            timeoutMs: 180000,
          })
        );
        break;
      }
      case 'BRIDGE_REMOVE_WORKSPACE': {
        sendResponse(
          await bridgeFetch('/api/workspaces/remove', {
            method: 'POST',
            body: { workspace: message.workspace },
            auth: true,
            timeoutMs: 8000,
          })
        );
        break;
      }
      case 'BRIDGE_WORKSPACE_CONTEXT': {
        sendResponse(
          await bridgeFetch('/api/workspaces/context', {
            method: 'POST',
            body: { workspace: message.workspace || null },
            auth: true,
            timeoutMs: 10000,
          })
        );
        break;
      }
      case 'BRIDGE_PREVIEW_TOOLS': {
        sendResponse(
          await bridgeFetch('/api/tool/preview', {
            method: 'POST',
            body: { calls: message.calls || [], workspace: message.workspace || null },
            auth: true,
            timeoutMs: 10000,
          })
        );
        break;
      }
      case 'BRIDGE_EXEC_TOOL': {
        sendResponse(
          await bridgeFetch('/api/tool', {
            method: 'POST',
            body: {
              tool: message.tool,
              args: message.args || {},
              workspace: message.workspace || null,
            },
            auth: true,
            timeoutMs: 125000,
          })
        );
        break;
      }
      case 'BRIDGE_LOGS': {
        const limit = Number(message.limit) || 80;
        sendResponse(await bridgeFetch(`/api/logs?limit=${limit}`, { auth: true, timeoutMs: 6000 }));
        break;
      }
      case 'BRIDGE_LOGS_RAW': {
        sendResponse(
          await bridgeFetch('/api/logs?format=raw', { auth: true, timeoutMs: 8000, rawText: true })
        );
        break;
      }
      default:
        sendResponse({ ok: false, error: `Unknown message type: ${message?.type}` });
    }
  })().catch((err) => {
    sendResponse({ ok: false, error: err?.message || String(err) });
  });

  return true;
});
