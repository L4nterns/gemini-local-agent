import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openNativeFolderDialog } from './folder-picker.js';
import { AuditLogger, redactSecrets } from './logger.js';
import {
  addWorkspaceToList,
  isExistingDirectory,
  isWorkspaceAuthorized,
  loadOrCreateConfig,
  normalizeFsPathKey,
  parseExtensionOrigin,
  regenerateToken,
  removeWorkspaceFromList,
  resolvePosixShell,
  saveConfig,
  verifyBearerToken,
} from './security.js';
import { executeTool, getWorkspaceContext, previewToolCall, summarizeToolCall } from './tools.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BRIDGE_VERSION = '1.0.0';
const MAX_BODY_BYTES = 5 * 1024 * 1024; // 5 MB

function parseCliArgs(argv) {
  const args = {
    port: Number(process.env.LOCAL_AGENT_PORT) || 3847,
    workspace: process.env.LOCAL_AGENT_WORKSPACE || null,
    resetToken: false,
    resetPair: false,
    allowOutside: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const item = argv[i];
    if (item.startsWith('--port=')) {
      args.port = Number(item.slice('--port='.length)) || 3847;
    } else if (item === '--port' && argv[i + 1]) {
      args.port = Number(argv[++i]) || 3847;
    } else if (item.startsWith('--workspace=')) {
      args.workspace = item.slice('--workspace='.length);
    } else if ((item === '--workspace' || item === '-w') && argv[i + 1]) {
      args.workspace = argv[++i];
    } else if (item === '--reset-token') {
      args.resetToken = true;
    } else if (item === '--reset-pair') {
      args.resetPair = true;
    } else if (item === '--allow-outside') {
      args.allowOutside = true;
    }
  }
  return args;
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        const err = new Error('Request body exceeds 5 MB limit.');
        err.statusCode = 413;
        reject(err);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolve(parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {});
      } catch {
        const err = new Error('Invalid JSON request body.');
        err.statusCode = 400;
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function buildCorsHeaders(origin) {
  const headers = { 'Cache-Control': 'no-store' };
  if (origin && parseExtensionOrigin(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Access-Control-Allow-Headers'] = 'Content-Type, Authorization';
    headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
  }
  return headers;
}

function sendJson(res, statusCode, payload, origin) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    ...buildCorsHeaders(origin),
  });
  res.end(JSON.stringify(payload));
}

function serializeWorkspaces(config) {
  return (config.workspaces || []).map((p) => ({
    path: p,
    name: path.basename(p) || p,
    exists: isExistingDirectory(p),
  }));
}

