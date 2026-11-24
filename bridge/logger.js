import fs from 'node:fs';
import path from 'node:path';

const RETENTION_DAYS = 30;
const MAX_MEMORY_LOGS = 200;
const SECRET_PATTERNS = [
  /(Bearer\s+)[A-Za-z0-9._+/=-]{12,}/gi,
  /\bgla_[0-9a-f]{16,}\b/gi,
  /((?:api[_-]?key|token|secret|password|passwd|pwd)\s*[:=]\s*["']?)([^\s"',;}{]{8,})/gi,
];

/**
 * Redact potential secrets before persisting audit log records to disk.
 */
export function redactSecrets(value) {
  if (typeof value !== 'string') return value;
  let out = value;
  out = out.replace(SECRET_PATTERNS[0], '$1[REDACTED]');
  out = out.replace(SECRET_PATTERNS[1], 'gla_[REDACTED]');
  out = out.replace(SECRET_PATTERNS[2], '$1[REDACTED]');
  return out;
}

function sanitizeDeep(obj, depth = 0) {
  if (obj === null || obj === undefined) return obj;
  if (depth > 4) return '[TRUNCATED]';
  if (typeof obj === 'string') {
    const redacted = redactSecrets(obj);
    return redacted.length > 600 ? `${redacted.slice(0, 600)}...` : redacted;
  }
  if (Array.isArray(obj)) {
    return obj.slice(0, 20).map((item) => sanitizeDeep(item, depth + 1));
  }
  if (typeof obj === 'object') {
    const clean = {};
    for (const [k, v] of Object.entries(obj)) {
      if (/(?:token|password|passwd|pwd|secret|api[_-]?key|authorization)/i.test(k)) {
        clean[k] = '[REDACTED]';
      } else {
        clean[k] = sanitizeDeep(v, depth + 1);
      }
    }
    return clean;
  }
  return obj;
}

export class AuditLogger {
  constructor(logsDir) {
    this.logsDir = path.resolve(logsDir);
    fs.mkdirSync(this.logsDir, { recursive: true, mode: 0o700 });
    this.memoryLogs = [];
    this.lastPruneDay = this.getTodayKey();
    this.pruneOldLogs();
    this.hydrateRecent();
  }

  getTodayKey() {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  getLogsDir() {
    return this.logsDir;
  }

  listLogFilesDescending() {
    try {
      return fs
        .readdirSync(this.logsDir)
        .filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
        .sort()
        .reverse()
        .map((f) => path.join(this.logsDir, f));
    } catch {
      return [];
    }
  }

  pruneOldLogs() {
    try {
      const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
      for (const full of this.listLogFilesDescending()) {
        const stat = fs.statSync(full);
        if (stat.mtimeMs < cutoff) {
          fs.unlinkSync(full);
        }
      }
    } catch {
      // Ignore pruning errors
    }
  }

  /**
   * Hydrate the latest records continuously across daily files so logs never reset at midnight.
   */
  hydrateRecent() {
    const collected = [];
    for (const file of this.listLogFilesDescending()) {
      if (collected.length >= MAX_MEMORY_LOGS) break;
      try {
        const lines = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
        for (let i = lines.length - 1; i >= 0 && collected.length < MAX_MEMORY_LOGS; i--) {
          try {
            collected.push(JSON.parse(lines[i]));
          } catch {
            // Skip malformed lines
          }
        }
      } catch {
        // Ignore read error
      }
    }
    this.memoryLogs = collected;
  }

  log(entry) {
    const record = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      timestamp: new Date().toISOString(),
      ...sanitizeDeep(entry),
    };

    this.memoryLogs.unshift(record);
    if (this.memoryLogs.length > MAX_MEMORY_LOGS) {
      this.memoryLogs.length = MAX_MEMORY_LOGS;
    }

    const todayKey = this.getTodayKey();
    if (todayKey !== this.lastPruneDay) {
      this.lastPruneDay = todayKey;
      this.pruneOldLogs();
    }

    try {
      fs.appendFileSync(path.join(this.logsDir, `${todayKey}.jsonl`), `${JSON.stringify(record)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      });
    } catch (err) {
      console.warn(`[Local Bridge] Failed to write audit log: ${err.message}`);
    }

    return record;
  }

  getRecent(limit = 80) {
    const clamped = Math.min(Math.max(Number(limit) || 80, 1), MAX_MEMORY_LOGS);
    return this.memoryLogs.slice(0, clamped);
  }

  /**
   * Export recent logs continuously across day boundaries (chronological JSONL).
   */
  readRecentRaw(limit = MAX_MEMORY_LOGS) {
    const items = this.getRecent(limit).slice().reverse();
    return items.map((r) => JSON.stringify(r)).join('\n') + (items.length ? '\n' : '');
  }
}
