import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createSimpleDiff,
  inspectCommandRisk,
  normalizeFsPathKey,
  READ_ONLY_TOOLS,
  resolvePosixShell,
  resolveWorkspacePath,
  toWorkspaceRelative,
} from './security.js';

const DEFAULT_IGNORE_DIRS = new Set([
  'node_modules',
  '.git',
  '.next',
  '.nuxt',
  'dist',
  'build',
  'out',
  '.venv',
  'venv',
  '__pycache__',
  '.cache',
  '.turbo',
  'coverage',
  'target',
]);

const MAX_READ_BYTES = 48 * 1024;
const MAX_READ_LINES = 500;
const MAX_FILE_READ_BYTES = 10 * 1024 * 1024; // 10 MB safety cap before loading file into memory
const MAX_CMD_OUTPUT = 24 * 1024;
const DEFAULT_CMD_TIMEOUT_MS = 30_000;
const MAX_CMD_TIMEOUT_MS = 120_000;

let cachedRgAvailable = null;

function isRipgrepAvailable() {
  if (cachedRgAvailable !== null) return cachedRgAvailable;
  try {
    const res = spawnSync('rg', ['--version'], {
      windowsHide: true,
      timeout: 2000,
      stdio: 'ignore',
    });
    cachedRgAvailable = !res.error && res.status === 0;
  } catch {
    cachedRgAvailable = false;
  }
  return cachedRgAvailable;
}

/**
 * Execute a binary directly with argument array (no shell interpolation).
 */
