import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const READ_ONLY_TOOLS = new Set([
  'list_dir',
  'find_files',
  'grep_search',
  'read_file',
]);

// Accident seatbelt for Auto mode (NOT a security sandbox): pauses clearly
// destructive shell invocations for explicit manual confirmation.
const DANGEROUS_COMMAND_PATTERNS = [
  /\brm\s+-[a-z]*r[a-z]*f\b/i,
  /\brm\s+-[a-z]*f[a-z]*r\b/i,
  /\brm\b[^\n;&|]*(?:\s-[a-z]*r\b|\s--recursive\b)[^\n;&|]*(?:\s-[a-z]*f\b|\s--force\b)/i,
  /\brm\b[^\n;&|]*(?:\s-[a-z]*f\b|\s--force\b)[^\n;&|]*(?:\s-[a-z]*r\b|\s--recursive\b)/i,
  /\b(?:rmdir|rd|del|erase)\b[^\n;&|]*(?:\s|\/[a-z]+)\/s\b/i,
  /\b(?:Remove-Item|ri|rm|del|erase|rd|rmdir)\b[^\n;&|]*\s-r(?:ec(?:urse)?)?\b/i,
  /\bformat\s+[a-z]:/i,
  /\bmkfs\b/i,
  /\bdd\s+if=/i,
  /\bshutdown\b/i,
  /\b(?:restart|stop)-computer\b/i,
  /\bgit\s+push\b[^\n;&|]*(?:--force\b|-f\b)/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+clean\b[^\n;&|]*(?:-[a-z]*f\b|--force\b)/i,
  /\breg\s+delete\b/i,
  /\bchmod\s+-R\s+777\s+\//i,
];

const POSIX_SHELL_NAMES = new Set(['bash', 'zsh', 'sh', 'dash', 'ksh']);

export function resolvePosixShell() {
  const envShell = process.env.SHELL;
  if (envShell && POSIX_SHELL_NAMES.has(path.basename(envShell).toLowerCase())) {
    return envShell;
  }
  return fs.existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh';
}

