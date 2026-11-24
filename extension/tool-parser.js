(function (global) {
  const KNOWN_TOOLS = new Set([
    'list_dir',
    'find_files',
    'grep_search',
    'read_file',
    'write_file',
    'edit_file',
    'run_command',
  ]);

  const READ_ONLY_TOOLS = new Set([
    'list_dir',
    'find_files',
    'grep_search',
    'read_file',
  ]);

  function simpleHash(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(36);
  }

  function tryParseJson(rawText) {
    if (!rawText || typeof rawText !== 'string') return null;
    const trimmed = rawText.trim();
    if (!trimmed.startsWith('{')) return null;

    try {
      return JSON.parse(trimmed);
    } catch {
      try {
        const cleaned = trimmed.replace(/,\s*([}\]])/g, '$1');
        return JSON.parse(cleaned);
      } catch {
        return null;
      }
    }
  }

  function normalizePayload(parsed) {
    if (!parsed || typeof parsed !== 'object' || parsed.$local_agent !== true) {
      return null;
    }

    if (!Array.isArray(parsed.calls)) {
      return null;
    }

    const validCalls = [];
    for (const item of parsed.calls) {
      if (!item || typeof item !== 'object') continue;
      const tool = typeof item.tool === 'string' ? item.tool.trim() : '';
      if (!KNOWN_TOOLS.has(tool)) continue;
      const args =
        item.args && typeof item.args === 'object' && !Array.isArray(item.args)
          ? item.args
          : {};
      validCalls.push({ tool, args });
    }

    return validCalls.length > 0 ? validCalls : null;
  }

  /**
   * Extract the last valid "$local_agent": true tool block from parsed code blocks.
   */
  function extractToolCallsFromBlocks(blocks) {
    if (!Array.isArray(blocks)) return null;
    const found = [];

    for (const block of blocks) {
      const text = (block?.text || '').trim();
      if (!text || text.includes('[LOCAL_AGENT_SYSTEM_PROMPT]')) continue;

      const parsed = tryParseJson(text);
      if (!parsed) continue;

      const calls = normalizePayload(parsed);
      if (calls) {
        found.push({
          calls,
          raw: text,
          element: block.element || null,
        });
      }
    }

    if (found.length === 0) return null;

    const last = found[found.length - 1];
    return {
      calls: last.calls,
      raw: last.raw,
      element: last.element,
      fingerprint: simpleHash(JSON.stringify(last.calls)),
    };
  }

  /**
   * Extract code blocks from a Gemini model-response DOM container.
   */
  function extractFromDomElement(containerEl) {
    if (!containerEl) return null;

    const codeNodes = containerEl.querySelectorAll('pre code, code-block code, pre');
    const seenTexts = new Set();
    const blocks = [];

    codeNodes.forEach((node) => {
      if (node.tagName === 'PRE' && node.querySelector('code')) return;
      if (node.closest('model-thoughts, .thoughts-container, [data-test-id="model-thoughts"]')) {
        return;
      }

      const text = (node.innerText || node.textContent || '').trim();
      if (!text || seenTexts.has(text)) return;
      seenTexts.add(text);

      blocks.push({ text, element: node.closest('code-block, pre') || node });
    });

    return extractToolCallsFromBlocks(blocks);
  }

  const api = {
    KNOWN_TOOLS,
    READ_ONLY_TOOLS,
    simpleHash,
    extractToolCallsFromBlocks,
    extractFromDomElement,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    global.LocalAgentParser = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : window);