function runBinary(bin, args, cwd, timeoutMs = 15_000) {
  return new Promise((resolve) => {
    const child = spawn(bin, args, {
      cwd,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    const stdoutChunks = [];
    const stderrChunks = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutTruncated = false;
    let timedOut = false;
    let finished = false;
    const maxBytes = 512 * 1024;
    const maxStderrBytes = 32 * 1024;

    const timer = setTimeout(() => {
      if (!finished) {
        timedOut = true;
        try {
          child.kill('SIGKILL');
        } catch {
          // Ignore kill error
        }
      }
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      if (stdoutBytes < maxBytes) {
        const remaining = maxBytes - stdoutBytes;
        if (chunk.length > remaining) {
          stdoutChunks.push(chunk.subarray(0, remaining));
          stdoutBytes = maxBytes;
          stdoutTruncated = true;
        } else {
          stdoutChunks.push(chunk);
          stdoutBytes += chunk.length;
        }
      } else {
        stdoutTruncated = true;
      }
    });

    child.stderr.on('data', (chunk) => {
      if (stderrBytes < maxStderrBytes) {
        const remaining = maxStderrBytes - stderrBytes;
        stderrChunks.push(chunk.length > remaining ? chunk.subarray(0, remaining) : chunk);
        stderrBytes += Math.min(chunk.length, remaining);
      }
    });

    child.on('error', (err) => {
      finished = true;
      clearTimeout(timer);
      resolve({ ok: false, exitCode: -1, stdout: '', stderr: err.message, truncated: false, timedOut: false });
    });

    child.on('close', (code, signal) => {
      finished = true;
      clearTimeout(timer);
      const killed = timedOut || Boolean(signal);
      resolve({
        ok: !killed,
        exitCode: killed ? -1 : (code ?? 0),
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
        truncated: stdoutTruncated || timedOut,
        timedOut,
      });
    });
  });
}

/**
 * Normalize single-edit or multi-hunk edits[] payload and apply all edits atomically in memory.
 */
function applyEditsToText(rawBefore, args, relPath) {
  const editList = Array.isArray(args.edits)
    ? args.edits
    : [
        {
          target: args.target,
          replacement: args.replacement,
          replace_all: args.replace_all,
        },
      ];

  if (editList.length === 0) {
    throw new Error('edit_file requires at least one edit.');
  }

  const usesCRLF = rawBefore.includes('\r\n');
  const beforeNormalized = rawBefore.replace(/\r\n/g, '\n');
  let working = beforeNormalized;
  let totalReplacements = 0;

  for (let i = 0; i < editList.length; i++) {
    const item = editList[i];
    if (!item || typeof item !== 'object') {
      throw new Error(`Invalid edit entry at index ${i}.`);
    }
    if (item.target === undefined || item.target === null || item.target === '') {
      throw new Error(
        editList.length > 1
          ? `edit_file edit[${i}] requires non-empty parameter: target`
          : 'edit_file requires parameter: target'
      );
    }
    if (item.replacement === undefined || item.replacement === null) {
      throw new Error(
        editList.length > 1
          ? `edit_file edit[${i}] requires parameter: replacement`
          : 'edit_file requires parameter: replacement'
      );
    }

    const targetStr = String(item.target).replace(/\r\n/g, '\n');
    const replacementStr = String(item.replacement).replace(/\r\n/g, '\n');
    const occurrences = working.split(targetStr).length - 1;
    const prefix = editList.length > 1 ? `Edit #${i + 1}: ` : '';

    if (occurrences === 0) {
      throw new Error(
        `${prefix}Exact target snippet not found in ${relPath}. Call read_file to inspect the current lines.`
      );
    }
    if (occurrences > 1 && !item.replace_all) {
      throw new Error(
        `${prefix}Found ${occurrences} matches in ${relPath}. Provide more surrounding context or set replace_all: true.`
      );
    }

    working = item.replace_all
      ? working.split(targetStr).join(replacementStr)
      : working.replace(targetStr, () => replacementStr);
    totalReplacements += item.replace_all ? occurrences : 1;
  }

  const finalOutput = usesCRLF ? working.replace(/\n/g, '\r\n') : working;
  return {
    beforeNormalized,
    afterNormalized: working,
    finalOutput,
    totalReplacements,
    editCount: editList.length,
  };
}

function globToRegExp(glob) {
  const normalized = String(glob).replace(/\\/g, '/');
  const pattern = normalized.replace(/\*\*\/|\*\*|\*|\?|[.+^${}()|[\]\\]/g, (token) => {
    switch (token) {
      case '**/':
        return '(?:.*/)?';
      case '**':
        return '.*';
      case '*':
        return '[^/]*';
      case '?':
        return '[^/]';
      default:
        return `\\${token}`;
    }
  });
  return new RegExp(`^${pattern}$`, 'i');
}

function isProbablyBinary(buffer) {
  const sampleLen = Math.min(buffer.length, 4096);
  for (let i = 0; i < sampleLen; i++) {
    if (buffer[i] === 0) return true;
  }
  return false;
}

function truncateText(text, maxBytes) {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) return { text, truncated: false };
  const slice = buf.subarray(0, maxBytes).toString('utf8');
  return {
    text: `${slice}\n... [output truncated: ${buf.length} bytes total, showing first ${maxBytes} bytes]`,
    truncated: true,
  };
}

function walkFiles(dirPath, rootPath, options = {}) {
  const {
    maxDepth = 8,
    maxFiles = 500,
    includeHidden = false,
    allowOutsideWorkspace = false,
    ignoreDirs = DEFAULT_IGNORE_DIRS,
  } = options;

  const results = [];
  let truncated = false;

  function visit(current, depth) {
    if (results.length >= maxFiles) {
      truncated = true;
      return;
    }
    if (depth > maxDepth) return;

    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }

    entries.sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    for (const entry of entries) {
      if (results.length >= maxFiles) {
        truncated = true;
        return;
      }
      if (!includeHidden && entry.name.startsWith('.') && entry.name !== '.env.example') {
        continue;
      }
      if (entry.isSymbolicLink() && !allowOutsideWorkspace) {
        continue;
      }
      const fullPath = path.join(current, entry.name);
      const relPath = toWorkspaceRelative(rootPath, fullPath);

      let isDir = entry.isDirectory();
      let statSize = 0;
      if (entry.isSymbolicLink()) {
        try {
          const st = fs.statSync(fullPath);
          isDir = st.isDirectory();
          statSize = st.size;
        } catch {
          continue;
        }
      }

      if (isDir) {
        if (ignoreDirs.has(entry.name)) continue;
        results.push({ path: relPath, type: 'dir' });
        visit(fullPath, depth + 1);
      } else {
        let size = statSize;
        if (!entry.isSymbolicLink()) {
          try {
            size = fs.statSync(fullPath).size;
          } catch {
            // Ignore stat error
          }
        }
        results.push({ path: relPath, type: 'file', size });
      }
    }
  }

  visit(dirPath, 0);
  return { results, truncated };
}

