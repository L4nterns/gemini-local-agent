(function (global) {
  const PENDING_NEW_CHAT_TTL_MS = 5 * 60 * 1000;

  function getChatIdFromPath(pathname) {
    const match = String(pathname || '').match(/\/(?:app|gem\/[^/?#]+)\/([^/?#]+)/);
    return match ? match[1] : null;
  }

  function parseUrlParts(urlStr) {
    try {
      const parsed = new URL(urlStr, 'https://gemini.google.com');
      return {
        pathname: parsed.pathname,
        chatId: getChatIdFromPath(parsed.pathname),
      };
    } catch {
      return { pathname: '', chatId: null };
    }
  }

  /**
   * Parse a user-query text block to detect whether it carries a mounted Local Agent prompt.
   * Handles both raw Markdown ("- Workspace: ...") and Gemini rich-formatted list items ("Workspace: ...").
   */
  function extractAgentPromptInfo(queryText) {
    const text = String(queryText || '');
    if (!text.includes('[LOCAL_AGENT_SYSTEM_PROMPT]')) {
      return { isAgentPrompt: false, workspace: null };
    }
    const hasPromptStructure =
      text.includes('## Tool Call Protocol') ||
      text.includes('## Available Tools') ||
      text.includes('## Environment');
    if (!hasPromptStructure) {
      return { isAgentPrompt: false, workspace: null };
    }

    const wsMatch = text.match(/^\s*(?:[-*•]\s*)?Workspace:\s*([^\r\n]+)/m);
    const workspace = wsMatch ? wsMatch[1].trim() : null;
    return {
      isAgentPrompt: true,
      workspace: workspace || null,
    };
  }

  /**
   * Classify a conversation from the rendered user queries and model response count.
   * Returns:
   * - { detected: 'agent', workspace } when a mounted prompt with workspace is found
   * - { detected: 'agent_partial', workspace: null } when the prompt marker is present without a parseable workspace
   * - { detected: 'normal', workspace: null } when messages exist without any agent prompt marker
   * - { detected: 'empty', workspace: null } when no messages have hydrated yet
   */
  function detectConversationFromSnapshot({ queryTexts = [] } = {}) {
    const nonEmptyQueries = queryTexts.map((raw) => String(raw || '').trim()).filter(Boolean);
    let sawPartialAgent = false;
    for (const text of nonEmptyQueries) {
      const info = extractAgentPromptInfo(text);
      if (info.isAgentPrompt) {
        if (info.workspace) {
          return { detected: 'agent', workspace: info.workspace };
        }
        sawPartialAgent = true;
      }
    }
    if (sawPartialAgent) {
      return { detected: 'agent_partial', workspace: null };
    }
    if (nonEmptyQueries.length > 0) {
      return { detected: 'normal', workspace: null };
    }
    return { detected: 'empty', workspace: null };
  }

  function isPendingNewChatActive(pendingNewChat, now = Date.now()) {
    return Boolean(
      pendingNewChat &&
        typeof pendingNewChat.createdAt === 'number' &&
        now - pendingNewChat.createdAt < PENDING_NEW_CHAT_TTL_MS
    );
  }

  /**
   * Decide how a URL transition should affect the current view state.
   */
  function classifyUrlChange({ prevUrl, nextUrl, chatModes = {}, pendingNewChat = null, now = Date.now() }) {
    if (prevUrl === nextUrl) {
      return { action: 'none', nextChatId: parseUrlParts(nextUrl).chatId };
    }
    const prev = parseUrlParts(prevUrl);
    const next = parseUrlParts(nextUrl);

    // Same conversation path (only query/hash changed): never reset active state
    if (prev.pathname === next.pathname && prev.chatId === next.chatId) {
      return { action: 'ignore', nextChatId: next.chatId };
    }

    // Blank chat (/app) just received its first server-assigned chatId
    if (!prev.chatId && next.chatId && !chatModes[next.chatId] && isPendingNewChatActive(pendingNewChat, now)) {
      return { action: 'bind_new_chat', nextChatId: next.chatId };
    }

    return { action: 'switch_chat', nextChatId: next.chatId };
  }

  /**
   * Pure state transition for syncing the current conversation from URL, cache, pendingNewChat, and DOM.
   */
  function resolveConversationSync({
    chatId,
    storedRecord = null,
    pendingNewChat = null,
    domState = { detected: 'empty', workspace: null },
    currentChatMode = 'normal',
    currentBoundWorkspace = null,
    now = Date.now(),
  }) {
    const pendingActive = isPendingNewChatActive(pendingNewChat, now);

    // 1. Blank chat (no chatId yet)
    if (!chatId) {
      if (pendingActive) {
        const mode = pendingNewChat.mode === 'agent' ? 'agent' : 'normal';
        return {
          chatLocked: Boolean(pendingNewChat.locked),
          chatMode: mode,
          chatBoundWorkspace: mode === 'agent' ? pendingNewChat.workspace || null : null,
          conversationMounted: mode === 'agent' && Boolean(pendingNewChat.mounted),
          clearPendingNewChat: false,
          persistRecord: null,
        };
      }
      const keepSelectedAgent = currentChatMode === 'agent' && Boolean(currentBoundWorkspace);
      return {
        chatLocked: false,
        chatMode: keepSelectedAgent ? 'agent' : 'normal',
        chatBoundWorkspace: keepSelectedAgent ? currentBoundWorkspace : null,
        conversationMounted: false,
        clearPendingNewChat: Boolean(pendingNewChat),
        persistRecord: null,
      };
    }

    // 2. First assignment of chatId to a just-sent blank chat
    if (!storedRecord && pendingActive) {
      const pendingMode = pendingNewChat.mode === 'agent' ? 'agent' : 'normal';
      const domContradicts =
        (pendingMode === 'agent' && domState.detected === 'normal') ||
        (pendingMode === 'normal' && domState.detected === 'agent');

      if (!domContradicts) {
        const workspace =
          pendingMode === 'agent' ? domState.workspace || pendingNewChat.workspace || null : null;
        const mounted = pendingMode === 'agent' && Boolean(pendingNewChat.mounted);
        return {
          chatLocked: true,
          chatMode: pendingMode,
          chatBoundWorkspace: workspace,
          conversationMounted: mounted,
          clearPendingNewChat: true,
          persistRecord: {
            mode: pendingMode,
            workspace,
            mounted,
            locked: true,
          },
        };
      }
      // Contradicted (e.g., user jumped to a different existing chat): fall through to DOM detection
    }

    // 3. Cached chat record (with self-healing upgrade if DOM proves it is an Agent chat)
    if (storedRecord) {
      if (storedRecord.mode !== 'agent' && domState.detected === 'agent' && domState.workspace) {
        return {
          chatLocked: true,
          chatMode: 'agent',
          chatBoundWorkspace: domState.workspace,
          conversationMounted: true,
          clearPendingNewChat: true,
          persistRecord: {
            mode: 'agent',
            workspace: domState.workspace,
            mounted: true,
            locked: true,
          },
        };
      }
      const mode = storedRecord.mode === 'agent' ? 'agent' : 'normal';
      return {
        chatLocked: true,
        chatMode: mode,
        chatBoundWorkspace: mode === 'agent' ? storedRecord.workspace || null : null,
        conversationMounted:
          mode === 'agent' && (Boolean(storedRecord.mounted) || domState.detected === 'agent'),
        clearPendingNewChat: true,
        persistRecord: null,
      };
    }

    // 4. Uncached existing chat: classify from DOM ground truth
    if (domState.detected === 'agent' && domState.workspace) {
      return {
        chatLocked: true,
        chatMode: 'agent',
        chatBoundWorkspace: domState.workspace,
        conversationMounted: true,
        clearPendingNewChat: true,
        persistRecord: {
          mode: 'agent',
          workspace: domState.workspace,
          mounted: true,
          locked: true,
        },
      };
    }

    if (domState.detected === 'normal') {
      return {
        chatLocked: true,
        chatMode: 'normal',
        chatBoundWorkspace: null,
        conversationMounted: false,
        clearPendingNewChat: true,
        persistRecord: {
          mode: 'normal',
          workspace: null,
          mounted: false,
          locked: true,
        },
      };
    }

    // Empty or partial DOM (still hydrating): do not persist a premature 'normal' record
    return {
      chatLocked: true,
      chatMode: 'normal',
      chatBoundWorkspace: null,
      conversationMounted: false,
      clearPendingNewChat: true,
      persistRecord: null,
    };
  }

  const api = {
    PENDING_NEW_CHAT_TTL_MS,
    getChatIdFromPath,
    extractAgentPromptInfo,
    detectConversationFromSnapshot,
    isPendingNewChatActive,
    classifyUrlChange,
    resolveConversationSync,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    global.LocalAgentSession = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : window);
