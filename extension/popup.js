const { t, applyDomI18n } = window.LocalAgentI18n;

const els = {
  statusBadge: document.getElementById('statusBadge'),
  guideSection: document.getElementById('guideSection'),
  guideNormal: document.getElementById('guideNormal'),
  guideOtherPaired: document.getElementById('guideOtherPaired'),
  copyStartCmdBtn: document.getElementById('copyStartCmdBtn'),
  copyResetCmdBtn: document.getElementById('copyResetCmdBtn'),

  workspaceSection: document.getElementById('workspaceSection'),
  workspaceList: document.getElementById('workspaceList'),
  envMeta: document.getElementById('envMeta'),
  pickNativeBtn: document.getElementById('pickNativeBtn'),

  bridgeUrl: document.getElementById('bridgeUrl'),
  token: document.getElementById('token'),
  mode: document.getElementById('mode'),
  theme: document.getElementById('theme'),
  maxAutoTurns: document.getElementById('maxAutoTurns'),
  saveBtn: document.getElementById('saveBtn'),
  openGeminiBtn: document.getElementById('openGeminiBtn'),
  feedback: document.getElementById('feedback'),
};

let isConnected = false;

function sendBg(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (resp) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
      } else {
        resolve(resp || { ok: false, error: 'No response' });
      }
    });
  });
}

function showFeedback(text, isError = false) {
  els.feedback.textContent = text;
  els.feedback.classList.remove('hidden', 'error');
  if (isError) els.feedback.classList.add('error');
  clearTimeout(showFeedback._timer);
  showFeedback._timer = setTimeout(() => {
    els.feedback.classList.add('hidden');
  }, isError ? 3200 : 1800);
}

function flashButtonLabel(btn, tempText) {
  if (!btn) return;
  const orig = btn.dataset.origLabel || btn.textContent;
  btn.dataset.origLabel = orig;
  btn.textContent = tempText;
  clearTimeout(btn._flashTimer);
  btn._flashTimer = setTimeout(() => {
    btn.textContent = orig;
  }, 1300);
}

function hideFeedback() {
  els.feedback.classList.add('hidden');
}

async function copyCmd(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
    flashButtonLabel(btn, t('copiedBtn'));
  } catch {
    showFeedback(t('errCopyFailed', text), true);
  }
}

function renderWorkspaceList(workspaces) {
  const items = Array.isArray(workspaces)
    ? workspaces.map((w) => ({
        path: w.path,
        name: w.name || w.path.split(/[\\/]/).filter(Boolean).pop() || w.path,
        exists: w.exists !== false,
      }))
    : [];

  els.workspaceList.innerHTML = '';
  if (items.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'ws-empty';
    empty.textContent = t('emptyWorkspaces');
    els.workspaceList.appendChild(empty);
    return;
  }

  for (const ws of items) {
    const item = document.createElement('div');
    item.className = `ws-item ${!ws.exists ? 'missing' : ''}`;
    item.title = ws.path;

    const body = document.createElement('div');
    body.className = 'ws-item-body';

    const nameEl = document.createElement('div');
    nameEl.className = 'ws-item-name';
    nameEl.textContent = `📁 ${ws.name}`;

    const pathEl = document.createElement('div');
    pathEl.className = 'ws-item-path';
    pathEl.textContent = ws.path;

    body.appendChild(nameEl);
    body.appendChild(pathEl);
    item.appendChild(body);

    if (!ws.exists) {
      const tag = document.createElement('span');
      tag.className = 'ws-missing-tag';
      tag.textContent = t('workspaceInvalidTag');
      item.appendChild(tag);
    }

    const delBtn = document.createElement('button');
    delBtn.className = 'ws-del';
    delBtn.textContent = '✕';
    delBtn.title = t('removeWorkspaceTooltip');
    delBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      removeWorkspace(ws.path);
    });
    item.appendChild(delBtn);

    els.workspaceList.appendChild(item);
  }
}