function runShell(command, cwd, timeoutMs = DEFAULT_CMD_TIMEOUT_MS) {
  const clampedTimeout = Math.min(
    Math.max(Number(timeoutMs) || DEFAULT_CMD_TIMEOUT_MS, 1000),
    MAX_CMD_TIMEOUT_MS
  );
  const startTime = Date.now();

  return new Promise((resolve) => {
    const isWin = process.platform === 'win32';
    let shellExe;
    let shellArgs;

    if (isWin) {
      const utf8Prefix =
        '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $OutputEncoding = [System.Text.Encoding]::UTF8; ';
      shellExe = 'powershell.exe';
      shellArgs = ['-NoProfile', '-NonInteractive', '-Command', utf8Prefix + command];
    } else {
      shellExe = resolvePosixShell();
      shellArgs = ['-c', command];
    }

    const stdoutChunks = [];
    const stderrChunks = [];
    const maxCaptureBytes = MAX_CMD_OUTPUT * 2;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutOverflow = false;
    let stderrOverflow = false;
    let timedOut = false;
    let finished = false;

    const child = spawn(shellExe, shellArgs, {
      cwd,
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      detached: !isWin,
    });

    const timer = setTimeout(() => {
      if (!finished) {
        timedOut = true;
        try {
          if (isWin && child.pid) {
            spawnSync('taskkill', ['/pid', String(child.pid), '/f', '/t'], {
              windowsHide: true,
              timeout: 5000,
            });
          } else if (child.pid) {
            try {
              process.kill(-child.pid, 'SIGKILL');
            } catch {
              child.kill('SIGKILL');
            }
          } else {
            child.kill('SIGKILL');
          }
        } catch {
          // Ignore kill error
        }
      }
    }, clampedTimeout);

    child.stdout.on('data', (chunk) => {
      if (stdoutBytes < maxCaptureBytes) {
        const remaining = maxCaptureBytes - stdoutBytes;
        if (chunk.length > remaining) {
          stdoutChunks.push(chunk.subarray(0, remaining));
          stdoutBytes = maxCaptureBytes;
          stdoutOverflow = true;
        } else {
          stdoutChunks.push(chunk);
          stdoutBytes += chunk.length;
        }
      } else {
        stdoutOverflow = true;
      }
    });

    child.stderr.on('data', (chunk) => {
      if (stderrBytes < maxCaptureBytes) {
        const remaining = maxCaptureBytes - stderrBytes;
        if (chunk.length > remaining) {
          stderrChunks.push(chunk.subarray(0, remaining));
          stderrBytes = maxCaptureBytes;
          stderrOverflow = true;
        } else {
          stderrChunks.push(chunk);
          stderrBytes += chunk.length;
        }
      } else {
        stderrOverflow = true;
      }
    });

    child.on('error', (err) => {
      finished = true;
      clearTimeout(timer);
      resolve({
        exitCode: -1,
        stdout: '',
        stderr: `Failed to spawn process: ${err.message}`,
        timedOut: false,
        durationMs: Date.now() - startTime,
      });
    });

    child.on('close', (code, signal) => {
      finished = true;
      clearTimeout(timer);
      const outT = truncateText(Buffer.concat(stdoutChunks).toString('utf8'), MAX_CMD_OUTPUT);
      const errT = truncateText(Buffer.concat(stderrChunks).toString('utf8'), MAX_CMD_OUTPUT);
      const killed = timedOut || Boolean(signal);
      const finalStderr = timedOut
        ? `${errT.text}\n[Command timed out after ${clampedTimeout}ms and was terminated]`
        : signal
        ? `${errT.text}\n[Process terminated by signal ${signal}]`
        : errT.text;
      resolve({
        exitCode: killed ? -1 : (code ?? 0),
        stdout: outT.text,
        stderr: finalStderr,
        timedOut,
        truncated: outT.truncated || errT.truncated || stdoutOverflow || stderrOverflow,
        durationMs: Date.now() - startTime,
      });
    });
  });
}

async function getGitSummary(workspaceRoot) {
  if (!fs.existsSync(path.join(workspaceRoot, '.git'))) {
    return null;
  }
  const branch = await runBinary('git', ['rev-parse', '--abbrev-ref', 'HEAD'], workspaceRoot, 5000);
  if (!branch.ok || branch.exitCode !== 0) return null;
  return { branch: branch.stdout.trim() };
}

/**
 * Collect lightweight environment & top-level workspace tree context for
 * initial system-prompt mounting (internal endpoint, not an LLM tool).
 */
export async function getWorkspaceContext(workspace, allowOutsideWorkspace = false) {
  const { results, truncated } = walkFiles(workspace, workspace, {
    maxDepth: 2,
    maxFiles: 120,
    allowOutsideWorkspace,
  });
  const git = await getGitSummary(workspace);
  return {
    workspace,
    os: `${os.platform()} ${os.release()} (${os.arch()})`,
    shell: process.platform === 'win32' ? 'powershell.exe' : resolvePosixShell(),
    nodeVersion: process.version,
    git,
    treePreview: results.map((r) => (r.type === 'dir' ? `${r.path}/` : r.path)),
    treeTruncated: truncated,
  };
}

/**
 * Fast, side-effect-free one-line summary for console & audit logging.
 */
export function summarizeToolCall(toolName, args = {}) {
  switch (toolName) {
    case 'list_dir':
      return String(args.path || '.');
    case 'find_files':
      return `${args.pattern || '*'} in ${args.path || '.'}`;
    case 'grep_search':
      return `"${args.query || ''}" in ${args.path || '.'}`;
    case 'read_file':
      return `${args.path || ''}${
        args.start_line ? ` (L${args.start_line}-${args.end_line || 'end'})` : ''
      }`;
    case 'write_file':
      return String(args.path || '');
    case 'edit_file': {
      const count = Array.isArray(args.edits) ? args.edits.length : 1;
      return count > 1 ? `${args.path || ''} (${count} edits)` : String(args.path || '');
    }
    case 'run_command':
      return String(args.command || '');
    default:
      return toolName;
  }
}

