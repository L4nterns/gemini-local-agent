# Gemini Local Agent

English | [简体中文](README.zh-CN.md)

Turn [Gemini Web](https://gemini.google.com) into a local coding agent connected to your machine via a zero-dependency Node.js bridge and a Chrome Manifest V3 extension.

## Requirements

- **Node.js 18+** (uses built-in modules only — no `npm install` required)
- **Chrome / Edge** (Chromium-based browser supporting Manifest V3)
- **OS**: Windows, macOS, or Linux

## Quick Start

### 1. Start the Local Bridge

```bash
node bridge/server.js
```

The bridge listens on `http://127.0.0.1:3847` by default.

### 2. Load the Chrome Extension

1. Open `chrome://extensions` and enable **Developer mode**.
2. Click **Load unpacked** and select the `extension/` folder.
3. Open [gemini.google.com](https://gemini.google.com).

The extension pairs automatically with the local bridge on first connection (TOFU). Click the floating pill at the bottom-right corner of Gemini Web to add a workspace and start working.

## Session Isolation

Each Gemini conversation is isolated by URL chat ID:

- **New chat**: Starts in **Normal Chat** with no workspace bound. Switch freely between Normal Chat and any registered workspace before sending the first message.
- **Locked on first message**: Once a conversation begins, its binding is locked — normal chats stay isolated from local tools, and agent chats stay bound to their chosen workspace across tabs.
- **Status indicator**: The floating pill status dot (`🟢` online / `🟡` unavailable workspace / `🔴` offline) reflects bridge and workspace health without losing the conversation's binding.

## Tools

- **Read-Only**: `read_file`, `list_dir`, `find_files`, `grep_search` (uses `rg` when available, with automatic pure-Node fallback)
- **Write & Execute**: `write_file`, `edit_file` (atomic single or multi-hunk edits with diff preview), `run_command` (finite shell commands up to 120s)

## Approval Modes

- **Read-Only** *(default)*: Read-only exploration tools execute automatically; writes and shell commands pause above Gemini's input box with an inline preview/diff for approval (or reply directly in Gemini's input box to reject with guidance).
- **Auto**: Executes reads, writes, and normal commands automatically, with a built-in seatbelt that pauses clearly destructive commands (`rm -rf`, `git reset --hard`, `git push --force`, etc.) for manual confirmation.

## CLI Options

```bash
node bridge/server.js [options]
```

| Option | Env Variable | Description |
| --- | --- | --- |
| `--port <num>` | `LOCAL_AGENT_PORT` | Listen port (default: `3847`) |
| `--workspace <dir>` / `-w <dir>` | `LOCAL_AGENT_WORKSPACE` | Pre-register a workspace directory on startup |
| `--reset-token` | — | Regenerate the bearer pairing token |
| `--reset-pair` | — | Clear the paired extension ID to allow re-pairing |
| `--allow-outside` | — | Disable workspace boundary checks for the current process |

## Security Model

- **Loopback only**: Binds strictly to `127.0.0.1` and validates loopback `Host` headers against DNS rebinding. Both the bridge and extension reject non-loopback targets.
- **Extension-origin TOFU pairing**: Automatic pairing accepts only valid browser extension origins (`chrome-extension://` / `moz-extension://`) and locks to the first paired extension ID. Subsequent unknown extensions are rejected (`403`) unless restarted with `--reset-pair` or configured with the pairing token.
- **Workspace authorization & symlink sandbox**: Every tool request carries an explicit `workspace` parameter that must be registered and exist on disk; lexical traversals and symlink/junction escapes (including dangling symlinks) are blocked unless `--allow-outside` is passed at launch.
- **Redacted audit logs**: Stored locally under `bridge/logs/` with daily rotation (30-day retention) and automatic redaction of tokens and common secret patterns.

## Cross-Platform Notes

- **Native folder picker**: Uses Windows Forms on Windows, AppleScript (`osascript`) on macOS, and `zenity` (falling back to `kdialog`) on Linux.
- **Shell execution**: Uses PowerShell (`taskkill /f /t` on timeout) on Windows and `$SHELL` / POSIX process groups on macOS and Linux.
- **Extension UI localization**: Follows the browser locale (`en` by default, Simplified Chinese `zh_CN` automatically when Chrome is set to Simplified Chinese).

## Project Structure

```text
.
├── bridge/
│   ├── package.json        # Node ESM manifest (zero dependencies)
│   ├── server.js           # Local HTTP bridge & REST endpoints
│   ├── tools.js            # Local agent tool execution & previews
│   ├── security.js         # Auth, TOFU pairing, workspace sandbox & diffing
│   ├── folder-picker.js    # Cross-platform native folder picker
│   ├── logger.js           # Redacted JSONL audit logger
│   └── test-bridge.mjs     # Automated integration & integrity test suite
└── extension/
    ├── manifest.json       # Chrome Manifest V3
    ├── _locales/           # i18n messages (en, zh_CN)
    ├── i18n.js             # Localization helper
    ├── background.js       # Service worker & bridge HTTP client
    ├── content.js          # Gemini Web integration, floating pill & console
    ├── styles.css          # In-page UI styles
    ├── tool-parser.js      # Structured tool-call extractor
    ├── session-state.js    # Conversation isolation & DOM state machine
    ├── prompt-template.js  # Agent system prompt & result formatter
    ├── popup.html/css/js   # Extension popup (workspace list & bridge settings)
    └── icons/              # Extension icons
```

## Testing

```bash
node bridge/test-bridge.mjs
```

## License

[MIT](LICENSE)
