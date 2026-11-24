(() => {
  if (window.__GEMINI_LOCAL_AGENT_INIT__) return;
  window.__GEMINI_LOCAL_AGENT_INIT__ = true;

  const { t } = window.LocalAgentI18n;
  const Parser = window.LocalAgentParser;
  const PromptTpl = window.LocalAgentPrompt;
  const Session = window.LocalAgentSession;

  const LOCAL_CHAT_STORE_KEY = 'gla_chat_state_v1';

  const state = {
    settings: {
      bridgeUrl: 'http://127.0.0.1:3847',
      token: '',
      mode: 'smart',
      maxAutoTurns: 15,
      responseStableMs: 1300,
      theme: 'auto',
    },
    bridgeConnected: false,
    bridgeInfo: null,
    bridgeError: '',
    bridgeErrorCode: '',
    drawerOpen: false,
    pickingFolder: false,
    activeTab: 'console', // 'console' | 'logs'
    executing: false,
    submittingResults: false,
    autoMounting: false,
    viewNonce: 0,
    conversationMounted: false,
    chatModes: {}, // persisted { [chatId]: { mode: 'agent' | 'normal', workspace, mounted, locked } }
    currentChatId: null,
    chatMode: 'normal',
    chatLocked: false,
    chatBoundWorkspace: null,
    pendingNewChat: null, // { mode, workspace, mounted, locked, createdAt }
    isExtensionSending: false,
    hasSentInCurrentView: false,
    autoTurnCount: 0,
    pendingBatch: null,
    approvalCollapsed: false,
    executionInfo: null, // { currentIndex, total, tool, summary, startedAt }
    queuedMessages: [], // [{ id, text }]
    bridgeLogs: [],
    sessionLogs: [],
    toast: null,
    lastUrl: location.href,
    domVerifiedChatId: null,
    processedFingerprints: new Set(),
    candidateTracker: {
      el: null,
      hash: '',
      stableSince: 0,
    },
    dragPos: null,
  };

  function sendBg(message) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (resp) => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: chrome.runtime.lastError.message });
          } else {
            resolve(resp || { ok: false, error: 'No response' });
          }
        });
      } catch (err) {
        resolve({ ok: false, error: err?.message || String(err) });
      }
    });
  }

  function escapeHtml(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function formatDiffHtml(diffText) {
    if (!diffText) return '';
    return diffText
      .split('\n')
      .map((line) => {
        const esc = escapeHtml(line);
        if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('@@')) {
          return `<span class="gla-diff-hdr">${esc}</span>`;
        }
        if (line.startsWith('+')) return `<span class="gla-diff-add">${esc}</span>`;
        if (line.startsWith('-')) return `<span class="gla-diff-del">${esc}</span>`;
        return esc;
      })
      .join('\n');
  }

  function showToast(text, isError = false) {
    state.toast = { text, isError };
    const panel = state.drawerOpen ? document.querySelector('#gla-root .gla-panel') : null;
    const oldFloat = document.getElementById('gla-floating-toast');
    if (oldFloat) oldFloat.remove();

    if (panel) {
      let toastEl = panel.querySelector(':scope > .gla-toast');
      if (!toastEl) {
        toastEl = document.createElement('div');
        panel.appendChild(toastEl);
      }
      toastEl.className = `gla-toast ${isError ? 'error' : ''}`;
      toastEl.textContent = text;
    } else {
      const floatToast = document.createElement('div');
      floatToast.id = 'gla-floating-toast';
      floatToast.className = `gla-toast gla-toast-global ${isError ? 'error' : ''}`;
      floatToast.textContent = text;
      document.body.appendChild(floatToast);
    }

    clearTimeout(showToast._timer);
    showToast._timer = setTimeout(() => {
      state.toast = null;
      const toastEl = document.querySelector('#gla-root .gla-toast');
      if (toastEl) toastEl.remove();
      const ft = document.getElementById('gla-floating-toast');
      if (ft) ft.remove();
    }, isError ? 3600 : 2200);
  }

  function addSessionLog(entry) {
    state.sessionLogs.unshift({
      time: new Date().toLocaleTimeString(),
      ...entry,
    });
    if (state.sessionLogs.length > 50) state.sessionLogs.length = 50;
  }

  // ==================== Theme Detection ====================

  function resolveIsLightTheme() {
    if (state.settings.theme === 'light') return true;
    if (state.settings.theme === 'dark') return false;
    try {
      for (const el of [document.body, document.documentElement]) {
        if (!el) continue;
        const bg = window.getComputedStyle(el).backgroundColor || '';
        const match = bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
        if (match) {
          const alpha = match[4] !== undefined ? Number(match[4]) : 1;
          if (alpha === 0) continue;
          const luminance =
            0.299 * Number(match[1]) + 0.587 * Number(match[2]) + 0.114 * Number(match[3]);
          return luminance > 145;
        }
      }
    } catch {
      // Fallback to media query
    }
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches;
  }

  // ==================== Gemini Web DOM Helpers ====================

  function isElementVisible(el) {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    return (
      rect.width > 0 &&
      rect.height > 0 &&
      style.visibility !== 'hidden' &&
      style.display !== 'none' &&
      style.opacity !== '0'
    );
  }

  function getGeminiInput() {
    const selectors = [
      'rich-textarea .ql-editor[contenteditable="true"]',
      'div.ql-editor[contenteditable="true"]',
      '[contenteditable="true"][role="textbox"]',
    ];
    for (const sel of selectors) {
      const nodes = document.querySelectorAll(sel);
      for (const el of nodes) {
        if (!el.closest('#gla-root, #gla-approval-dock') && isElementVisible(el)) {
          return el;
        }
      }
    }
    return null;
  }

  function readGeminiInputText() {
    const input = getGeminiInput();
    if (!input) return '';
    return (input.innerText || input.textContent || '').trim();
  }

  function clearGeminiInput() {
    const input = getGeminiInput();
    if (!input) return;
    input.innerHTML = '<p><br></p>';
    input.classList.add('ql-blank');
    input.dispatchEvent(new InputEvent('input', { bubbles: true }));
  }

  async function setGeminiInputText(text) {
    const input = getGeminiInput();
    if (!input) {
      throw new Error(t('errNoInput'));
    }

    const normalized = String(text ?? '').replace(/\r\n/g, '\n');
    const expectedNonWsLen = normalized.replace(/\s+/g, '').length;
    const isFullTextInserted = () => {
      const actualNonWsLen = (input.innerText || input.textContent || '').replace(/\s+/g, '').length;
      return expectedNonWsLen === 0 ? true : actualNonWsLen >= Math.floor(expectedNonWsLen * 0.85);
    };

    input.focus();

    // Clear existing editor contents cleanly
    try {
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(input);
      sel.removeAllRanges();
      sel.addRange(range);
      document.execCommand('delete', false);
    } catch {
      input.innerHTML = '';
    }

    // Strategy 1: Synthetic paste event (Quill native Clipboard handles multi-line text)
    try {
      const dt = new DataTransfer();
      dt.setData('text/plain', normalized);
      const pasteEvent = new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        clipboardData: dt,
      });
      input.dispatchEvent(pasteEvent);
      await new Promise((r) => setTimeout(r, 80));
      if (isFullTextInserted()) {
        input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertFromPaste' }));
        return true;
      }
    } catch {
      // Fall through to Strategy 2
    }

    // Strategy 2: Populate Quill <p> block elements directly
    input.innerHTML = '';
    const lines = normalized.split('\n');
    const frag = document.createDocumentFragment();
    for (const line of lines) {
      const p = document.createElement('p');
      if (line.length > 0) {
        p.textContent = line;
      } else {
        p.appendChild(document.createElement('br'));
      }
      frag.appendChild(p);
    }
    input.appendChild(frag);
    input.classList.remove('ql-blank');

    try {
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(input);
      range.collapse(false);
      sel.removeAllRanges();
      sel.addRange(range);
    } catch {
      // Ignore caret error
    }

    input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertFromPaste' }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 100));
    return true;
  }

  function isValidSendButton(btn) {
    if (!btn || btn.closest('#gla-root, #gla-approval-dock') || !isElementVisible(btn)) {
      return false;
    }
    if (btn.classList.contains('stop') || btn.querySelector('mat-icon[fonticon="stop"], .stop-icon')) {
      return false;
    }
    const label = (btn.getAttribute('aria-label') || '').toLowerCase();
    if (label.includes('stop') || label.includes('停止') || label.includes('feedback') || label.includes('反馈')) {
      return false;
    }
    return true;
  }

  function findSendButton() {
    const composer = findGeminiComposerBox();
    const labelSelectors = [
      'button[aria-label*="Send" i]',
      'button[aria-label*="发送"]',
      'button[aria-label*="Submit" i]',
      'button[aria-label*="提交"]',
      'button[mattooltip*="Send" i]',
      'button[mattooltip*="发送"]',
    ];
    const iconSelectors = [
      'mat-icon[fonticon="arrow_upward"]',
      'mat-icon[data-mat-icon-name="arrow_upward"]',
      'mat-icon[fonticon="send"]',
      'mat-icon[data-mat-icon-name="send"]',
    ];

    // Prefer buttons scoped inside Gemini's composer container
    if (composer) {
      for (const sel of labelSelectors) {
        for (const btn of composer.querySelectorAll(sel)) {
          if (isValidSendButton(btn)) return btn;
        }
      }
      for (const sel of iconSelectors) {
        for (const icon of composer.querySelectorAll(sel)) {
          const btn = icon.closest('button');
          if (isValidSendButton(btn)) return btn;
        }
      }
    }

    // Fallback to document-wide search for explicit send aria-labels
    for (const sel of labelSelectors) {
      for (const btn of document.querySelectorAll(sel)) {
        if (isValidSendButton(btn)) return btn;
      }
    }
    return null;
  }

  async function clickGeminiSend(expectedViewNonce = null) {
    state.isExtensionSending = true;
    let didTriggerSend = false;
    try {
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        if (expectedViewNonce !== null && state.viewNonce !== expectedViewNonce) {
          return false;
        }
        const btn = findSendButton();
        if (btn && !btn.disabled && btn.getAttribute('aria-disabled') !== 'true') {
          btn.click();
          didTriggerSend = true;
          return true;
        }
        await new Promise((r) => setTimeout(r, 120));
      }

      if (expectedViewNonce !== null && state.viewNonce !== expectedViewNonce) {
        return false;
      }
      const input = getGeminiInput();
      if (input) {
        input.focus();
        input.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true })
        );
        didTriggerSend = true;
        return true;
      }
      return false;
    } finally {
      if (didTriggerSend) {
        setTimeout(() => {
          state.isExtensionSending = false;
        }, 300);
      } else {
        state.isExtensionSending = false;
      }
    }
  }

  function isGeminiGenerating() {
    const stopSelectors = [
      'button[aria-label*="Stop" i]',
      'button[aria-label*="停止"]',
      'button[data-test-id="stop-button"]',
      'mat-icon[fonticon="stop"]',
      '.stop-icon',
      'button.send-button.stop',
    ];
    for (const sel of stopSelectors) {
      const nodes = document.querySelectorAll(sel);
      for (const node of nodes) {
        if (!node.closest('#gla-root, #gla-approval-dock') && isElementVisible(node)) {
          return true;
        }
      }
    }

    const busy = document.querySelector('model-response:last-of-type [aria-busy="true"]');
    if (busy && isElementVisible(busy)) return true;

    return false;
  }

  function hasResponseActionBar(responseEl) {
    if (!responseEl) return false;
    const actionBtns = responseEl.querySelectorAll('message-actions button');
    for (const btn of actionBtns) {
      if (isElementVisible(btn)) return true;
    }
    return false;
  }

  function getModelResponses() {
    return Array.from(document.querySelectorAll('model-response'));
  }

  function getUserQueries() {
    return Array.from(document.querySelectorAll('user-query'));
  }

  function hasUserMessageAfter(responseEl) {
    if (!responseEl) return false;
    const queries = getUserQueries();
    for (let i = queries.length - 1; i >= 0; i--) {
      const pos = responseEl.compareDocumentPosition(queries[i]);
      if (pos & Node.DOCUMENT_POSITION_FOLLOWING) {
        return true;
      }
    }
    return false;
  }

  /**
   * Mark already-answered historical responses so they never re-trigger,
   * while preserving an unanswered trailing tool call so F5 / chat-switch / reconnect recovers it.
   */
  function markAnsweredResponsesAsHistory() {
    const responses = getModelResponses();
    if (responses.length === 0) return;

    for (let i = 0; i < responses.length; i++) {
      const el = responses[i];
      const isLast = i === responses.length - 1;
      if (!isLast || hasUserMessageAfter(el)) {
        el.dataset.glaHistory = '1';
      } else {
        delete el.dataset.glaHistory;
        el.dataset.glaRecovered = '1';
      }
    }
    state.candidateTracker = { el: null, hash: '', stableSince: 0 };
  }

  function attachInlinePill(targetEl, statusClass, text) {
    if (!targetEl || !targetEl.parentElement) return null;
    const existing = targetEl.parentElement.querySelector(':scope > .gla-inline-pill');
    if (existing) {
      existing.className = `gla-inline-pill ${statusClass}`;
      existing.textContent = text;
      return existing;
    }
    const pill = document.createElement('div');
    pill.className = `gla-inline-pill ${statusClass}`;
    pill.textContent = text;
    targetEl.parentElement.insertBefore(pill, targetEl);
    return pill;
  }

  // ==================== Bridge & Conversation Isolation ====================

  async function refreshBridgeData(silent = true) {
    const info = await sendBg({ type: 'BRIDGE_INFO' });
    if (info.ok) {
      state.bridgeConnected = true;
      state.bridgeInfo = info;
      state.bridgeError = '';
      state.bridgeErrorCode = '';
      if (
        !state.chatLocked &&
        state.chatMode === 'agent' &&
        state.chatBoundWorkspace &&
        isWorkspaceKnownMissing(state.chatBoundWorkspace)
      ) {
        state.chatMode = 'normal';
        state.chatBoundWorkspace = null;
        state.pendingBatch = null;
      }
      if (state.activeTab === 'logs') {
        const logRes = await sendBg({ type: 'BRIDGE_LOGS', limit: 80 });
        if (logRes?.ok) state.bridgeLogs = logRes.logs || [];
      }
      renderUI();
    } else {
      const nextErr = info.error || t('statusOffline');
      const nextCode = info.code || '';
      const unchangedOffline =
        !state.bridgeConnected &&
        state.bridgeError === nextErr &&
        state.bridgeErrorCode === nextCode;
      state.bridgeConnected = false;
      state.bridgeInfo = null;
      state.bridgeError = nextErr;
      state.bridgeErrorCode = nextCode;
      if (!silent && info.code !== 'UNREACHABLE') {
        showToast(state.bridgeError, true);
      }
      if (!unchangedOffline) {
        renderUI();
      }
    }
    return info;
  }

  async function copyToClipboard(text, btnEl = null) {
    try {
      await navigator.clipboard.writeText(text);
      if (btnEl) {
        const orig = btnEl.dataset.origLabel || btnEl.textContent;
        btnEl.dataset.origLabel = orig;
        btnEl.textContent = t('copiedBtn');
        setTimeout(() => {
          btnEl.textContent = orig;
        }, 1200);
      }
    } catch {
      showToast(t('errCopyFailed', text), true);
    }
  }

  function loadLocalChatStore() {
    try {
      const raw = localStorage.getItem(LOCAL_CHAT_STORE_KEY);
      if (!raw) return { chatModes: {} };
      const parsed = JSON.parse(raw);
      return {
        chatModes:
          parsed && typeof parsed.chatModes === 'object' && parsed.chatModes ? parsed.chatModes : {},
      };
    } catch {
      return { chatModes: {} };
    }
  }

  function saveLocalChatStore() {
    try {
      const keys = Object.keys(state.chatModes);
      if (keys.length > 200) {
        keys
          .sort((a, b) => (state.chatModes[a]?.updatedAt || 0) - (state.chatModes[b]?.updatedAt || 0))
          .slice(0, keys.length - 200)
          .forEach((k) => delete state.chatModes[k]);
      }
      localStorage.setItem(LOCAL_CHAT_STORE_KEY, JSON.stringify({ chatModes: state.chatModes }));
    } catch {
      // Ignore quota error
    }
  }

  function getCurrentChatId() {
    return Session.getChatIdFromPath(location.pathname);
  }

  function normalizePathForCompare(p) {
    const cleaned = String(p || '')
      .trim()
      .replace(/\\/g, '/')
      .replace(/\/+$/, '');
    const isWindows = !state.bridgeInfo?.os || /^win32/i.test(state.bridgeInfo.os);
    return isWindows ? cleaned.toLowerCase() : cleaned;
  }

  function getFolderDisplayName(p) {
    if (!p) return '';
    const parts = String(p).split(/[\\/]/).filter(Boolean);
    return parts.length > 0 ? parts[parts.length - 1] : p;
  }

  function detectConversationStateFromDom() {
    const queryTexts = getUserQueries().map((q) => q.innerText || q.textContent || '');
    return Session.detectConversationFromSnapshot({ queryTexts });
  }

  function getWorkspaceItems() {
    if (!Array.isArray(state.bridgeInfo?.workspaces)) return [];
    return state.bridgeInfo.workspaces.map((w) => ({
      path: w.path,
      name: w.name || getFolderDisplayName(w.path),
      exists: w.exists !== false,
    }));
  }

  function isWorkspaceKnownMissing(wsPath) {
    if (!wsPath || !state.bridgeConnected) return false;
    const key = normalizePathForCompare(wsPath);
    const found = getWorkspaceItems().find((w) => normalizePathForCompare(w.path) === key);
    if (!found) {
      return !state.bridgeInfo?.allowOutsideWorkspace;
    }
    return !found.exists;
  }

  async function persistChatMode(chatId, mode, workspace = null, mounted = false, locked = true) {
    if (!chatId) return;
    const record = {
      mode: mode === 'agent' ? 'agent' : 'normal',
      workspace: workspace || null,
      mounted: Boolean(mounted),
      locked: Boolean(locked),
      updatedAt: Date.now(),
    };
    state.chatModes[chatId] = record;
    saveLocalChatStore();
    // Route through background read-merge handler so concurrent tabs never overwrite each other
    await sendBg({ type: 'SAVE_CHAT_MODE', chatId, record });
  }

  async function syncCurrentConversation() {
    const chatId = getCurrentChatId();
    state.currentChatId = chatId;

    const domState = chatId ? detectConversationStateFromDom() : { detected: 'empty', workspace: null };
    if (chatId && domState.detected !== 'empty') {
      state.domVerifiedChatId = chatId;
    }

    const next = Session.resolveConversationSync({
      chatId,
      storedRecord: chatId ? state.chatModes[chatId] || null : null,
      pendingNewChat: state.pendingNewChat,
      domState,
      currentChatMode: state.chatMode,
      currentBoundWorkspace: state.chatBoundWorkspace,
      now: Date.now(),
    });

    if (next.clearPendingNewChat) {
      state.pendingNewChat = null;
    }
    state.chatLocked = next.chatLocked;
    state.chatMode = next.chatMode;
    state.chatBoundWorkspace = next.chatBoundWorkspace;
    state.conversationMounted = next.conversationMounted;

    if (chatId && next.persistRecord) {
      await persistChatMode(
        chatId,
        next.persistRecord.mode,
        next.persistRecord.workspace,
        next.persistRecord.mounted,
        next.persistRecord.locked
      );
    }
    renderUI();
  }

  function resetBlankChatToNormal() {
    if (state.chatLocked) return;
    state.chatMode = 'normal';
    state.chatBoundWorkspace = null;
    state.pendingBatch = null;
    renderUI();
  }

  function selectWorkspaceForNewChat(targetPath) {
    if (state.chatLocked) return;
    if (isWorkspaceKnownMissing(targetPath)) {
      showToast(t('errWorkspaceMissing'), true);
      return;
    }
    state.chatMode = 'agent';
    state.chatBoundWorkspace = targetPath;
    renderUI();
  }

  async function removeWorkspacePath(targetPath) {
    const res = await sendBg({ type: 'BRIDGE_REMOVE_WORKSPACE', workspace: targetPath });
    if (res.ok) {
      if (
        !state.chatLocked &&
        state.chatBoundWorkspace &&
        normalizePathForCompare(state.chatBoundWorkspace) === normalizePathForCompare(targetPath)
      ) {
        resetBlankChatToNormal();
      }
      await refreshBridgeData(true);
    } else {
      showToast(res.error || 'Failed to remove workspace', true);
    }
  }

  async function pickWorkspaceNative() {
    if (state.pickingFolder) return;
    state.pickingFolder = true;
    renderUI();
    const res = await sendBg({ type: 'BRIDGE_PICK_WORKSPACE' });
    state.pickingFolder = false;
    if (!res.ok) {
      showToast(res.error || 'Failed to open folder picker', true);
      renderUI();
      return;
    }
    if (res.cancelled) {
      renderUI();
      return;
    }
    if (!state.chatLocked) {
      state.chatMode = 'agent';
      state.chatBoundWorkspace = res.workspace;
    }
    await refreshBridgeData(true);
    scanLatestResponse();
  }

  function isConversationAlreadyMounted() {
    if (state.conversationMounted) return true;
    if (detectConversationStateFromDom().detected === 'agent') {
      state.conversationMounted = true;
      return true;
    }
    return false;
  }

  async function wrapAndSendUserMessage(userText) {
    if (state.autoMounting) return;
    state.autoMounting = true;
    const originViewNonce = state.viewNonce;
    try {
      const boundWs = state.chatBoundWorkspace;
      if (!boundWs) {
        showToast(t('errNoWorkspace'), true);
        return;
      }

      const needsMount = !isConversationAlreadyMounted();
      let finalPayload = userText;
      if (needsMount) {
        const wsRes = await sendBg({
          type: 'BRIDGE_WORKSPACE_CONTEXT',
          workspace: boundWs,
        });
        if (state.viewNonce !== originViewNonce) {
          return;
        }
        if (!wsRes.ok) {
          if (wsRes.code === 'UNREACHABLE' || wsRes.code === 'TIMEOUT') {
            state.bridgeConnected = false;
            state.bridgeInfo = null;
            showToast(wsRes.error || t('statusOffline'), true);
            renderUI();
            return;
          }
          if (wsRes.code === 'WORKSPACE_MISSING' || wsRes.code === 'WORKSPACE_UNREGISTERED') {
            if (!state.chatLocked) {
              state.chatMode = 'normal';
              state.chatBoundWorkspace = null;
            }
            showToast(wsRes.error || t('errWorkspaceMissing'), true);
            await refreshBridgeData(true);
            return;
          }
          showToast(wsRes.error || t('errUnauthorized'), true);
          renderUI();
          return;
        }
        const envData = wsRes.data || { ...state.bridgeInfo, workspace: boundWs };
        finalPayload = PromptTpl.buildSystemPrompt(envData, userText);
      }

      if (state.viewNonce !== originViewNonce) return;
      await setGeminiInputText(finalPayload);
      await new Promise((r) => setTimeout(r, 220));
      if (state.viewNonce !== originViewNonce) return;

      const chatIdBeforeSend = getCurrentChatId();
      const prevPendingNewChat = state.pendingNewChat;
      if (needsMount && !chatIdBeforeSend) {
        state.pendingNewChat = {
          mode: 'agent',
          workspace: boundWs,
          mounted: true,
          locked: true,
          createdAt: Date.now(),
        };
      }

      const sent = await clickGeminiSend(originViewNonce);
      if (!sent) {
        if (needsMount && !chatIdBeforeSend) {
          state.pendingNewChat = prevPendingNewChat;
        }
        showToast(t('errNoInput'), true);
        return;
      }

      state.hasSentInCurrentView = true;
      state.autoTurnCount = 0;
      clearHydrationTimers();
      if (needsMount) {
        state.conversationMounted = true;
        state.chatLocked = true;
        state.chatMode = 'agent';
        state.chatBoundWorkspace = boundWs;
        const chatId = getCurrentChatId() || chatIdBeforeSend;
        if (chatId) {
          await persistChatMode(chatId, 'agent', boundWs, true, true);
        }
        addSessionLog({
          tool: 'auto_mount',
          ok: true,
          summary: boundWs,
        });
        renderUI();
      }
    } catch (err) {
      showToast(err.message, true);
    } finally {
      state.autoMounting = false;
    }
  }

  async function handleExportLogs() {
    const res = await sendBg({ type: 'BRIDGE_LOGS_RAW' });
    if (!res.ok) {
      showToast(res.error || 'Failed to export logs', true);
      return;
    }
    const content = res.raw || '';
    if (!content.trim()) {
      showToast(t('errNoLogsExport'), true);
      return;
    }
    const blob = new Blob([content], { type: 'application/x-ndjson;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const dateStr = new Date().toISOString().slice(0, 10);
    a.href = url;
    a.download = `gemini-local-agent-${dateStr}.jsonl`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast(t('exportedLogs'));
  }

  // ==================== Tool Detection & Execution Loop ====================

  async function handleDetectedToolBatch(parsed, responseEl, meta = {}) {
    if (state.executing || state.pendingBatch) return;

    const { responseKey = '', isRecovered = false } = meta;
    const originViewNonce = state.viewNonce;
    const originWorkspace = state.chatBoundWorkspace;
    const batchId = `${Date.now()}-${parsed.fingerprint}`;
    const targetEl = parsed.element || responseEl;
    attachInlinePill(targetEl, 'pending', t('pillDetected', parsed.calls.length));

    const previewRes = await sendBg({
      type: 'BRIDGE_PREVIEW_TOOLS',
      calls: parsed.calls,
      workspace: originWorkspace,
    });

    // Abort cleanly if the user switched to another chat while preview was in flight
    if (state.viewNonce !== originViewNonce) {
      if (responseKey) state.processedFingerprints.delete(responseKey);
      if (responseEl) delete responseEl.dataset.glaProcessed;
      return;
    }

    if (!previewRes.ok) {
      if (previewRes.code === 'UNREACHABLE' || previewRes.code === 'TIMEOUT') {
        state.bridgeConnected = false;
        state.bridgeInfo = null;
      }
      attachInlinePill(targetEl, 'error', previewRes.error || t('statusOffline'));
      showToast(previewRes.error || t('statusOffline'), true);
      if (previewRes.code === 'WORKSPACE_MISSING' || previewRes.code === 'WORKSPACE_UNREGISTERED') {
        // Refresh bridge workspace list BEFORE deciding whether to release responseKey
        // so isWorkspaceKnownMissing() blocks scanLatestResponse() from retry storms.
        await refreshBridgeData(true);
      } else {
        renderUI();
      }
      const shouldReleaseForRecovery =
        previewRes.code === 'UNREACHABLE' ||
        previewRes.code === 'TIMEOUT' ||
        ((previewRes.code === 'WORKSPACE_MISSING' ||
          previewRes.code === 'WORKSPACE_UNREGISTERED') &&
          isWorkspaceKnownMissing(originWorkspace));
      if (responseKey && shouldReleaseForRecovery) {
        state.processedFingerprints.delete(responseKey);
        if (responseEl) {
          delete responseEl.dataset.glaProcessed;
          responseEl.dataset.glaRecovered = '1';
        }
      }
      return;
    }

    const previews =
      previewRes.previews ||
      parsed.calls.map((c) => ({
        tool: c.tool,
        readOnly: Parser.READ_ONLY_TOOLS.has(c.tool),
        dangerous: false,
        summary: c.tool,
        diff: null,
        warning: null,
      }));

    const hasDangerous = previews.some((p) => p.dangerous);
    const allReadOnly = previews.every((p) => p.readOnly);
    const hitTurnLimit = state.autoTurnCount >= (state.settings.maxAutoTurns || 15);

    const effectiveMode = state.settings.mode === 'auto' ? 'auto' : 'smart';
    // Safety guard: on F5 / chat-switch / reconnect recovery, never silently auto-run
    // write or shell commands even in Auto mode; pause in the approval dock instead.
    const shouldAutoRun = isRecovered
      ? !hasDangerous && !hitTurnLimit && allReadOnly
      : !hasDangerous && !hitTurnLimit && (effectiveMode === 'auto' || allReadOnly);

    const batch = {
      id: batchId,
      responseKey,
      originViewNonce,
      originWorkspace,
      calls: parsed.calls,
      previews,
      responseEl,
      targetEl,
      hitTurnLimit,
      hasDangerous,
    };

    if (shouldAutoRun) {
      await executeToolBatch(batch);
    } else {
      state.pendingBatch = batch;
      state.approvalCollapsed = false;
      const reason = hasDangerous
        ? t('reasonDangerous')
        : hitTurnLimit
        ? t('reasonTurnLimit', state.settings.maxAutoTurns)
        : t('reasonApproval');
      attachInlinePill(targetEl, 'pending', t('pillWaiting', [parsed.calls.length, reason]));
      renderUI();
    }
  }

  async function executeToolBatch(batch) {
    const originViewNonce = batch.originViewNonce ?? state.viewNonce;
    const originWorkspace = batch.originWorkspace || state.chatBoundWorkspace;
    const batchStartedAt = Date.now();
    state.executing = true;
    state.submittingResults = false;
    state.pendingBatch = null;
    state.executionInfo = {
      originViewNonce,
      currentIndex: 1,
      total: batch.calls.length,
      tool: batch.calls[0]?.tool || '',
      readOnly: Boolean(batch.previews[0]?.readOnly),
      dangerous: Boolean(batch.previews[0]?.dangerous),
      summary: batch.previews[0]?.summary || batch.calls[0]?.tool || '',
      startedAt: batchStartedAt,
    };
    attachInlinePill(batch.targetEl, 'pending', t('pillExecuting', batch.calls.length));
    renderUI();

    try {
      const results = [];
      for (let i = 0; i < batch.calls.length; i++) {
        const call = batch.calls[i];
        const preview = batch.previews[i] || {};
        state.executionInfo = {
          originViewNonce,
          currentIndex: i + 1,
          total: batch.calls.length,
          tool: call.tool,
          readOnly: Boolean(preview.readOnly),
          dangerous: Boolean(preview.dangerous),
          summary: preview.summary || call.tool,
          startedAt: batchStartedAt,
        };
        if (state.viewNonce === originViewNonce) {
          renderApprovalDock();
        }
        attachInlinePill(batch.targetEl, 'pending', t('pillStep', [i + 1, batch.calls.length, call.tool]));

        const res = await sendBg({
          type: 'BRIDGE_EXEC_TOOL',
          tool: call.tool,
          args: call.args,
          workspace: originWorkspace,
        });

        const ok = Boolean(res.ok);
        results.push({
          tool: call.tool,
          ok,
          status: ok ? 'SUCCESS' : 'ERROR',
          data: res.data,
          error: res.error,
        });

        addSessionLog({
          tool: call.tool,
          ok,
          summary: preview.summary || call.tool,
          durationMs: res.durationMs,
          detail: ok ? JSON.stringify(res.data, null, 2).slice(0, 3000) : res.error,
        });
      }

      const allOk = results.every((r) => r.ok);
      attachInlinePill(
        batch.targetEl,
        allOk ? 'done' : 'error',
        allOk ? t('pillDone', results.length) : t('pillDoneError')
      );

      // Do not touch autoTurnCount or inject results if the user switched to another chat mid-execution
      if (state.viewNonce !== originViewNonce) {
        return;
      }

      state.autoTurnCount += 1;
      state.submittingResults = true;

      const queuedSnapshot = state.queuedMessages.slice();
      const queuedTexts = queuedSnapshot.map((m) => m.text);

      const formatted = PromptTpl.formatToolResults(results, queuedTexts);
      state.hasSentInCurrentView = true;
      try {
        await setGeminiInputText(formatted);
        await new Promise((r) => setTimeout(r, 250));
        if (state.viewNonce !== originViewNonce) return;
        const sent = await clickGeminiSend(originViewNonce);
        // Payload (including queued follow-ups) has been written to Gemini's composer
        const sentIds = new Set(queuedSnapshot.map((m) => m.id));
        state.queuedMessages = state.queuedMessages.filter((m) => !sentIds.has(m.id));
        if (!sent) {
          showToast(t('errNoInput'), true);
        }
      } catch (err) {
        showToast(err.message, true);
      }
    } finally {
      state.executing = false;
      state.submittingResults = false;
      state.executionInfo = null;
      refreshBridgeData(true);
    }
  }

  async function rejectToolBatch(batch, reason = '') {
    const originViewNonce = batch.originViewNonce ?? state.viewNonce;
    state.pendingBatch = null;
    attachInlinePill(
      batch.targetEl,
      'error',
      reason ? t('pillRejectedFeedback') : t('pillRejected')
    );
    renderUI();

    const entries = batch.calls.map((c) => ({
      tool: c.tool,
      ok: false,
      rejected: true,
      status: 'REJECTED_BY_USER',
      reason,
    }));

    addSessionLog({
      tool: batch.calls.map((c) => c.tool).join(', '),
      ok: false,
      summary: reason ? `Rejected: ${reason}` : 'Rejected',
    });

    const formatted = PromptTpl.formatToolResults(entries);
    try {
      if (state.viewNonce !== originViewNonce) return;
      await setGeminiInputText(formatted);
      await new Promise((r) => setTimeout(r, 250));
      if (state.viewNonce !== originViewNonce) return;
      const sent = await clickGeminiSend(originViewNonce);
      if (sent) state.hasSentInCurrentView = true;
    } catch (err) {
      showToast(err.message, true);
    }

    renderUI();
  }

  let hydrationTimers = [];

  function clearHydrationTimers() {
    for (const id of hydrationTimers) clearTimeout(id);
    hydrationTimers = [];
  }

  function scheduleHydrationResync(delays) {
    clearHydrationTimers();
    const expectedNonce = state.viewNonce;
    for (const ms of delays) {
      hydrationTimers.push(
        setTimeout(() => {
          if (state.viewNonce !== expectedNonce) return;
          if (!state.hasSentInCurrentView && !state.executing && !state.pendingBatch) {
            markAnsweredResponsesAsHistory();
          }
          syncCurrentConversation();
          scanLatestResponse();
        }, ms)
      );
    }
  }

  function handleUrlChangeIfNeeded() {
    if (location.href === state.lastUrl) return false;
    const prevUrl = state.lastUrl;
    state.lastUrl = location.href;

    const transition = Session.classifyUrlChange({
      prevUrl,
      nextUrl: location.href,
      chatModes: state.chatModes,
      pendingNewChat: state.pendingNewChat,
      now: Date.now(),
    });

    if (transition.action === 'ignore' || transition.action === 'none') {
      return false;
    }

    if (transition.action === 'bind_new_chat') {
      syncCurrentConversation();
    } else {
      state.viewNonce += 1;
      state.domVerifiedChatId = null;
      clearHydrationTimers();
      state.pendingNewChat = null;
      state.conversationMounted = false;
      state.pendingBatch = null;
      state.approvalCollapsed = false;
      state.queuedMessages = [];
      state.hasSentInCurrentView = false;
      state.autoTurnCount = 0;
      state.processedFingerprints.clear();
      state.candidateTracker = { el: null, hash: '', stableSince: 0 };
      if (!transition.nextChatId) {
        state.chatMode = 'normal';
        state.chatBoundWorkspace = null;
      }
      syncCurrentConversation();
      scheduleHydrationResync([700, 1600]);
    }
    return true;
  }

  function scanLatestResponse() {
    if (handleUrlChangeIfNeeded()) return;

    const responses = getModelResponses();
    const userQueries = getUserQueries();
    // Hydrate/self-heal chat mode once DOM messages appear (recovers uncached or previously mis-classified chats)
    if (
      state.currentChatId &&
      (responses.length > 0 || userQueries.length > 0) &&
      (!state.chatModes[state.currentChatId] ||
        (state.chatMode === 'normal' && state.domVerifiedChatId !== state.currentChatId))
    ) {
      syncCurrentConversation();
    }

    if (
      !state.bridgeConnected ||
      state.chatMode !== 'agent' ||
      !state.chatBoundWorkspace ||
      isWorkspaceKnownMissing(state.chatBoundWorkspace) ||
      state.executing ||
      state.autoMounting ||
      state.pendingBatch
    ) {
      return;
    }

    if (responses.length === 0) return;

    const latest = responses[responses.length - 1];
    if (latest.dataset.glaHistory === '1') return;

    // Never re-trigger a response that already has a user reply / tool result after it
    if (hasUserMessageAfter(latest)) {
      latest.dataset.glaHistory = '1';
      return;
    }

    if (isGeminiGenerating()) {
      state.hasSentInCurrentView = true;
      state.candidateTracker = { el: latest, hash: '', stableSince: 0 };
      return;
    }

    const text = (latest.innerText || latest.textContent || '').trim();
    if (!text) return;

    const isRecovered = latest.dataset.glaRecovered === '1' || !state.hasSentInCurrentView;
    const textHash = Parser.simpleHash(text);
    const now = Date.now();

    if (state.candidateTracker.el !== latest || state.candidateTracker.hash !== textHash) {
      state.candidateTracker = { el: latest, hash: textHash, stableSince: now };
      if (!(isRecovered && hasResponseActionBar(latest))) {
        return;
      }
    }
    const requiredStableMs =
      isRecovered && hasResponseActionBar(latest)
        ? 0
        : hasResponseActionBar(latest)
        ? Math.min(state.settings.responseStableMs || 1300, 750)
        : Math.max(state.settings.responseStableMs || 1300, 1500);
    if (now - state.candidateTracker.stableSince < requiredStableMs) {
      return;
    }

    const parsed = Parser.extractFromDomElement(latest);
    if (!parsed) return;

    const responseKey = `${responses.length}:${parsed.fingerprint}`;
    if (
      latest.dataset.glaProcessed === parsed.fingerprint ||
      state.processedFingerprints.has(responseKey)
    ) {
      return;
    }

    latest.dataset.glaProcessed = parsed.fingerprint;
    state.processedFingerprints.add(responseKey);
    handleDetectedToolBatch(parsed, latest, { responseKey, isRecovered });
  }

  // ==================== Floating UI & Dragging ====================

  function ensureRoot() {
    let root = document.getElementById('gla-root');
    if (!root) {
      root = document.createElement('div');
      root.id = 'gla-root';
      document.body.appendChild(root);
    }
    return root;
  }

  let composerResizeObserver = null;
  let observedComposerEl = null;
  let dockResizeObserver = null;
  let clearanceTargetEl = null;
  let lastAppliedClearance = 0;
  let lastScrolledBatchId = null;

  function findChatScroller() {
    const responses = getModelResponses();
    const anchor = responses.length > 0 ? responses[responses.length - 1] : null;
    if (anchor) {
      let cur = anchor.parentElement;
      while (cur && cur !== document.body && cur !== document.documentElement) {
        const style = getComputedStyle(cur);
        if (
          (style.overflowY === 'auto' || style.overflowY === 'scroll') &&
          cur.clientHeight > 120
        ) {
          return cur;
        }
        cur = cur.parentElement;
      }
    }
    return document.querySelector('infinite-scroller.chat-history, infinite-scroller');
  }

  function applyBottomPadding(el, extraPx) {
    if (!el) return;
    if (el.dataset.glaBasePadBottom === undefined) {
      el.dataset.glaOrigPadBottom = el.style.paddingBottom || '';
      el.dataset.glaBasePadBottom = String(parseFloat(getComputedStyle(el).paddingBottom) || 0);
    }
    const base = parseFloat(el.dataset.glaBasePadBottom) || 0;
    el.style.paddingBottom = `${Math.round(base + extraPx)}px`;
  }

  function restoreBottomPadding(el) {
    if (!el || el.dataset.glaBasePadBottom === undefined) return;
    el.style.paddingBottom = el.dataset.glaOrigPadBottom || '';
    delete el.dataset.glaOrigPadBottom;
    delete el.dataset.glaBasePadBottom;
  }

  function clearScrollClearance() {
    if (clearanceTargetEl) {
      restoreBottomPadding(clearanceTargetEl);
      clearanceTargetEl = null;
    }
    lastAppliedClearance = 0;
    lastScrolledBatchId = null;
  }

  /**
   * Reserve scroll space at the bottom of Gemini's chat scroller equal to the approval dock's height
   * and scroll the latest message clear above the dock so nothing is ever covered.
   */
  function isExecutionActiveInCurrentView() {
    return Boolean(
      state.executing &&
        state.executionInfo &&
        state.executionInfo.originViewNonce === state.viewNonce
    );
  }

  function hasDockContent() {
    return Boolean(
      state.pendingBatch || isExecutionActiveInCurrentView() || state.queuedMessages.length > 0
    );
  }

  function syncScrollClearance(forceScroll = false) {
    const dock = document.getElementById('gla-approval-dock');
    if (!dock || dock.classList.contains('hidden') || !hasDockContent()) {
      clearScrollClearance();
      return;
    }

    const dockHeight = Math.ceil(dock.getBoundingClientRect().height);
    if (dockHeight <= 0) return;

    const scroller = findChatScroller();
    if (!scroller) return;

    const extraPx = dockHeight + 20;
    const activeId = state.pendingBatch?.id || (state.executing ? 'executing' : 'queued');
    const isNewBatch = activeId !== lastScrolledBatchId;
    const distFromBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
    const shouldScroll = forceScroll || isNewBatch || distFromBottom < 260;

    if (clearanceTargetEl && clearanceTargetEl !== scroller && clearanceTargetEl !== scroller.firstElementChild) {
      restoreBottomPadding(clearanceTargetEl);
      clearanceTargetEl = null;
      lastAppliedClearance = 0;
    }

    if (!clearanceTargetEl || Math.abs(extraPx - lastAppliedClearance) >= 2) {
      const target = clearanceTargetEl || scroller;
      const beforeScrollH = scroller.scrollHeight;
      applyBottomPadding(target, extraPx);
      if (
        !clearanceTargetEl &&
        scroller.scrollHeight <= beforeScrollH &&
        scroller.children.length === 1 &&
        scroller.firstElementChild
      ) {
        restoreBottomPadding(scroller);
        applyBottomPadding(scroller.firstElementChild, extraPx);
        clearanceTargetEl = scroller.firstElementChild;
      } else {
        clearanceTargetEl = target;
      }
      lastAppliedClearance = extraPx;
    }

    if (shouldScroll) {
      lastScrolledBatchId = activeId;
      requestAnimationFrame(() => {
        if (scroller && scroller.isConnected) {
          scroller.scrollTop = scroller.scrollHeight;
        }
      });
    }
  }

  function ensureApprovalDock() {
    let dock = document.getElementById('gla-approval-dock');
    if (!dock) {
      dock = document.createElement('div');
      dock.id = 'gla-approval-dock';
      dock.className = 'hidden';
      document.body.appendChild(dock);
      if (typeof ResizeObserver !== 'undefined') {
        if (dockResizeObserver) dockResizeObserver.disconnect();
        dockResizeObserver = new ResizeObserver(() => {
          if (hasDockContent()) syncScrollClearance(false);
        });
        dockResizeObserver.observe(dock);
      }
    }
    return dock;
  }

  function findGeminiComposerBox() {
    const input = getGeminiInput();
    if (!input) return null;
    const candidates = [
      input.closest('input-area-v2'),
      input.closest('.input-area-container'),
      input.closest('input-container'),
      input.closest('.text-input-field'),
      input.closest('.input-area'),
      input.parentElement,
      input,
    ].filter(Boolean);

    for (const el of candidates) {
      const rect = el.getBoundingClientRect();
      if (rect.width >= 260 && rect.width <= 1100 && rect.height >= 36 && rect.bottom > 0) {
        return el;
      }
    }
    return input;
  }

  function positionApprovalDock() {
    const dock = document.getElementById('gla-approval-dock');
    if (!dock || dock.classList.contains('hidden')) return;

    const composer = findGeminiComposerBox();
    if (composer) {
      if (composer !== observedComposerEl && typeof ResizeObserver !== 'undefined') {
        if (composerResizeObserver) composerResizeObserver.disconnect();
        composerResizeObserver = new ResizeObserver(() => positionApprovalDock());
        composerResizeObserver.observe(composer);
        const layoutHost = composer.closest('main, chat-window, .chat-container') || composer.parentElement;
        if (layoutHost && layoutHost !== composer) {
          composerResizeObserver.observe(layoutHost);
        }
        observedComposerEl = composer;
      }
      const rect = composer.getBoundingClientRect();
      if (rect.width >= 200 && rect.top > 0) {
        const maxAllowedWidth = Math.min(820, window.innerWidth - 24);
        const width = Math.min(Math.max(rect.width, 360), maxAllowedWidth);
        const centerX = rect.left + rect.width / 2;
        const left = Math.max(12, Math.min(centerX - width / 2, window.innerWidth - width - 12));
        const bottom = Math.max(16, Math.min(window.innerHeight - rect.top + 10, window.innerHeight - 120));
        dock.style.left = `${Math.round(left)}px`;
        dock.style.width = `${Math.round(width)}px`;
        dock.style.bottom = `${Math.round(bottom)}px`;
        return;
      }
    }

    const fallbackWidth = Math.min(720, window.innerWidth - 24);
    dock.style.left = `${Math.round((window.innerWidth - fallbackWidth) / 2)}px`;
    dock.style.width = `${Math.round(fallbackWidth)}px`;
    dock.style.bottom = '96px';
  }

  function updateExecElapsedLabel() {
    if (!state.executing || !state.executionInfo) return;
    const el = document.getElementById('gla-exec-elapsed');
    if (!el) return;
    const sec = Math.max(0, Math.floor((Date.now() - state.executionInfo.startedAt) / 1000));
    el.textContent = `${sec}s`;
  }

  function renderApprovalDock() {
    const dock = ensureApprovalDock();
    dock.classList.toggle('gla-light', resolveIsLightTheme());

    if (!hasDockContent()) {
      dock.classList.add('hidden');
      dock.innerHTML = '';
      clearScrollClearance();
      if (composerResizeObserver) {
        composerResizeObserver.disconnect();
        observedComposerEl = null;
      }
      return;
    }

    dock.classList.remove('hidden');

    const queuedHtml =
      state.queuedMessages.length > 0
        ? `
        <div class="gla-queued-box">
          <div class="gla-queued-head">${escapeHtml(t('queuedTitle', state.queuedMessages.length))}</div>
          ${state.queuedMessages
            .map(
              (item) => `
            <div class="gla-queued-item">
              <span class="gla-ellipsis gla-queued-text" title="${escapeHtml(item.text)}">${escapeHtml(item.text)}</span>
              <button class="gla-queued-del" data-gla-remove-queued="${escapeHtml(item.id)}" title="${escapeHtml(t('removeQueuedTooltip'))}">✕</button>
            </div>
          `
            )
            .join('')}
        </div>
      `
        : '';

    if (isExecutionActiveInCurrentView()) {
      const info = state.executionInfo;
      const elapsedSec = Math.max(0, Math.floor((Date.now() - info.startedAt) / 1000));
      dock.innerHTML = `
        <div class="gla-dock-stack">
          ${queuedHtml}
          <div class="gla-dock-card gla-dock-running">
            <span class="gla-spinner"></span>
            <span class="gla-dock-running-label">${escapeHtml(t('execRunning', [info.currentIndex, info.total]))}</span>
            <span class="gla-tag ${getToolTagClass(info)}">${escapeHtml(info.tool)}</span>
            <span class="gla-muted gla-ellipsis" style="flex:1;min-width:0;font-family:var(--gla-mono);font-size:11.5px;" title="${escapeHtml(info.summary)}">${escapeHtml(info.summary)}</span>
            <span class="gla-muted" id="gla-exec-elapsed" style="flex-shrink:0;font-family:var(--gla-mono);font-size:11px;">${elapsedSec}s</span>
          </div>
        </div>
      `;
      positionApprovalDock();
      syncScrollClearance(false);
      return;
    }

    if (!state.pendingBatch) {
      dock.innerHTML = `<div class="gla-dock-stack">${queuedHtml}</div>`;
      positionApprovalDock();
      syncScrollClearance(false);
      return;
    }

    const batch = state.pendingBatch;
    const pendingCount = batch.calls.length;
    const firstSummary = batch.previews[0]?.summary || batch.calls[0]?.tool || '';

    if (state.approvalCollapsed) {
      dock.innerHTML = `
        <div class="gla-dock-stack">
          ${queuedHtml}
          <div class="gla-dock-card gla-dock-compact ${batch.hasDangerous ? 'dangerous' : ''}">
            <span class="gla-dot busy"></span>
            <span class="gla-dock-compact-title">${escapeHtml(t('pendingTitle', pendingCount))}</span>
            <span class="gla-muted gla-ellipsis" style="flex:1;min-width:0;font-family:var(--gla-mono);font-size:11.5px;" title="${escapeHtml(firstSummary)}">${escapeHtml(firstSummary)}</span>
            <div class="gla-dock-compact-actions">
              <button class="gla-icon-btn" data-gla-action="toggle-approval-collapse" title="${escapeHtml(t('expandTooltip'))}">▴</button>
              <button class="gla-btn gla-btn-danger gla-btn-sm" data-gla-action="reject-batch">${escapeHtml(t('rejectBtn'))}</button>
              <button class="gla-btn gla-btn-success gla-btn-sm" data-gla-action="approve-batch">${escapeHtml(t('approveBtn'))}</button>
            </div>
          </div>
        </div>
      `;
      positionApprovalDock();
      syncScrollClearance(false);
      return;
    }

    dock.innerHTML = `
      <div class="gla-dock-stack">
        ${queuedHtml}
        <div class="gla-dock-card ${batch.hasDangerous ? 'dangerous' : ''}">
          <div class="gla-dock-header">
            <div class="gla-dock-title-group">
              <span class="gla-dot busy"></span>
              <span class="gla-dock-title">${escapeHtml(t('pendingTitle', pendingCount))}</span>
              ${batch.hasDangerous ? `<span class="gla-tag gla-tag-danger">${escapeHtml(t('highRiskTag'))}</span>` : ''}
            </div>
            <button class="gla-icon-btn" data-gla-action="toggle-approval-collapse" title="${escapeHtml(t('collapseTooltip'))}">▾</button>
          </div>
          ${
            batch.hitTurnLimit
              ? `<div class="gla-warning" style="margin:0;">${escapeHtml(t('turnLimitWarning', state.autoTurnCount))}</div>`
              : ''
          }
          <div class="gla-dock-items">
            ${batch.calls
              .map((call, idx) => {
                const p = batch.previews[idx] || {};
                return `
                  <div class="gla-tool-item ${p.dangerous ? 'dangerous' : ''}">
                    <div class="gla-tool-head">
                      <span class="gla-tag ${getToolTagClass(p)}">${escapeHtml(call.tool)}</span>
                      <span class="gla-muted">${escapeHtml(p.readOnly ? t('kindReadOnly') : t('kindWriteExec'))}</span>
                    </div>
                    <div class="gla-tool-summary" title="${escapeHtml(p.summary || call.tool)}">${escapeHtml(p.summary || call.tool)}</div>
                    ${p.warning ? `<div class="gla-warning">${escapeHtml(p.warning)}</div>` : ''}
                    ${
                      p.diff
                        ? `<pre class="gla-pre">${formatDiffHtml(p.diff)}</pre>`
                        : `<details style="margin-top:4px;"><summary class="gla-muted" style="cursor:pointer;">${escapeHtml(t('viewArgs'))}</summary><pre class="gla-pre">${escapeHtml(
                            JSON.stringify(call.args, null, 2)
                          )}</pre></details>`
                    }
                  </div>
                `;
              })
              .join('')}
          </div>
          <div class="gla-dock-actions">
            <span class="gla-muted gla-ellipsis gla-dock-hint" title="${escapeHtml(t('rejectNativeHint'))}">${escapeHtml(t('rejectNativeHint'))}</span>
            <div class="gla-dock-btns">
              <button class="gla-btn gla-btn-danger" data-gla-action="reject-batch">${escapeHtml(t('rejectBtn'))}</button>
              <button class="gla-btn gla-btn-success" data-gla-action="approve-batch">${escapeHtml(t('approveBtn'))}</button>
            </div>
          </div>
        </div>
      </div>
    `;
    positionApprovalDock();
    syncScrollClearance(false);
  }

  function applyPositionAndTheme(root) {
    root.classList.toggle('gla-light', resolveIsLightTheme());
    if (state.dragPos && state.drawerOpen) {
      const clampedLeft = Math.max(8, Math.min(state.dragPos.left, window.innerWidth - 120));
      const clampedTop = Math.max(8, Math.min(state.dragPos.top, window.innerHeight - 80));
      root.style.left = `${clampedLeft}px`;
      root.style.top = `${clampedTop}px`;
      root.style.right = 'auto';
      root.style.bottom = 'auto';
    } else {
      root.style.left = '';
      root.style.top = '';
      root.style.right = '18px';
      root.style.bottom = '20px';
    }
  }

  function getToolTagClass(preview) {
    if (preview.dangerous) return 'gla-tag-danger';
    if (preview.tool === 'run_command') return 'gla-tag-cmd';
    if (preview.readOnly) return 'gla-tag-read';
    return 'gla-tag-write';
  }

  function renderUI() {
    const root = ensureRoot();
    applyPositionAndTheme(root);

    const dotClass = state.bridgeConnected ? 'online' : '';
    const mode = state.settings.mode === 'auto' ? 'auto' : 'smart';
    const themeIcon =
      state.settings.theme === 'light' ? '☀️' : state.settings.theme === 'dark' ? '🌙' : '🌓';

    const isOtherPaired = state.bridgeErrorCode === 'ALREADY_PAIRED_OTHER';

    const boundWs = state.chatMode === 'agent' ? state.chatBoundWorkspace || '' : '';
    const boundWsName = getFolderDisplayName(boundWs);
    const boundWsMissing = Boolean(boundWs) && isWorkspaceKnownMissing(boundWs);
    const workspaceItems = getWorkspaceItems();
    const displayWorkspaces =
      state.chatMode === 'agent' &&
      boundWs &&
      !workspaceItems.some(
        (w) => normalizePathForCompare(w.path) === normalizePathForCompare(boundWs)
      )
        ? [{ path: boundWs, name: boundWsName, exists: !boundWsMissing, synthetic: true }, ...workspaceItems]
        : workspaceItems;

    const configOrWorkspaceHtml = !state.bridgeConnected
      ? `
        <div class="gla-card">
          <div class="gla-card-title">
            <span>${escapeHtml(t('setupTitle'))}</span>
            <span class="gla-muted">${escapeHtml(t('autoDetecting'))}</span>
          </div>
          ${
            isOtherPaired
              ? `
                <div class="gla-warning" style="margin-top:0;margin-bottom:6px;">
                  ${escapeHtml(t('pairedOtherWarning'))}
                </div>
                <div class="gla-guide-steps">
                  <div class="gla-step">
                    <span class="gla-step-num">1</span>
                    <div class="gla-step-body">
                      ${escapeHtml(t('pairedOtherStep1'))}
                      <div class="gla-cmd-box">
                        <span class="gla-ellipsis" title="node bridge/server.js --reset-pair">node bridge/server.js --reset-pair</span>
                        <button class="gla-btn gla-btn-xs" data-gla-copy="node bridge/server.js --reset-pair">${escapeHtml(t('copyBtn'))}</button>
                      </div>
                    </div>
                  </div>
                  <div class="gla-step">
                    <span class="gla-step-num">2</span>
                    <div class="gla-step-body">${escapeHtml(t('pairedOtherStep2'))}</div>
                  </div>
                </div>
              `
              : `
                <div class="gla-guide-steps" style="margin-top:2px;">
                  <div class="gla-step">
                    <span class="gla-step-num">1</span>
                    <div class="gla-step-body">
                      ${escapeHtml(t('setupStep1'))}
                      <div class="gla-cmd-box">
                        <span class="gla-ellipsis" title="node bridge/server.js">node bridge/server.js</span>
                        <button class="gla-btn gla-btn-xs" data-gla-copy="node bridge/server.js">${escapeHtml(t('copyBtn'))}</button>
                      </div>
                    </div>
                  </div>
                  <div class="gla-step">
                    <span class="gla-step-num">2</span>
                    <div class="gla-step-body">${escapeHtml(t('setupStep2'))}</div>
                  </div>
                </div>
              `
          }
          <details style="margin-top:8px;">
            <summary class="gla-muted" style="cursor:pointer;">${escapeHtml(t('advancedSettings'))}</summary>
            <div style="display:flex;flex-direction:column;gap:6px;margin-top:6px;">
              <input class="gla-input" id="gla-cfg-url" placeholder="http://127.0.0.1:3847" value="${escapeHtml(state.settings.bridgeUrl)}" />
              <input class="gla-input" id="gla-cfg-token" type="password" placeholder="${escapeHtml(t('pairingTokenPlaceholder'))}" value="${escapeHtml(state.settings.token)}" />
              <button class="gla-btn gla-btn-sm" data-gla-action="save-connect">${escapeHtml(t('saveAndReconnect'))}</button>
            </div>
          </details>
        </div>
      `
      : `
        <div class="gla-card">
          <div class="gla-card-title">
            <span>${escapeHtml(t('workspacesTitle'))} (${displayWorkspaces.length})</span>
            <button class="gla-btn gla-btn-xs" data-gla-action="pick-ws-native" ${state.pickingFolder ? 'disabled' : ''}>
              ${escapeHtml(state.pickingFolder ? t('pickingWorkspace') : t('addWorkspace'))}
            </button>
          </div>
          <div class="gla-ws-list">
            ${
              displayWorkspaces.length === 0
                ? `<div class="gla-muted" style="text-align:center;padding:12px 0;">${escapeHtml(t('emptyWorkspaces'))}</div>`
                : displayWorkspaces
                    .map((ws) => {
                      const isSelected =
                        state.chatMode === 'agent' &&
                        Boolean(boundWs) &&
                        normalizePathForCompare(ws.path) === normalizePathForCompare(boundWs);
                      const canRemove = !ws.synthetic && !(state.chatLocked && isSelected);
                      const isSelectable = !state.chatLocked && ws.exists && !isSelected;
                      const itemClasses = [
                        'gla-ws-item',
                        isSelected ? 'active' : '',
                        state.chatLocked ? 'locked' : '',
                        !ws.exists ? 'missing' : '',
                      ]
                        .filter(Boolean)
                        .join(' ');

                      const wsTitle =
                        state.chatLocked && !isSelected
                          ? `${ws.path}\n${
                              state.chatMode === 'normal'
                                ? t('wsLockedNormalTooltip')
                                : t('wsLockedAgentTooltip')
                            }`
                          : !ws.exists
                          ? `${ws.path}\n${t('workspaceMissing')}`
                          : ws.path;

                      return `
                        <div class="${itemClasses}" ${isSelectable ? `data-gla-select-ws="${escapeHtml(ws.path)}"` : ''} title="${escapeHtml(wsTitle)}">
                          <span class="gla-dot ${isSelected ? (ws.exists ? 'online' : 'busy') : ''}" style="${isSelected ? '' : 'opacity:0.25;background:var(--gla-text-muted);'}"></span>
                          <div class="gla-ws-item-body">
                            <div class="gla-ws-item-name">📁 ${escapeHtml(ws.name)}</div>
                            <div class="gla-ws-item-path">${escapeHtml(ws.path)}</div>
                          </div>
                          ${!ws.exists ? `<span class="gla-ws-missing-tag">${escapeHtml(t('workspaceInvalidTag'))}</span>` : ''}
                          ${
                            canRemove
                              ? `<button class="gla-ws-del" data-gla-remove-ws="${escapeHtml(ws.path)}" title="${escapeHtml(t('removeWorkspaceTooltip'))}">✕</button>`
                              : ''
                          }
                        </div>
                      `;
                    })
                    .join('')
            }
          </div>
        </div>
      `;

    const isNormalSelected = state.chatMode === 'normal';
    const normalClasses = [
      'gla-session-bar',
      isNormalSelected ? 'active' : '',
      state.chatLocked ? 'locked' : '',
      !isNormalSelected && !state.chatLocked ? 'clickable' : '',
    ]
      .filter(Boolean)
      .join(' ');
    const normalTitle =
      !isNormalSelected && state.chatLocked
        ? t('normalLockedByAgentTooltip')
        : !isNormalSelected
        ? t('switchToNormal')
        : t('normalChat');
    const normalRightHtml =
      isNormalSelected && !state.chatLocked
        ? `<span class="gla-muted gla-ellipsis" style="font-size:11px;max-width:190px;" title="${escapeHtml(t('selectWorkspaceHint'))}">${escapeHtml(t('selectWorkspaceHint'))}</span>`
        : !isNormalSelected && !state.chatLocked
        ? `<span class="gla-muted" style="font-size:11px;flex-shrink:0;">${escapeHtml(t('switchToNormal'))}</span>`
        : '';

    const sessionBarHtml = state.bridgeConnected
      ? `
        <div class="${normalClasses}" ${!isNormalSelected && !state.chatLocked ? 'data-gla-action="set-chat-normal"' : ''} title="${escapeHtml(normalTitle)}">
          <div class="gla-session-bar-left">
            <span class="gla-dot ${isNormalSelected ? 'online' : ''}" style="${isNormalSelected ? '' : 'opacity:0.25;background:var(--gla-text-muted);'}"></span>
            <div class="gla-session-title">💬 ${escapeHtml(t('normalChat'))}</div>
          </div>
          ${normalRightHtml}
        </div>
      `
      : '';

    const consoleTabHtml = `
      ${sessionBarHtml}
      ${configOrWorkspaceHtml}

      <div class="gla-card">
        <div class="gla-card-title">
          <span>${escapeHtml(t('approvalPolicy'))}</span>
          <span class="gla-muted">${escapeHtml(t('autoTurns', [state.autoTurnCount, state.settings.maxAutoTurns]))}</span>
        </div>
        <div class="gla-segmented" style="margin-bottom:4px;">
          <button class="gla-seg-btn ${mode === 'smart' ? 'active' : ''}" data-gla-mode="smart">${escapeHtml(t('modeRead'))}</button>
          <button class="gla-seg-btn ${mode === 'auto' ? 'active' : ''}" data-gla-mode="auto">${escapeHtml(t('modeAuto'))}</button>
        </div>
        <div class="gla-muted gla-ellipsis" style="font-size:11px;" title="${escapeHtml(mode === 'smart' ? t('modeReadDesc') : t('modeAutoDesc'))}">
          ${escapeHtml(mode === 'smart' ? t('modeReadDesc') : t('modeAutoDesc'))}
        </div>
      </div>
    `;

    const displayLogs = state.bridgeLogs.length > 0 ? state.bridgeLogs : state.sessionLogs;

    const logsTabHtml = `
      <div class="gla-card gla-logs-card">
        <div class="gla-card-title">
          <span>${escapeHtml(t('logsTitle', displayLogs.length))}</span>
          <button class="gla-btn gla-btn-xs" data-gla-action="export-logs" ${!state.bridgeConnected ? 'disabled' : ''}>${escapeHtml(t('exportLogs'))}</button>
        </div>
        ${
          state.bridgeInfo?.logDir
            ? `<div class="gla-muted gla-ellipsis" style="flex-shrink:0;font-family:var(--gla-mono);font-size:10.5px;margin-bottom:6px;" title="${escapeHtml(
                state.bridgeInfo.logDir
              )}">${escapeHtml(state.bridgeInfo.logDir)}</div>`
            : ''
        }
        <div class="gla-list">
          ${
            displayLogs.length === 0
              ? `<div class="gla-muted" style="text-align:center;padding:12px 0;">${escapeHtml(t('noLogs'))}</div>`
              : displayLogs
                  .slice(0, 60)
                  .map((log) => {
                    const timeStr = log.timestamp
                      ? new Date(log.timestamp).toLocaleTimeString()
                      : log.time || '';
                    const detailText =
                      log.detail || log.error || (log.args ? JSON.stringify(log.args, null, 2) : '');
                    const summaryLine = `${log.tool} ${log.summary || ''}`.trim();
                    return `
                    <details class="gla-log-entry">
                      <summary>
                        <span class="gla-ellipsis" style="flex:1;min-width:0;" title="${escapeHtml(summaryLine)}">
                          <span class="${log.ok ? 'gla-log-ok' : 'gla-log-err'}">${log.ok ? '●' : '✖'}</span>
                          <strong>${escapeHtml(log.tool)}</strong>
                          <span class="gla-muted"> ${escapeHtml(log.summary || '')}</span>
                        </span>
                        <span class="gla-muted" style="flex-shrink:0;">${escapeHtml(
                          log.durationMs != null ? `${log.durationMs}ms` : timeStr
                        )}</span>
                      </summary>
                      ${detailText ? `<pre class="gla-pre">${escapeHtml(detailText)}</pre>` : ''}
                    </details>
                  `;
                  })
                  .join('')
          }
        </div>
      </div>
    `;

    // Orthogonal floating pill:
    // Dot = connection/workspace health (red offline, green online, amber missing workspace)
    // Label = conversation identity (Normal Chat vs bound Workspace, independent of connection state)
    const isAgentChat = state.chatMode === 'agent' && Boolean(boundWs);
    const fabClasses = [
      'gla-fab',
      state.drawerOpen ? 'hidden' : '',
      !isAgentChat ? 'gla-fab-normal' : '',
      boundWsMissing ? 'gla-fab-mismatch' : '',
    ]
      .filter(Boolean)
      .join(' ');

    const fabDotClass = !state.bridgeConnected ? '' : boundWsMissing ? 'busy' : 'online';

    const fabLabelHtml = isAgentChat
      ? `<span class="gla-fab-ws">📁 ${escapeHtml(boundWsName)}${boundWsMissing ? ` (${escapeHtml(t('workspaceInvalidTag'))})` : ''}</span>`
      : `<span>💬 ${escapeHtml(t('normalChat'))}</span>`;

    const fabTitle = !isAgentChat
      ? state.bridgeConnected
        ? t('fabTooltipOnlineNormal')
        : t('fabTooltipOfflineNormal')
      : !state.bridgeConnected
      ? t('fabTooltipOfflineAgent', boundWs)
      : boundWsMissing
      ? t('fabTooltipMissing', boundWs)
      : t('fabTooltipOnlineAgent', boundWs);

    root.innerHTML = `
      <button class="${fabClasses}" data-gla-action="open-drawer" title="${escapeHtml(fabTitle)}">
        <span class="gla-dot ${fabDotClass}"></span>
        ${fabLabelHtml}
      </button>

      <div class="gla-panel ${state.drawerOpen ? '' : 'hidden'}">
        <div class="gla-header" id="gla-drag-handle" title="${escapeHtml(t('dragTooltip'))}">
          <div class="gla-title-group">
            <div class="gla-logo">&gt;_</div>
            <span class="gla-title">Local Agent</span>
            <span class="gla-status-pill">
              <span class="gla-dot ${dotClass}"></span>
              ${escapeHtml(state.executing ? t('statusExecuting') : state.bridgeConnected ? t('statusOnline') : t('statusOffline'))}
            </span>
          </div>
          <div class="gla-header-actions">
            <button class="gla-icon-btn" data-gla-action="cycle-theme" title="${escapeHtml(t('toggleThemeTooltip'))}">${themeIcon}</button>
            <button class="gla-icon-btn" data-gla-action="close-drawer" title="${escapeHtml(t('collapseTooltip'))}">✕</button>
          </div>
        </div>

        <div class="gla-tabs">
          <button class="gla-tab ${state.activeTab === 'console' ? 'active' : ''}" data-gla-tab="console">
            ${escapeHtml(t('tabConsole'))}
          </button>
          <button class="gla-tab ${state.activeTab === 'logs' ? 'active' : ''}" data-gla-tab="logs">
            ${escapeHtml(t('tabLogs'))}
          </button>
        </div>

        <div class="gla-body">
          ${state.activeTab === 'logs' ? logsTabHtml : consoleTabHtml}
        </div>
        ${state.toast ? `<div class="gla-toast ${state.toast.isError ? 'error' : ''}">${escapeHtml(state.toast.text)}</div>` : ''}
      </div>
    `;

    renderApprovalDock();
  }

  function bindRootEvents() {
    const root = ensureRoot();

    let dragging = null;
    root.addEventListener('mousedown', (e) => {
      const handle = e.target.closest('#gla-drag-handle');
      if (!handle || e.target.closest('button')) return;
      const rect = root.getBoundingClientRect();
      dragging = { offsetX: e.clientX - rect.left, offsetY: e.clientY - rect.top };
      e.preventDefault();
    });

    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      state.dragPos = {
        left: Math.max(8, Math.min(e.clientX - dragging.offsetX, window.innerWidth - 160)),
        top: Math.max(8, Math.min(e.clientY - dragging.offsetY, window.innerHeight - 80)),
      };
      applyPositionAndTheme(root);
    });

    window.addEventListener('mouseup', () => {
      dragging = null;
    });

    root.addEventListener('dblclick', (e) => {
      if (e.target.closest('#gla-drag-handle') && !e.target.closest('button')) {
        state.dragPos = null;
        applyPositionAndTheme(root);
      }
    });

    root.addEventListener('click', async (e) => {
      const tabBtn = e.target.closest('[data-gla-tab]');
      if (tabBtn) {
        state.activeTab = tabBtn.getAttribute('data-gla-tab');
        if (state.activeTab === 'logs' && state.bridgeConnected) {
          await refreshBridgeData(true);
        } else {
          renderUI();
        }
        return;
      }

      const modeBtn = e.target.closest('[data-gla-mode]');
      if (modeBtn) {
        const nextMode = modeBtn.getAttribute('data-gla-mode');
        const res = await sendBg({ type: 'SAVE_SETTINGS', patch: { mode: nextMode } });
        if (res.ok) state.settings = res.settings;
        renderUI();
        return;
      }

      const copyBtn = e.target.closest('[data-gla-copy]');
      if (copyBtn) {
        await copyToClipboard(copyBtn.getAttribute('data-gla-copy'), copyBtn);
        return;
      }

      const removeWsBtn = e.target.closest('[data-gla-remove-ws]');
      if (removeWsBtn) {
        e.preventDefault();
        e.stopPropagation();
        await removeWorkspacePath(removeWsBtn.getAttribute('data-gla-remove-ws'));
        return;
      }

      const selectWsBtn = e.target.closest('[data-gla-select-ws]');
      if (selectWsBtn) {
        selectWorkspaceForNewChat(selectWsBtn.getAttribute('data-gla-select-ws'));
        return;
      }

      const actionBtn = e.target.closest('[data-gla-action]');
      if (!actionBtn) return;
      const action = actionBtn.getAttribute('data-gla-action');

      switch (action) {
        case 'open-drawer': {
          const oldFloat = document.getElementById('gla-floating-toast');
          if (oldFloat) oldFloat.remove();
          state.drawerOpen = true;
          renderUI();
          refreshBridgeData(true);
          break;
        }
        case 'close-drawer':
          state.drawerOpen = false;
          renderUI();
          break;
        case 'cycle-theme': {
          const order = ['auto', 'dark', 'light'];
          const next = order[(order.indexOf(state.settings.theme || 'auto') + 1) % order.length];
          const res = await sendBg({ type: 'SAVE_SETTINGS', patch: { theme: next } });
          if (res.ok) state.settings = res.settings;
          renderUI();
          break;
        }
        case 'save-connect': {
          const urlInput = document.getElementById('gla-cfg-url');
          const tokenInput = document.getElementById('gla-cfg-token');
          const res = await sendBg({
            type: 'SAVE_SETTINGS',
            patch: {
              bridgeUrl: urlInput?.value || state.settings.bridgeUrl,
              token: tokenInput?.value || '',
            },
          });
          if (!res.ok) {
            showToast(res.error || 'Failed to save settings', true);
            return;
          }
          state.settings = res.settings;
          await refreshBridgeData(false);
          break;
        }
        case 'pick-ws-native':
          await pickWorkspaceNative();
          break;
        case 'set-chat-normal':
          resetBlankChatToNormal();
          break;
        case 'export-logs':
          await handleExportLogs();
          break;
      }
    });
  }

  function bindApprovalDockEvents() {
    const dock = ensureApprovalDock();

    window.addEventListener('resize', () => {
      positionApprovalDock();
      applyPositionAndTheme(ensureRoot());
    });

    dock.addEventListener('click', async (e) => {
      const removeQueuedBtn = e.target.closest('[data-gla-remove-queued]');
      if (removeQueuedBtn) {
        const qId = removeQueuedBtn.getAttribute('data-gla-remove-queued');
        state.queuedMessages = state.queuedMessages.filter((m) => m.id !== qId);
        renderApprovalDock();
        return;
      }

      const actionBtn = e.target.closest('[data-gla-action]');
      if (!actionBtn) return;
      const action = actionBtn.getAttribute('data-gla-action');

      switch (action) {
        case 'toggle-approval-collapse':
          state.approvalCollapsed = !state.approvalCollapsed;
          renderApprovalDock();
          break;
        case 'approve-batch':
          if (state.pendingBatch) {
            if (state.pendingBatch.hitTurnLimit) state.autoTurnCount = 0;
            await executeToolBatch(state.pendingBatch);
          }
          break;
        case 'reject-batch':
          if (state.pendingBatch) {
            const rawInput = readGeminiInputText();
            const reason =
              rawInput &&
              !rawInput.startsWith('[LOCAL_AGENT_SYSTEM_PROMPT]') &&
              !rawInput.startsWith('[LOCAL_AGENT_TOOL_RESULT]')
                ? rawInput
                : '';
            await rejectToolBatch(state.pendingBatch, reason);
          }
          break;
      }
    });
  }

  // Intercept user's manual send to enforce session isolation and mount protocol on first Agent turn
  function bindUserSendInterceptor() {
    const maybeInterceptSend = (e) => {
      if (state.isExtensionSending) return;
      if (state.autoMounting) {
        e.preventDefault();
        e.stopImmediatePropagation();
        e.stopPropagation();
        return;
      }

      const userText = readGeminiInputText();
      if (!userText) return;
      state.autoTurnCount = 0;

      if (!state.bridgeConnected) {
        if (state.chatMode === 'agent' && (!isConversationAlreadyMounted() || state.pendingBatch)) {
          e.preventDefault();
          e.stopImmediatePropagation();
          e.stopPropagation();
          showToast(state.bridgeError || t('statusOffline'), true);
        }
        return;
      }

      if (state.chatMode !== 'agent') {
        const wasLocked = state.chatLocked;
        state.chatLocked = true;
        clearHydrationTimers();
        if (!getCurrentChatId()) {
          state.pendingNewChat = {
            mode: 'normal',
            workspace: null,
            mounted: false,
            locked: true,
            createdAt: Date.now(),
          };
        }
        if (!wasLocked) renderUI();
        return;
      }

      if (
        userText.startsWith('[LOCAL_AGENT_SYSTEM_PROMPT]') ||
        userText.startsWith('[LOCAL_AGENT_TOOL_RESULT]')
      ) {
        return;
      }

      // Queue user follow-up messages sent while local tools are executing (including during result submission)
      if (isExecutionActiveInCurrentView()) {
        e.preventDefault();
        e.stopImmediatePropagation();
        e.stopPropagation();
        if (state.submittingResults) {
          return;
        }
        if (state.queuedMessages.length < 10) {
          state.queuedMessages.push({
            id: `q_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            text: userText,
          });
          clearGeminiInput();
          renderApprovalDock();
        } else {
          showToast(t('queuedTitle', state.queuedMessages.length), true);
        }
        return;
      }

      // Reuse Gemini's native input box: sending while approval is pending rejects with feedback
      if (state.pendingBatch) {
        e.preventDefault();
        e.stopImmediatePropagation();
        e.stopPropagation();
        rejectToolBatch(state.pendingBatch, userText);
        return;
      }

      if (isConversationAlreadyMounted()) {
        state.hasSentInCurrentView = true;
        return;
      }

      e.preventDefault();
      e.stopImmediatePropagation();
      e.stopPropagation();
      wrapAndSendUserMessage(userText);
    };

    document.addEventListener(
      'click',
      (e) => {
        if (
          state.isExtensionSending ||
          e.target.closest('#gla-root') ||
          e.target.closest('#gla-approval-dock')
        ) {
          return;
        }
        // Navigating explicitly to another chat or new chat cancels any pending blank-chat binding
        if (
          state.pendingNewChat &&
          e.target.closest(
            'a[href*="/app/"], a[href*="/gem/"], a[href="/app"], [data-test-id="conversation"], [data-test-id="new-chat-button"]'
          )
        ) {
          state.pendingNewChat = null;
        }
        const sendBtn = findSendButton();
        if (sendBtn && (e.target === sendBtn || sendBtn.contains(e.target))) {
          maybeInterceptSend(e);
        }
      },
      true
    );

    document.addEventListener(
      'keydown',
      (e) => {
        if (
          state.isExtensionSending ||
          e.target.closest('#gla-root') ||
          e.target.closest('#gla-approval-dock')
        ) {
          return;
        }
        if (e.key === 'Enter' && !e.shiftKey && !e.altKey && !e.isComposing && e.keyCode !== 229) {
          const input = getGeminiInput();
          if (input && (e.target === input || input.contains(e.target))) {
            maybeInterceptSend(e);
          }
        }
      },
      true
    );
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.localAgentSettings?.newValue) {
      state.settings = { ...state.settings, ...changes.localAgentSettings.newValue };
      refreshBridgeData(true);
    }
    if (changes.localAgentChatModes?.newValue) {
      state.chatModes = { ...state.chatModes, ...changes.localAgentChatModes.newValue };
      saveLocalChatStore();
      syncCurrentConversation();
    }
  });

  // ==================== Initialization ====================

  async function init() {
    // Hydrate persisted chat modes synchronously from localStorage (0ms restore on refresh)
    const localChatStore = loadLocalChatStore();
    state.chatModes = localChatStore.chatModes;

    try {
      const direct = await chrome.storage.local.get(['localAgentChatModes']);
      if (direct?.localAgentChatModes) {
        for (const [cid, rec] of Object.entries(direct.localAgentChatModes)) {
          if (!state.chatModes[cid] || (rec?.updatedAt || 0) > (state.chatModes[cid]?.updatedAt || 0)) {
            state.chatModes[cid] = rec;
          }
        }
        saveLocalChatStore();
      }
    } catch {
      // Ignore storage read error
    }

    const settingsRes = await sendBg({ type: 'GET_SETTINGS' });
    if (settingsRes.ok && settingsRes.settings) {
      state.settings = settingsRes.settings;
    }

    bindRootEvents();
    bindApprovalDockEvents();
    bindUserSendInterceptor();
    window.addEventListener('popstate', () => handleUrlChangeIfNeeded());
    await syncCurrentConversation();
    markAnsweredResponsesAsHistory();
    renderUI();
    await refreshBridgeData(true);
    scanLatestResponse();

    scheduleHydrationResync([1000, 2200]);

    let debounceTimer = null;
    const observer = new MutationObserver(() => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => scanLatestResponse(), 300);
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });

    setInterval(() => {
      handleUrlChangeIfNeeded();
      if (hasDockContent()) {
        positionApprovalDock();
        updateExecElapsedLabel();
      }
    }, 250);

    setInterval(() => {
      scanLatestResponse();
    }, 650);

    // Background connection & log monitor (no manual refresh buttons needed)
    let healthPolling = false;
    setInterval(async () => {
      if (healthPolling || document.hidden || state.executing || state.autoMounting) return;
      const activeEditable = document.activeElement?.matches(
        '#gla-root input, #gla-root textarea, #gla-approval-dock input, #gla-approval-dock textarea'
      );
      const openDetails = document.querySelector('#gla-root details[open], #gla-approval-dock details[open]');
      if (activeEditable || openDetails) return;

      healthPolling = true;
      try {
        // Keep auto theme in sync if Gemini's own dark/light theme is toggled
        if (state.settings.theme === 'auto') {
          const isLight = resolveIsLightTheme();
          const rootEl = document.getElementById('gla-root');
          const dockEl = document.getElementById('gla-approval-dock');
          if (rootEl) rootEl.classList.toggle('gla-light', isLight);
          if (dockEl) dockEl.classList.toggle('gla-light', isLight);
        }

        const health = await sendBg({ type: 'BRIDGE_HEALTH' });
        if (health.ok && !state.bridgeConnected) {
          await refreshBridgeData(true);
          scanLatestResponse();
        } else if (!health.ok && state.bridgeConnected) {
          if (state.pendingBatch?.responseKey) {
            state.processedFingerprints.delete(state.pendingBatch.responseKey);
            if (state.pendingBatch.responseEl) {
              delete state.pendingBatch.responseEl.dataset.glaProcessed;
              state.pendingBatch.responseEl.dataset.glaRecovered = '1';
            }
          }
          state.bridgeConnected = false;
          state.bridgeInfo = null;
          state.pendingBatch = null;
          renderUI();
        } else if (
          health.ok &&
          state.bridgeConnected &&
          state.chatMode === 'agent' &&
          state.chatBoundWorkspace &&
          isWorkspaceKnownMissing(state.chatBoundWorkspace)
        ) {
          // Quietly watch for a missing/removed workspace to be restored without flickering the UI
          const info = await sendBg({ type: 'BRIDGE_INFO' });
          if (info.ok) {
            state.bridgeInfo = info;
            if (!isWorkspaceKnownMissing(state.chatBoundWorkspace)) {
              renderUI();
              scanLatestResponse();
            }
          }
        } else if (health.ok && state.bridgeConnected && state.drawerOpen && state.activeTab === 'logs') {
          const logRes = await sendBg({ type: 'BRIDGE_LOGS', limit: 80 });
          if (logRes?.ok) {
            const nextLogs = logRes.logs || [];
            const prevHead = state.bridgeLogs[0]?.id;
            const nextHead = nextLogs[0]?.id;
            if (prevHead !== nextHead || nextLogs.length !== state.bridgeLogs.length) {
              state.bridgeLogs = nextLogs;
              renderUI();
            }
          }
        }
      } finally {
        healthPolling = false;
      }
    }, 3500);
  }

  init();
})();