/**
 * Compute risk classification and diff preview before executing a tool call.
 */
export function previewToolCall(toolName, args = {}, ctx) {
  const { workspace, allowOutsideWorkspace, virtualFiles } = ctx;
  const readOnly = READ_ONLY_TOOLS.has(toolName);
  const preview = {
    tool: toolName,
    readOnly,
    dangerous: false,
    warning: null,
    summary: summarizeToolCall(toolName, args),
    diff: null,
  };

  const readVirtualFile = (absPath) => {
    const vKey = normalizeFsPathKey(absPath);
    if (virtualFiles && virtualFiles.has(vKey)) {
      return virtualFiles.get(vKey);
    }
    if (!fs.existsSync(absPath)) return null;
    const stat = fs.statSync(absPath);
    if (stat.isDirectory()) {
      throw new Error(`Target path is a directory, not a file: ${toWorkspaceRelative(workspace, absPath)}`);
    }
    if (stat.size > MAX_FILE_READ_BYTES) {
      throw new Error(`File exceeds 10 MB safety limit (${stat.size} bytes).`);
    }
    const buf = fs.readFileSync(absPath);
    if (isProbablyBinary(buf)) {
      throw new Error(`Binary file cannot be diffed or edited as text: ${toWorkspaceRelative(workspace, absPath)}`);
    }
    return buf.toString('utf8');
  };

  try {
    switch (toolName) {
      case 'list_dir':
      case 'find_files':
      case 'grep_search':
      case 'read_file':
        break;
      case 'write_file': {
        if (!args.path) {
          preview.warning = 'write_file requires parameter: path';
          break;
        }
        if (args.content === undefined || args.content === null) {
          preview.warning = 'write_file requires parameter: content';
          break;
        }
        const target = resolveWorkspacePath(workspace, args.path, allowOutsideWorkspace);
        const rel = toWorkspaceRelative(workspace, target);
        const before = readVirtualFile(target);
        const after = String(args.content);
        preview.summary = `${rel} (${before !== null ? 'overwrite' : 'new'})`;
        preview.diff = createSimpleDiff(before, after, rel);
        if (virtualFiles) virtualFiles.set(normalizeFsPathKey(target), after);
        break;
      }
      case 'edit_file': {
        if (!args.path) {
          preview.warning = 'edit_file requires parameter: path';
          break;
        }
        const target = resolveWorkspacePath(workspace, args.path, allowOutsideWorkspace);
        const rel = toWorkspaceRelative(workspace, target);
        const editCount = Array.isArray(args.edits) ? args.edits.length : 1;
        preview.summary = editCount > 1 ? `${rel} (${editCount} edits)` : rel;
        const rawBefore = readVirtualFile(target);
        if (rawBefore !== null) {
          const applied = applyEditsToText(rawBefore, args, rel);
          preview.diff = createSimpleDiff(applied.beforeNormalized, applied.afterNormalized, rel);
          if (virtualFiles) virtualFiles.set(normalizeFsPathKey(target), applied.finalOutput);
        } else {
          preview.warning = `File does not exist: ${rel}`;
        }
        break;
      }
      case 'run_command': {
        const cmd = String(args.command || '');
        const risk = inspectCommandRisk(cmd);
        preview.summary = cmd;
        preview.dangerous = risk.dangerous;
        preview.warning = risk.reason;
        break;
      }
      default:
        preview.summary = toolName;
        preview.warning = `Unsupported tool name: ${toolName}`;
    }
  } catch (err) {
    preview.warning = err.message;
  }

  return preview;
}

/**
 * Execute a local agent tool inside the authorized workspace.
 */