export function createBridgeServer(options = {}) {
  const configPath = options.configPath || path.join(__dirname, '.bridge-config.json');
  const logsDir = options.logsDir || path.join(__dirname, 'logs');

  let validatedWorkspace = null;
  if (options.workspace) {
    const resolved = path.resolve(options.workspace);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
      throw new Error(`Specified workspace directory does not exist: ${resolved}`);
    }
    validatedWorkspace = resolved;
  }

  const config = loadOrCreateConfig(configPath, validatedWorkspace);

  if (validatedWorkspace) {
    addWorkspaceToList(config, validatedWorkspace);
    saveConfig(configPath, config);
  }
  if (options.resetToken) {
    regenerateToken(configPath, config);
  }
  if (options.resetPair) {
    config.pairedExtensionId = null;
    saveConfig(configPath, config);
  }

  // Runtime-only CLI flag (never persisted to .bridge-config.json)
  const allowOutsideWorkspace = Boolean(options.allowOutside);

  const logger = new AuditLogger(logsDir);
  let pickerInFlight = false;

  const server = http.createServer(async (req, res) => {
    const origin = req.headers.origin || '';
    let urlObj;
    try {
      urlObj = new URL(req.url || '/', 'http://127.0.0.1');
    } catch {
      sendJson(res, 400, { ok: false, error: 'Malformed request URL.' }, '');
      return;
    }
    const pathname = urlObj.pathname;

    if (req.method === 'OPTIONS') {
      res.writeHead(204, buildCorsHeaders(origin));
      res.end();
      return;
    }

    // Defense-in-depth against DNS rebinding: only accept loopback Host headers
    const hostHeader = String(req.headers.host || '').trim();
    if (hostHeader && !/^(?:127\.0\.0\.1|localhost)(?::\d+)?$/i.test(hostHeader)) {
      sendJson(res, 403, { ok: false, error: 'Non-loopback Host header rejected.' }, '');
      return;
    }

    // Only valid browser extension origins or non-browser local clients may reach the bridge
    if (origin && !parseExtensionOrigin(origin)) {
      sendJson(res, 403, { ok: false, error: 'Non-extension origin rejected.' }, '');
      return;
    }

    if (req.method === 'GET' && pathname === '/health') {
      sendJson(
        res,
        200,
        {
          ok: true,
          service: 'gemini-local-agent-bridge',
          version: BRIDGE_VERSION,
          paired: Boolean(config.pairedExtensionId),
        },
        origin
      );
      return;
    }

    // TOFU Auto-Pairing: requires an unforgeable browser extension Origin header
    if (req.method === 'POST' && pathname === '/api/pair') {
      const extId = parseExtensionOrigin(origin);
      if (!extId) {
        sendJson(
          res,
          403,
          { ok: false, error: 'Auto-pairing is only allowed from a browser extension.' },
          ''
        );
        return;
      }

      if (config.pairedExtensionId && config.pairedExtensionId !== extId) {
        sendJson(
          res,
          403,
          {
            ok: false,
            code: 'ALREADY_PAIRED_OTHER',
            error:
              'Bridge is already paired with another extension instance. Restart with --reset-pair or enter the pairing token manually.',
          },
          origin
        );
        return;
      }

      const isFirstPair = !config.pairedExtensionId;
      if (isFirstPair) {
        config.pairedExtensionId = extId;
        saveConfig(configPath, config);
        logger.log({
          tool: 'auto_pair',
          ok: true,
          summary: `Paired with extension (${extId})`,
        });
        console.log(`[Local Bridge] Paired with extension: ${extId}`);
      }

      sendJson(
        res,
        200,
        {
          ok: true,
          token: config.token,
          pairedExtensionId: config.pairedExtensionId,
          firstPair: isFirstPair,
        },
        origin
      );
      return;
    }

    if (!verifyBearerToken(req.headers.authorization, config.token)) {
      sendJson(
        res,
        401,
        {
          ok: false,
          code: 'UNAUTHORIZED',
          error: 'Authentication failed: invalid or missing pairing token.',
        },
        origin
      );
      return;
    }

    try {
      if (req.method === 'GET' && pathname === '/api/info') {
        sendJson(
          res,
          200,
          {
            ok: true,
            version: BRIDGE_VERSION,
            workspaces: serializeWorkspaces(config),
            allowOutsideWorkspace,
            pairedExtensionId: config.pairedExtensionId,
            os: `${os.platform()} ${os.release()} (${os.arch()})`,
            shell: process.platform === 'win32' ? 'powershell.exe' : resolvePosixShell(),
            nodeVersion: process.version,
            logDir: logger.getLogsDir(),
          },
          origin
        );
        return;
      }

      if (req.method === 'POST' && pathname === '/api/workspaces/pick') {
        if (pickerInFlight) {
          sendJson(res, 200, { ok: true, cancelled: true }, origin);
          return;
        }
        pickerInFlight = true;
        const controller = new AbortController();
        const onResClose = () => {
          if (!res.writableEnded) controller.abort();
        };
        res.on('close', onResClose);
        try {
          const initialDir =
            (config.workspaces || []).find((p) => isExistingDirectory(p)) || '';
          const picked = await openNativeFolderDialog(initialDir, {
            signal: controller.signal,
            timeoutMs: 180_000,
          });
          if (res.writableEnded) return;
          if (!picked) {
            sendJson(res, 200, { ok: true, cancelled: true }, origin);
            return;
          }
          const resolved = path.resolve(picked);
          if (!isExistingDirectory(resolved)) {
            sendJson(res, 400, { ok: false, error: `Selected path is not a directory: ${resolved}` }, origin);
            return;
          }
          addWorkspaceToList(config, resolved);
          saveConfig(configPath, config);
          logger.log({
            tool: 'add_workspace',
            ok: true,
            workspace: resolved,
            summary: `Added workspace: ${resolved}`,
          });
          sendJson(
            res,
            200,
            {
              ok: true,
              cancelled: false,
              workspace: resolved,
              workspaces: serializeWorkspaces(config),
            },
            origin
          );
        } catch (err) {
          if (!res.writableEnded) {
            sendJson(res, 500, { ok: false, error: err.message }, origin);
          }
        } finally {
          res.off('close', onResClose);
          pickerInFlight = false;
        }
        return;
      }

      if (req.method === 'POST' && pathname === '/api/workspaces/add') {
        const body = await readJsonBody(req);
        const rawWorkspace = typeof body.workspace === 'string' ? body.workspace.trim() : '';
        if (!rawWorkspace) {
          sendJson(res, 400, { ok: false, error: 'Missing parameter: workspace' }, origin);
          return;
        }
        const resolved = path.resolve(rawWorkspace);
        if (!isExistingDirectory(resolved)) {
          sendJson(res, 400, { ok: false, error: `Directory does not exist: ${resolved}` }, origin);
          return;
        }
        addWorkspaceToList(config, resolved);
        saveConfig(configPath, config);
        sendJson(
          res,
          200,
          {
            ok: true,
            workspace: resolved,
            workspaces: serializeWorkspaces(config),
          },
          origin
        );
        return;
      }

      if (req.method === 'POST' && pathname === '/api/workspaces/remove') {
        const body = await readJsonBody(req);
        if (!body.workspace || typeof body.workspace !== 'string') {
          sendJson(res, 400, { ok: false, error: 'Missing parameter: workspace' }, origin);
          return;
        }
        removeWorkspaceFromList(config, body.workspace);
        saveConfig(configPath, config);
        sendJson(
          res,
          200,
          {
            ok: true,
            workspaces: serializeWorkspaces(config),
          },
          origin
        );
        return;
      }

      if (req.method === 'POST' && pathname === '/api/workspaces/context') {
        const body = await readJsonBody(req);
        const targetWorkspace = body.workspace ? path.resolve(String(body.workspace)) : '';
        if (!targetWorkspace || !isWorkspaceAuthorized(config, targetWorkspace, allowOutsideWorkspace)) {
          sendJson(
            res,
            403,
            {
              ok: false,
              code: 'WORKSPACE_UNREGISTERED',
              error: 'Workspace is not in the authorized workspace list.',
            },
            origin
          );
          return;
        }
        if (!isExistingDirectory(targetWorkspace)) {
          sendJson(
            res,
            400,
            {
              ok: false,
              code: 'WORKSPACE_MISSING',
              error: `Workspace directory no longer exists: ${targetWorkspace}`,
            },
            origin
          );
          return;
        }
        const data = await getWorkspaceContext(targetWorkspace, allowOutsideWorkspace);
        sendJson(res, 200, { ok: true, data }, origin);
        return;
      }

      if (req.method === 'GET' && pathname === '/api/logs') {
        const format = urlObj.searchParams.get('format');
        if (format === 'raw') {
          const raw = logger.readRecentRaw(200);
          res.writeHead(200, {
            'Content-Type': 'application/x-ndjson; charset=utf-8',
            ...buildCorsHeaders(origin),
          });
          res.end(raw);
          return;
        }
        const limit = Number(urlObj.searchParams.get('limit')) || 80;
        sendJson(
          res,
          200,
          {
            ok: true,
            logDir: logger.getLogsDir(),
            logs: logger.getRecent(limit),
          },
          origin
        );
        return;
      }

      if (req.method === 'POST' && pathname === '/api/tool/preview') {
        const body = await readJsonBody(req);
        const targetWorkspace = body.workspace ? path.resolve(String(body.workspace)) : '';
        if (!targetWorkspace || !isWorkspaceAuthorized(config, targetWorkspace, allowOutsideWorkspace)) {
          sendJson(
            res,
            403,
            {
              ok: false,
              code: 'WORKSPACE_UNREGISTERED',
              error: 'Workspace is not in the authorized workspace list.',
            },
            origin
          );
          return;
        }
        if (!isExistingDirectory(targetWorkspace)) {
          sendJson(
            res,
            400,
            {
              ok: false,
              code: 'WORKSPACE_MISSING',
              error: `Workspace directory no longer exists: ${targetWorkspace}`,
            },
            origin
          );
          return;
        }
        if (!Array.isArray(body.calls)) {
          sendJson(res, 400, { ok: false, error: 'Missing parameter: calls' }, origin);
          return;
        }
        const ctx = {
          workspace: targetWorkspace,
          allowOutsideWorkspace,
          virtualFiles: new Map(),
        };
        const previews = body.calls.map((c) => previewToolCall(c?.tool, c?.args || {}, ctx));
        sendJson(res, 200, { ok: true, previews }, origin);
        return;
      }

      if (req.method === 'POST' && pathname === '/api/tool') {
        const body = await readJsonBody(req);
        const toolName = String(body.tool || '').trim();
        const toolArgs = body.args && typeof body.args === 'object' ? body.args : {};
        if (!toolName) {
          sendJson(res, 400, { ok: false, error: 'Missing parameter: tool' }, origin);
          return;
        }

        const targetWorkspace = body.workspace ? path.resolve(String(body.workspace)) : '';
        if (!targetWorkspace || !isWorkspaceAuthorized(config, targetWorkspace, allowOutsideWorkspace)) {
          sendJson(
            res,
            403,
            {
              ok: false,
              tool: toolName,
              code: 'WORKSPACE_UNREGISTERED',
              error: 'Workspace is not in the authorized workspace list.',
            },
            origin
          );
          return;
        }
        if (!isExistingDirectory(targetWorkspace)) {
          sendJson(
            res,
            200,
            {
              ok: false,
              tool: toolName,
              code: 'WORKSPACE_MISSING',
              error: `Workspace directory no longer exists: ${targetWorkspace}`,
            },
            origin
          );
          return;
        }

        const ctx = {
          workspace: targetWorkspace,
          allowOutsideWorkspace,
          forceNodeSearch: Boolean(options.forceNodeSearch),
        };
        const summary = summarizeToolCall(toolName, toolArgs);
        console.log(`[Local Bridge] > ${toolName} -- ${redactSecrets(summary)}`);

        try {
          const result = await executeTool(toolName, toolArgs, ctx);
          logger.log({
            tool: toolName,
            ok: true,
            workspace: targetWorkspace,
            summary,
            args: toolArgs,
            durationMs: result.durationMs,
          });
          sendJson(res, 200, result, origin);
        } catch (toolErr) {
          logger.log({
            tool: toolName,
            ok: false,
            workspace: targetWorkspace,
            summary,
            args: toolArgs,
            error: toolErr.message,
          });
          console.warn(`[Local Bridge] x ${toolName} failed: ${redactSecrets(toolErr.message)}`);
          sendJson(
            res,
            200,
            {
              ok: false,
              tool: toolName,
              error: toolErr.message,
            },
            origin
          );
        }
        return;
      }

      sendJson(res, 404, { ok: false, error: `Unknown endpoint: ${req.method} ${pathname}` }, origin);
    } catch (err) {
      const status = Number.isInteger(err?.statusCode) ? err.statusCode : 500;
      if (!res.writableEnded) {
        sendJson(res, status, { ok: false, error: err.message || 'Internal server error' }, origin);
      }
    }
  });

  return { server, config, configPath, logger, allowOutsideWorkspace };
}

