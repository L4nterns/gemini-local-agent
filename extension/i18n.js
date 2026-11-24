(function (global) {
  function t(key, substitutions) {
    try {
      if (typeof chrome !== 'undefined' && chrome.i18n && chrome.i18n.getMessage) {
        const subs =
          substitutions === undefined
            ? undefined
            : Array.isArray(substitutions)
            ? substitutions.map((s) => String(s))
            : [String(substitutions)];
        const msg = chrome.i18n.getMessage(key, subs);
        if (msg) return msg;
      }
    } catch {
      // Fallback to key name outside extension runtime
    }
    return key;
  }

  function applyDomI18n(root = document) {
    root.querySelectorAll('[data-i18n]').forEach((el) => {
      const msg = t(el.getAttribute('data-i18n'));
      if (msg) el.textContent = msg;
    });
    root.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
      const msg = t(el.getAttribute('data-i18n-placeholder'));
      if (msg) el.setAttribute('placeholder', msg);
    });
    root.querySelectorAll('[data-i18n-title]').forEach((el) => {
      const msg = t(el.getAttribute('data-i18n-title'));
      if (msg) el.setAttribute('title', msg);
    });
  }

  global.LocalAgentI18n = { t, applyDomI18n };
})(typeof globalThis !== 'undefined' ? globalThis : window);