export async function executeTool(toolName, args = {}, ctx) {
  const { workspace, allowOutsideWorkspace, forceNodeSearch = false } = ctx;
  const start = Date.now();

  switch (toolName) {
    case 'list_dir': {
      const target = resolveWorkspacePath(workspace, args.path || '.', allowOutsideWorkspace);
      if (!fs.existsSync(target)) {
        throw new Error(`Directory not found: ${args.path || '.'}`);
      }
      const stat = fs.statSync(target);
      if (!stat.isDirectory()) {
        throw new Error(`Target is not a directory: ${args.path}`);
      }

      const depth = Math.min(Math.max(Math.floor(Number(args.max_depth)) || 1, 1), 5);
      const maxEntries = Math.min(Math.max(Math.floor(Number(args.max_entries)) || 200, 1), 500);
      const { results, truncated } = walkFiles(target, workspace, {
        maxDepth: depth - 1,
        maxFiles: maxEntries,
        includeHidden: Boolean(args.include_hidden),
        allowOutsideWorkspace,
      });

      return {
        ok: true,
        tool: toolName,
        durationMs: Date.now() - start,
        data: {
          path: toWorkspaceRelative(workspace, target),
          entries: results,
          truncated,
        },
      };
    }

    case 'find_files': {
      const target = resolveWorkspacePath(workspace, args.path || '.', allowOutsideWorkspace);
      if (!fs.existsSync(target)) {
        throw new Error(`Path not found: ${args.path || '.'}`);
      }
      if (!fs.statSync(target).isDirectory()) {
        throw new Error(`Target is not a directory: ${args.path}`);
      }
      const pattern = String(args.pattern || '*').trim();
      const maxDepth = Math.min(Math.max(Math.floor(Number(args.max_depth)) || 10, 1), 15);
      const maxResults = Math.min(Math.max(Math.floor(Number(args.max_results)) || 200, 1), 500);
      const includeHidden = Boolean(args.include_hidden);

      // Fast path: ripgrep natively respects .gitignore and handles large repos
      if (!forceNodeSearch && isRipgrepAvailable()) {
        const rgArgs = ['--files', '--color=never', '--no-messages', '--max-depth', String(maxDepth)];
        if (includeHidden) {
          rgArgs.push('--hidden', '--glob', '!.git');
        }
        if (pattern && pattern !== '*') {
          rgArgs.push('--glob', pattern.replace(/\\/g, '/'));
        }
        const relTarget = toWorkspaceRelative(workspace, target);
        rgArgs.push('--', relTarget);

        const rgRes = await runBinary('rg', rgArgs, workspace, 15_000);
        if (rgRes.ok && (rgRes.exitCode === 0 || rgRes.exitCode === 1)) {
          const rawLines = rgRes.stdout.split(/\r?\n/);
          if (rgRes.truncated && rawLines.length > 0) rawLines.pop();
          const all = rawLines
            .map((l) => l.trim().replace(/\\/g, '/').replace(/^\.\//, ''))
            .filter(Boolean)
            .sort();
          const truncated = rgRes.truncated || all.length > maxResults;
          const matches = all.slice(0, maxResults);
          return {
            ok: true,
            tool: toolName,
            durationMs: Date.now() - start,
            data: {
              pattern,
              engine: 'rg',
              count: matches.length,
              truncated,
              matches,
            },
          };
        }
      }

      const hasSlash = pattern.includes('/') || pattern.includes('\\');
      const regex = globToRegExp(pattern);

      const { results, truncated: walkTruncated } = walkFiles(target, workspace, {
        maxDepth: maxDepth - 1,
        maxFiles: 3000,
        includeHidden,
        allowOutsideWorkspace,
      });

      const matches = [];
      let truncated = walkTruncated;
      for (const item of results) {
        if (item.type !== 'file') continue;
        const testStr = hasSlash ? item.path : path.basename(item.path);
        if (regex.test(testStr)) {
          if (matches.length >= maxResults) {
            truncated = true;
            break;
          }
          matches.push(item.path);
        }
      }

      return {
        ok: true,
        tool: toolName,
        durationMs: Date.now() - start,
        data: {
          pattern,
          engine: 'node',
          count: matches.length,
          truncated,
          matches,
        },
      };
    }

    case 'grep_search': {
      const query = String(args.query || '');
      if (!query) throw new Error('grep_search requires parameter: query');

      const target = resolveWorkspacePath(workspace, args.path || '.', allowOutsideWorkspace);
      if (!fs.existsSync(target)) {
        throw new Error(`Path not found: ${args.path || '.'}`);
      }
      const isRegex = Boolean(args.is_regex);
      const caseSensitive = Boolean(args.case_sensitive);
      const filesOnly = Boolean(args.files_only);
      const contextLines = Math.min(Math.max(Math.floor(Number(args.context_lines)) || 0, 0), 5);
      const maxResults = Math.min(Math.max(Math.floor(Number(args.max_results)) || 80, 1), 200);

      // Fast path: ripgrep natively respects .gitignore and supports context & files-only
      if (!forceNodeSearch && isRipgrepAvailable()) {
        const rgArgs = ['--color=never', '--no-messages', '--max-filesize', '512K'];
        if (!isRegex) rgArgs.push('--fixed-strings');
        if (!caseSensitive) rgArgs.push('--ignore-case');
        if (args.file_pattern) {
          rgArgs.push('--glob', String(args.file_pattern).replace(/\\/g, '/'));
        }
        const relTarget = toWorkspaceRelative(workspace, target);

        if (filesOnly) {
          rgArgs.push('--files-with-matches', '--', query, relTarget);
          const rgRes = await runBinary('rg', rgArgs, workspace, 15_000);
          if (rgRes.ok && (rgRes.exitCode === 0 || rgRes.exitCode === 1)) {
            const rawLines = rgRes.stdout.split(/\r?\n/);
            if (rgRes.truncated && rawLines.length > 0) rawLines.pop();
            const allFiles = rawLines
              .map((l) => l.trim().replace(/\\/g, '/').replace(/^\.\//, ''))
              .filter(Boolean)
              .sort();
            const truncated = rgRes.truncated || allFiles.length > maxResults;
            const files = allFiles.slice(0, maxResults);
            return {
              ok: true,
              tool: toolName,
              durationMs: Date.now() - start,
              data: {
                query,
                filesOnly: true,
                engine: 'rg',
                count: files.length,
                truncated,
                files,
              },
            };
          }
        } else {
          // --max-filesize 512K and runBinary's 512 KB stdout cap bound memory under --json
          rgArgs.push('--json');
          if (contextLines > 0) rgArgs.push('-C', String(contextLines));
          rgArgs.push('--', query, relTarget);
          const rgRes = await runBinary('rg', rgArgs, workspace, 15_000);
          if (rgRes.ok && (rgRes.exitCode === 0 || rgRes.exitCode === 1)) {
            const matches = [];
            let truncated = Boolean(rgRes.truncated);
            // Collect per-file line map from JSON events to build clean match + context blocks
            const rawEvents = rgRes.stdout.split(/\r?\n/);
            if (rgRes.truncated && rawEvents.length > 0) rawEvents.pop();
            const events = rawEvents.filter(Boolean);
            const perFileLines = new Map();
            const rawMatches = [];
            let reachedLimit = false;

            for (const raw of events) {
              let ev;
              try {
                ev = JSON.parse(raw);
              } catch {
                continue;
              }
              if (ev.type !== 'match' && ev.type !== 'context') continue;
              const rawPath = ev.data?.path?.text || '';
              const file = rawPath.replace(/\\/g, '/').replace(/^\.\//, '');
              const lineNo = ev.data?.line_number;
              const lineText = String(ev.data?.lines?.text || '')
                .replace(/\r?\n$/, '')
                .slice(0, 300);
              if (!file || !lineNo) continue;

              if (contextLines > 0) {
                if (!perFileLines.has(file)) perFileLines.set(file, new Map());
                perFileLines.get(file).set(lineNo, lineText);
              }
              if (ev.type === 'match') {
                if (rawMatches.length >= maxResults) {
                  truncated = true;
                  reachedLimit = true;
                  const lastMatch = rawMatches[rawMatches.length - 1];
                  if (
                    contextLines === 0 ||
                    !lastMatch ||
                    file !== lastMatch.file ||
                    lineNo > lastMatch.line + contextLines
                  ) {
                    break;
                  }
                } else {
                  rawMatches.push({ file, line: lineNo, text: lineText });
                }
              } else if (reachedLimit) {
                // Keep trailing context lines for the last collected match, then stop once past its window
                const lastMatch = rawMatches[rawMatches.length - 1];
                if (!lastMatch || file !== lastMatch.file || lineNo > lastMatch.line + contextLines) {
                  break;
                }
              }
            }

            for (const m of rawMatches) {
              if (contextLines > 0) {
                const lineMap = perFileLines.get(m.file) || new Map();
                const ctxArr = [];
                for (let ln = m.line - contextLines; ln <= m.line + contextLines; ln++) {
                  if (!lineMap.has(ln)) continue;
                  ctxArr.push(`${ln === m.line ? '>' : ' '} ${ln}: ${lineMap.get(ln)}`);
                }
                matches.push({ ...m, context: ctxArr });
              } else {
                matches.push(m);
              }
            }

            return {
              ok: true,
              tool: toolName,
              durationMs: Date.now() - start,
              data: {
                query,
                filesOnly: false,
                engine: 'rg',
                count: matches.length,
                truncated,
                matches,
              },
            };
          }
        }
      }

      // Pure-Node fallback (consistent behavior when ripgrep is not installed)
      const flags = caseSensitive ? 'g' : 'gi';
      const matcher = isRegex
        ? new RegExp(query, flags)
        : new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);

      const includeRegex = args.file_pattern ? globToRegExp(args.file_pattern) : null;

      let filesToScan = [];
      let walkTruncated = false;
      const targetStat = fs.statSync(target);
      if (targetStat.isFile()) {
        if (targetStat.size > MAX_FILE_READ_BYTES) {
          throw new Error(
            `File is too large for grep_search (${targetStat.size} bytes > 10 MB limit).`
          );
        }
        filesToScan = [{ path: toWorkspaceRelative(workspace, target), fullPath: target }];
      } else {
        const walked = walkFiles(target, workspace, {
          maxDepth: 12,
          maxFiles: 2500,
          allowOutsideWorkspace,
        });
        walkTruncated = walked.truncated;
        filesToScan = walked.results
          .filter((r) => r.type === 'file' && (r.size ?? 0) <= 512 * 1024)
          .map((r) => ({ path: r.path, fullPath: path.resolve(workspace, r.path) }));
      }

      const matches = [];
      const matchedFiles = [];
      let limitReached = false;

      for (const file of filesToScan) {
        if (
          includeRegex &&
          !includeRegex.test(path.basename(file.path)) &&
          !includeRegex.test(file.path)
        ) {
          continue;
        }
        let buf;
        try {
          buf = fs.readFileSync(file.fullPath);
        } catch {
          continue;
        }
        if (isProbablyBinary(buf)) continue;

        const lines = buf.toString('utf8').replace(/\r\n/g, '\n').split('\n');
        for (let i = 0; i < lines.length; i++) {
          matcher.lastIndex = 0;
          if (matcher.test(lines[i])) {
            if (filesOnly) {
              if (matchedFiles.length >= maxResults) {
                limitReached = true;
              } else {
                matchedFiles.push(file.path);
              }
              break;
            }
            const entry = {
              file: file.path,
              line: i + 1,
              text: lines[i].slice(0, 300),
            };
            if (contextLines > 0) {
              const from = Math.max(0, i - contextLines);
              const to = Math.min(lines.length - 1, i + contextLines);
              const ctxArr = [];
              for (let j = from; j <= to; j++) {
                ctxArr.push(`${j === i ? '>' : ' '} ${j + 1}: ${lines[j].slice(0, 300)}`);
              }
              entry.context = ctxArr;
            }
            matches.push(entry);
            if (matches.length >= maxResults) {
              limitReached = true;
              break;
            }
          }
        }
        if (limitReached) break;
      }

      const truncated = limitReached || walkTruncated;

      if (filesOnly) {
        return {
          ok: true,
          tool: toolName,
          durationMs: Date.now() - start,
          data: {
            query,
            filesOnly: true,
            engine: 'node',
            count: matchedFiles.length,
            truncated,
            files: matchedFiles,
          },
        };
      }

      return {
        ok: true,
        tool: toolName,
        durationMs: Date.now() - start,
        data: {
          query,
          filesOnly: false,
          engine: 'node',
          count: matches.length,
          truncated,
          matches,
        },
      };
    }

    case 'read_file': {
      if (!args.path) throw new Error('read_file requires parameter: path');
      const target = resolveWorkspacePath(workspace, args.path, allowOutsideWorkspace);
      if (!fs.existsSync(target)) {
        throw new Error(`File not found: ${args.path}`);
      }
      const stat = fs.statSync(target);
      if (stat.isDirectory()) {
        throw new Error(`"${args.path}" is a directory; use list_dir instead.`);
      }
      if (stat.size > MAX_FILE_READ_BYTES) {
        // Peek first 4 KB to tell binary vs huge text without loading the entire file into RAM
        const fd = fs.openSync(target, 'r');
        const head = Buffer.alloc(Math.min(4096, stat.size));
        try {
          fs.readSync(fd, head, 0, head.length, 0);
        } finally {
          fs.closeSync(fd);
        }
        if (isProbablyBinary(head)) {
          return {
            ok: true,
            tool: toolName,
            durationMs: Date.now() - start,
            data: {
              path: toWorkspaceRelative(workspace, target),
              binary: true,
              sizeBytes: stat.size,
              message: 'Binary file detected; text content omitted.',
            },
          };
        }
        throw new Error(
          `File is too large for read_file (${stat.size} bytes > 10 MB limit). Use grep_search or run_command to inspect specific slices.`
        );
      }

      const buf = fs.readFileSync(target);
      if (isProbablyBinary(buf)) {
        return {
          ok: true,
          tool: toolName,
          durationMs: Date.now() - start,
          data: {
            path: toWorkspaceRelative(workspace, target),
            binary: true,
            sizeBytes: stat.size,
            message: 'Binary file detected; text content omitted.',
          },
        };
      }

      const allLines = buf.toString('utf8').replace(/\r\n/g, '\n').split('\n');
      const totalLines = allLines.length;
      const startLine = Math.max(1, Math.floor(Number(args.start_line)) || 1);
      if (startLine > totalLines) {
        return {
          ok: true,
          tool: toolName,
          durationMs: Date.now() - start,
          data: {
            path: toWorkspaceRelative(workspace, target),
            totalLines,
            startLine,
            endLine: totalLines,
            truncated: false,
            content: '',
          },
        };
      }
      const requestedEnd =
        Math.floor(Number(args.end_line)) || Math.min(totalLines, startLine + MAX_READ_LINES - 1);
      const endLine = Math.min(
        totalLines,
        Math.max(startLine, Math.min(requestedEnd, startLine + MAX_READ_LINES - 1))
      );

      const numbered = [];
      let bytes = 0;
      let truncated = endLine < totalLines;

      for (let i = startLine; i <= endLine; i++) {
        const lineStr = `${i}: ${allLines[i - 1]}`;
        const lineBytes = Buffer.byteLength(lineStr, 'utf8') + 1;
        if (bytes + lineBytes > MAX_READ_BYTES) {
          if (numbered.length === 0) {
            const clipped = Buffer.from(lineStr, 'utf8').subarray(0, MAX_READ_BYTES).toString('utf8');
            numbered.push(`${clipped}... [line truncated]`);
          }
          truncated = true;
          break;
        }
        bytes += lineBytes;
        numbered.push(lineStr);
      }

      return {
        ok: true,
        tool: toolName,
        durationMs: Date.now() - start,
        data: {
          path: toWorkspaceRelative(workspace, target),
          totalLines,
          startLine,
          endLine: startLine + numbered.length - 1,
          truncated,
          content: numbered.join('\n'),
        },
      };
    }

    case 'write_file': {
      if (!args.path) throw new Error('write_file requires parameter: path');
      if (args.content === undefined || args.content === null) {
        throw new Error('write_file requires parameter: content');
      }
      const target = resolveWorkspacePath(workspace, args.path, allowOutsideWorkspace);
      const rel = toWorkspaceRelative(workspace, target);
      const existed = fs.existsSync(target);
      let before = null;
      let diffSkippedReason = null;
      if (existed) {
        const stat = fs.statSync(target);
        if (stat.isDirectory()) {
          throw new Error(`Cannot overwrite directory "${args.path}" with a file.`);
        }
        if (stat.size <= MAX_FILE_READ_BYTES) {
          const prevBuf = fs.readFileSync(target);
          if (isProbablyBinary(prevBuf)) {
            diffSkippedReason = '(diff omitted: previous file was binary)';
          } else {
            before = prevBuf.toString('utf8');
          }
        } else {
          diffSkippedReason = '(diff omitted: previous file exceeded 10 MB)';
        }
      }
      const content = String(args.content);

      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content, 'utf8');

      return {
        ok: true,
        tool: toolName,
        durationMs: Date.now() - start,
        data: {
          path: rel,
          created: !existed,
          bytesWritten: Buffer.byteLength(content, 'utf8'),
          diff: diffSkippedReason || createSimpleDiff(before, content, rel, 60),
        },
      };
    }

    case 'edit_file': {
      if (!args.path) throw new Error('edit_file requires parameter: path');
      const targetPath = resolveWorkspacePath(workspace, args.path, allowOutsideWorkspace);
      if (!fs.existsSync(targetPath)) {
        throw new Error(`File not found: ${args.path}`);
      }
      const rel = toWorkspaceRelative(workspace, targetPath);
      const stat = fs.statSync(targetPath);
      if (stat.isDirectory()) {
        throw new Error(`Cannot edit directory "${args.path}"; edit_file only supports files.`);
      }
      if (stat.size > MAX_FILE_READ_BYTES) {
        throw new Error(`File is too large for edit_file (${stat.size} bytes > 10 MB limit).`);
      }
      const rawBuf = fs.readFileSync(targetPath);
      if (isProbablyBinary(rawBuf)) {
        throw new Error(`Binary file cannot be edited as text: ${rel}`);
      }
      const rawBefore = rawBuf.toString('utf8');
      const applied = applyEditsToText(rawBefore, args, rel);

      fs.writeFileSync(targetPath, applied.finalOutput, 'utf8');

      return {
        ok: true,
        tool: toolName,
        durationMs: Date.now() - start,
        data: {
          path: rel,
          edits: applied.editCount,
          replacements: applied.totalReplacements,
          diff: createSimpleDiff(applied.beforeNormalized, applied.afterNormalized, rel, 80),
        },
      };
    }

    case 'run_command': {
      if (!args.command) throw new Error('run_command requires parameter: command');
      const cwd = args.cwd
        ? resolveWorkspacePath(workspace, args.cwd, allowOutsideWorkspace)
        : path.resolve(workspace);

      if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
        throw new Error(`Working directory does not exist: ${args.cwd}`);
      }

      const result = await runShell(String(args.command), cwd, args.timeout_ms);
      return {
        ok: true,
        tool: toolName,
        durationMs: result.durationMs,
        data: {
          command: String(args.command),
          cwd: toWorkspaceRelative(workspace, cwd),
          ...result,
        },
      };
    }

    default:
      throw new Error(`Unknown tool: "${toolName}"`);
  }
}