export function normalizeFsPathKey(p) {
  const resolved = path.resolve(p);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

export function isExistingDirectory(p) {
  if (!p || typeof p !== 'string') return false;
  try {
    return fs.existsSync(p) && fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Load or initialize persistent bridge configuration.
 */
export function loadOrCreateConfig(configPath, defaultWorkspace = null) {
  let config = {};
  if (fs.existsSync(configPath)) {
    try {
      config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch {
      config = {};
    }
  }

  let dirty = false;
  if (!config.token || typeof config.token !== 'string' || config.token.length < 24) {
    config.token = 'gla_' + crypto.randomBytes(24).toString('hex');
    dirty = true;
  }
  if (!Array.isArray(config.workspaces)) {
    config.workspaces = defaultWorkspace ? [path.resolve(defaultWorkspace)] : [];
    dirty = true;
  }
  if (config.pairedExtensionId === undefined) {
    config.pairedExtensionId = null;
    dirty = true;
  }

  if (dirty) {
    saveConfig(configPath, config);
  }
  return config;
}

export function saveConfig(configPath, config) {
  fs.mkdirSync(path.dirname(configPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), { encoding: 'utf8', mode: 0o600 });
}

export function regenerateToken(configPath, config) {
  config.token = 'gla_' + crypto.randomBytes(24).toString('hex');
  saveConfig(configPath, config);
  return config.token;
}

export function isWorkspaceAuthorized(config, targetWorkspace, allowOutsideWorkspace = false) {
  if (!targetWorkspace) return false;
  if (allowOutsideWorkspace) return true;
  const targetKey = normalizeFsPathKey(targetWorkspace);
  const allowed = Array.isArray(config.workspaces) ? config.workspaces : [];
  return allowed.some((p) => normalizeFsPathKey(p) === targetKey);
}

export function addWorkspaceToList(config, workspace) {
  const resolved = path.resolve(workspace);
  const key = normalizeFsPathKey(resolved);
  const existing = Array.isArray(config.workspaces) ? config.workspaces : [];
  const exists = existing.some((p) => normalizeFsPathKey(p) === key);
  if (!exists) {
    config.workspaces = [...existing, resolved].slice(-20);
  }
  return config.workspaces;
}

export function removeWorkspaceFromList(config, workspace) {
  const targetKey = normalizeFsPathKey(workspace);
  const existing = Array.isArray(config.workspaces) ? config.workspaces : [];
  config.workspaces = existing.filter((p) => normalizeFsPathKey(p) !== targetKey);
  return config.workspaces;
}

export function parseExtensionOrigin(origin) {
  if (!origin || typeof origin !== 'string') return null;
  const match = origin.match(/^(?:chrome-extension|moz-extension):\/\/([a-z0-9_-]{8,64})$/i);
  return match ? match[1] : null;
}

function isRelativePathEscaping(rel) {
  return rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);
}

/**
 * Canonicalize a path for sandbox checking, resolving both existing and dangling symlinks
 * using lstatSync/readlinkSync (fails closed on permission or symlink-loop errors).
 */
function resolveRealPathForCheck(targetPath, depth = 0) {
  if (depth > 20) {
    throw new Error(`Too many levels of symbolic links: ${targetPath}`);
  }

  const trailing = [];
  let cursor = path.resolve(targetPath);

  while (true) {
    let lstat = null;
    try {
      lstat = fs.lstatSync(cursor);
    } catch (err) {
      if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) {
        const parent = path.dirname(cursor);
        if (parent === cursor) break;
        trailing.unshift(path.basename(cursor));
        cursor = parent;
        continue;
      }
      throw err;
    }

    if (lstat.isSymbolicLink()) {
      const linkTarget = fs.readlinkSync(cursor);
      const realParent = fs.realpathSync(path.dirname(cursor));
      const nextBase = path.isAbsolute(linkTarget)
        ? linkTarget
        : path.resolve(realParent, linkTarget);
      const nextFull = trailing.length > 0 ? path.join(nextBase, ...trailing) : nextBase;
      return resolveRealPathForCheck(nextFull, depth + 1);
    }

    const realBase = fs.realpathSync(cursor);
    return trailing.length > 0 ? path.join(realBase, ...trailing) : realBase;
  }

  return path.resolve(targetPath);
}

/**
 * Resolve a path safely against workspaceRoot, blocking lexical traversal and symlink escapes
 * (including dangling symlinks) unless allowOutsideWorkspace is explicitly enabled.
 */
export function resolveWorkspacePath(workspaceRoot, targetPath = '.', allowOutsideWorkspace = false) {
  const root = path.resolve(workspaceRoot);
  const cleaned =
    targetPath === undefined || targetPath === null || targetPath === '' ? '.' : String(targetPath);

  const resolved = path.isAbsolute(cleaned) ? path.resolve(cleaned) : path.resolve(root, cleaned);

  if (!allowOutsideWorkspace) {
    const relative = path.relative(root, resolved);
    if (isRelativePathEscaping(relative)) {
      throw new Error(
        `Path escapes workspace boundary: "${cleaned}" resolves to "${resolved}", outside "${root}".`
      );
    }

    const realRoot = resolveRealPathForCheck(root);
    const realTarget = resolveRealPathForCheck(resolved);
    const realRel = path.relative(realRoot, realTarget);
    if (isRelativePathEscaping(realRel)) {
      throw new Error(
        `Path escapes workspace boundary via symlink: "${cleaned}" resolves to "${realTarget}", outside "${realRoot}".`
      );
    }
  }

  return resolved;
}

export function toWorkspaceRelative(workspaceRoot, absolutePath) {
  const rel = path.relative(path.resolve(workspaceRoot), path.resolve(absolutePath));
  return rel ? rel.replace(/\\/g, '/') : '.';
}

/**
 * Detect potentially destructive shell commands that always require manual confirmation.
 */
export function inspectCommandRisk(command) {
  // Collapse POSIX (`\` + newline) and PowerShell (`` ` `` + newline) line continuations
  const cmd = String(command || '').replace(/(?:\\|`)[ \t]*\r?\n/g, ' ');
  for (const pattern of DANGEROUS_COMMAND_PATTERNS) {
    if (pattern.test(cmd)) {
      return {
        dangerous: true,
        reason: `Matches high-risk command rule: ${pattern.source}`,
      };
    }
  }
  return { dangerous: false, reason: null };
}

/**
 * Generate a compact unified diff preview between before and after text.
 */
export function createSimpleDiff(beforeText, afterText, fileLabel = 'file', maxLines = 120) {
  const beforeLines = beforeText === null ? [] : beforeText.replace(/\r\n/g, '\n').split('\n');
  const afterLines = afterText === null ? [] : afterText.replace(/\r\n/g, '\n').split('\n');

  if (beforeText === null) {
    const preview = afterLines.slice(0, maxLines).map((l) => `+ ${l}`);
    if (afterLines.length > maxLines) {
      preview.push(`... (+${afterLines.length - maxLines} more lines)`);
    }
    return `--- /dev/null\n+++ b/${fileLabel}\n${preview.join('\n')}`;
  }

  let start = 0;
  const minLen = Math.min(beforeLines.length, afterLines.length);
  while (start < minLen && beforeLines[start] === afterLines[start]) {
    start++;
  }

  let endBefore = beforeLines.length - 1;
  let endAfter = afterLines.length - 1;
  while (
    endBefore >= start &&
    endAfter >= start &&
    beforeLines[endBefore] === afterLines[endAfter]
  ) {
    endBefore--;
    endAfter--;
  }

  if (start > endBefore && start > endAfter) {
    return '(no content changes)';
  }

  const ctxStart = Math.max(0, start - 2);
  const ctxEndBefore = Math.min(beforeLines.length - 1, endBefore + 2);
  const ctxEndAfter = Math.min(afterLines.length - 1, endAfter + 2);

  const out = [
    `--- a/${fileLabel}`,
    `+++ b/${fileLabel}`,
    `@@ -${ctxStart + 1},${ctxEndBefore - ctxStart + 1} +${ctxStart + 1},${ctxEndAfter - ctxStart + 1} @@`,
  ];

  for (let i = ctxStart; i < start; i++) {
    out.push(`  ${beforeLines[i]}`);
  }
  for (let i = start; i <= endBefore; i++) {
    out.push(`- ${beforeLines[i]}`);
  }
  for (let i = start; i <= endAfter; i++) {
    out.push(`+ ${afterLines[i]}`);
  }
  for (let i = endBefore + 1; i <= ctxEndBefore; i++) {
    out.push(`  ${beforeLines[i]}`);
  }

  if (out.length > maxLines) {
    return [...out.slice(0, maxLines), `... (diff truncated, total ${out.length} lines)`].join('\n');
  }
  return out.join('\n');
}

/**
 * Constant-time Bearer token comparison.
 */
export function verifyBearerToken(authHeader, expectedToken) {
  if (!authHeader || typeof authHeader !== 'string') return false;
  const prefix = 'Bearer ';
  if (!authHeader.startsWith(prefix)) return false;
  const provided = authHeader.slice(prefix.length).trim();
  const a = Buffer.from(provided);
  const b = Buffer.from(expectedToken);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