function updateConnectionUI(info) {
  if (info && info.ok) {
    isConnected = true;
    els.statusBadge.textContent = t('statusConnectedVersion', info.version || '');
    els.statusBadge.className = 'badge online';
    els.guideSection.classList.add('hidden');
    els.workspaceSection.classList.remove('hidden');
    els.envMeta.textContent = t('envMetaFormat', [info.shell || '', info.nodeVersion || '']);
    els.envMeta.title = els.envMeta.textContent;
    renderWorkspaceList(info.workspaces);
  } else {
    isConnected = false;
    els.statusBadge.textContent = t('statusOffline');
    els.statusBadge.className = 'badge offline';
    els.workspaceSection.classList.add('hidden');
    els.guideSection.classList.remove('hidden');
    const isOther = info?.code === 'ALREADY_PAIRED_OTHER';
    els.guideNormal.classList.toggle('hidden', isOther);
    els.guideOtherPaired.classList.toggle('hidden', !isOther);
  }
}

async function refreshConnection(showActionableError = false) {
  const info = await sendBg({ type: 'BRIDGE_INFO' });
  updateConnectionUI(info);
  if (info.ok) {
    const sRes = await sendBg({ type: 'GET_SETTINGS' });
    if (sRes.ok && sRes.settings && document.activeElement !== els.token) {
      els.token.value = sRes.settings.token || '';
    }
    hideFeedback();
  } else if (showActionableError && info.code !== 'UNREACHABLE') {
    showFeedback(info.error || t('errUnauthorized'), true);
  }
  return info;
}

async function removeWorkspace(targetPath) {
  const res = await sendBg({ type: 'BRIDGE_REMOVE_WORKSPACE', workspace: targetPath });
  if (res.ok) {
    await refreshConnection(false);
  } else {
    showFeedback(res.error || 'Failed to remove workspace', true);
  }
}

async function init() {
  applyDomI18n(document);

  const res = await sendBg({ type: 'GET_SETTINGS' });
  if (res.ok && res.settings) {
    const s = res.settings;
    els.bridgeUrl.value = s.bridgeUrl || 'http://127.0.0.1:3847';
    els.token.value = s.token || '';
    els.mode.value = s.mode === 'auto' ? 'auto' : 'smart';
    els.theme.value = s.theme || 'auto';
    els.maxAutoTurns.value = s.maxAutoTurns || 15;
  }
  await refreshConnection(false);

  // Auto-poll connection status while popup is open
  let popupPolling = false;
  setInterval(async () => {
    if (popupPolling) return;
    if (document.activeElement && ['INPUT', 'SELECT'].includes(document.activeElement.tagName)) {
      return;
    }
    popupPolling = true;
    try {
      const health = await sendBg({ type: 'BRIDGE_HEALTH' });
      if (health.ok && !isConnected) {
        await refreshConnection(false);
      } else if (!health.ok && isConnected) {
        updateConnectionUI({ ok: false, code: 'UNREACHABLE' });
      }
    } finally {
      popupPolling = false;
    }
  }, 2500);
}

els.copyStartCmdBtn.addEventListener('click', () =>
  copyCmd('node bridge/server.js', els.copyStartCmdBtn)
);
els.copyResetCmdBtn.addEventListener('click', () =>
  copyCmd('node bridge/server.js --reset-pair', els.copyResetCmdBtn)
);

els.pickNativeBtn.addEventListener('click', async () => {
  els.pickNativeBtn.disabled = true;
  els.pickNativeBtn.textContent = t('pickingWorkspace');
  const res = await sendBg({ type: 'BRIDGE_PICK_WORKSPACE' });
  els.pickNativeBtn.disabled = false;
  els.pickNativeBtn.textContent = t('addWorkspace');
  if (!res.ok) {
    showFeedback(res.error || 'Failed to open folder picker', true);
    return;
  }
  if (!res.cancelled) {
    await refreshConnection(false);
  }
});

els.saveBtn.addEventListener('click', async () => {
  const patch = {
    bridgeUrl: els.bridgeUrl.value.trim() || 'http://127.0.0.1:3847',
    token: els.token.value.trim(),
    mode: els.mode.value,
    theme: els.theme.value,
    maxAutoTurns: Math.min(Math.max(Number(els.maxAutoTurns.value) || 15, 1), 100),
  };
  const saved = await sendBg({ type: 'SAVE_SETTINGS', patch });
  if (!saved.ok) {
    showFeedback(saved.error || 'Failed to save settings', true);
    return;
  }
  flashButtonLabel(els.saveBtn, t('saved'));
  await refreshConnection(true);
});

els.openGeminiBtn.addEventListener('click', () => {
  chrome.tabs.create({ url: 'https://gemini.google.com/app' });
});

init();