const isDirectRun =
  process.argv[1] && normalizeFsPathKey(process.argv[1]) === normalizeFsPathKey(__filename);

if (isDirectRun) {
  const cli = parseCliArgs(process.argv.slice(2));
  const { server, config, logger, allowOutsideWorkspace } = createBridgeServer({
    workspace: cli.workspace,
    resetToken: cli.resetToken,
    resetPair: cli.resetPair,
    allowOutside: cli.allowOutside,
  });

  const shutdown = () => {
    console.log('\n[Local Bridge] Shutting down...');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  server.listen(cli.port, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${cli.port}`;
    console.log('');
    console.log('===============================================================');
    console.log(`   Gemini Local Agent Bridge v${BRIDGE_VERSION}`);
    console.log('===============================================================');
    console.log(`   Listen URL    : ${url}`);
    console.log(`   Logs Dir      : ${logger.getLogsDir()}`);
    console.log(`   Sandbox       : ${allowOutsideWorkspace ? 'disabled (allow outside)' : 'enabled (workspace only)'}`);
    console.log(`   Pairing       : ${config.pairedExtensionId ? `paired (${config.pairedExtensionId})` : 'ready for auto-pairing'}`);
    console.log(`   Pairing Token : ${config.token}`);
    console.log('===============================================================');
    console.log('   Open https://gemini.google.com to connect automatically.');
    console.log('   Press Ctrl+C to stop.');
    console.log('');
  });
}
