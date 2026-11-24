import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AuditLogger, redactSecrets } from './logger.js';
import { inspectCommandRisk, resolveWorkspacePath } from './security.js';
import { createBridgeServer } from './server.js';
import { executeTool } from './tools.js';

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const Parser = require(path.join(rootDir, 'extension', 'tool-parser.js'));
const PromptTpl = require(path.join(rootDir, 'extension', 'prompt-template.js'));
const Session = require(path.join(rootDir, 'extension', 'session-state.js'));

async function runTests() {
  const tempBase = fs.mkdtempSync(path.join(os.tmpdir(), 'gla-bridge-test-'));
  const tempWorkspace = path.join(tempBase, 'workspace');
  const tempLogsDir = path.join(tempBase, 'logs');
  const tempConfig = path.join(tempBase, 'config.json');
  fs.mkdirSync(tempWorkspace, { recursive: true });

  const { server, config } = createBridgeServer({
    workspace: tempWorkspace,
    configPath: tempConfig,
    logsDir: tempLogsDir,
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  const authHeaders = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${config.token}`,
  };

  try {
    // 1. Health, Auth, CORS, Info, TOFU Pairing & Workspace Lifecycle
    const healthRes = await fetch(`${baseUrl}/health`);
    const health = await healthRes.json();
    assert.equal(healthRes.status, 200);
    assert.equal(health.service, 'gemini-local-agent-bridge');
    assert.equal(health.version, '1.0.0');

    assert.equal((await fetch(`${baseUrl}/api/info`)).status, 401);
    assert.equal(
      (await fetch(`${baseUrl}/health`, { headers: { Origin: 'https://evil.example.com' } })).status,
      403
    );
    // Malformed chrome-extension:// origin without valid ID must be rejected
    assert.equal(
      (await fetch(`${baseUrl}/health`, { headers: { Origin: 'chrome-extension://' } })).status,
      403
    );
    // Invalid JSON body -> 400; whitespace-only workspace add -> 400
    assert.equal(
      (
        await fetch(`${baseUrl}/api/workspaces/add`, {
          method: 'POST',
          headers: authHeaders,
          body: '{invalid json',
        })
      ).status,
      400
    );
    assert.equal(
      (
        await fetch(`${baseUrl}/api/workspaces/add`, {
          method: 'POST',
          headers: authHeaders,
          body: JSON.stringify({ workspace: '   ' }),
        })
      ).status,
      400
    );
    // OPTIONS preflight returns 204 with empty body
    const optRes = await fetch(`${baseUrl}/api/info`, {
      method: 'OPTIONS',
      headers: { Origin: 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
    });
    assert.equal(optRes.status, 204);
    assert.equal(await optRes.text(), '');

    // --allow-outside must be runtime-only and NEVER persisted to disk
    const aoCfgPath = path.join(tempBase, 'ao-config.json');
    const aoSrv = createBridgeServer({
      workspace: tempWorkspace,
      configPath: aoCfgPath,
      logsDir: tempLogsDir,
      allowOutside: true,
    });
    assert.equal(aoSrv.allowOutsideWorkspace, true);
    const diskAoCfg = JSON.parse(fs.readFileSync(aoCfgPath, 'utf8'));
    assert.equal(diskAoCfg.allowOutsideWorkspace, undefined);
    aoSrv.server.close();

    // Invalid --workspace must throw BEFORE persisting config to disk
    const badWsCfgPath = path.join(tempBase, 'bad-ws-config.json');
    assert.throws(() => {
      createBridgeServer({
        workspace: path.join(tempBase, 'definitely-missing-dir'),
        configPath: badWsCfgPath,
        logsDir: tempLogsDir,
      });
    }, /does not exist/i);
    assert.equal(fs.existsSync(badWsCfgPath), false);

    const info = await (await fetch(`${baseUrl}/api/info`, { headers: authHeaders })).json();
    assert.equal(info.ok, true);
    assert.equal(info.version, '1.0.0');
    assert.equal(info.workspaces.length, 1);
    assert.equal(path.resolve(info.workspaces[0].path), path.resolve(tempWorkspace));
    assert.equal(info.workspaces[0].exists, true);
    assert.equal(path.resolve(info.logDir), path.resolve(tempLogsDir));

    // TOFU auto-pairing security checks
    assert.equal(
      (
        await fetch(`${baseUrl}/api/pair`, {
          method: 'POST',
          headers: { Origin: 'https://evil.example.com' },
        })
      ).status,
      403
    );
    assert.equal((await fetch(`${baseUrl}/api/pair`, { method: 'POST' })).status, 403);

    const extOriginA = 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const pair1Res = await fetch(`${baseUrl}/api/pair`, {
      method: 'POST',
      headers: { Origin: extOriginA },
    });
    const pair1 = await pair1Res.json();
    assert.equal(pair1Res.status, 200);
    assert.equal(pair1.ok, true);
    assert.equal(pair1.firstPair, true);
    assert.equal(pair1.token, config.token);

    const pair1Again = await (
      await fetch(`${baseUrl}/api/pair`, { method: 'POST', headers: { Origin: extOriginA } })
    ).json();
    assert.equal(pair1Again.ok, true);
    assert.equal(pair1Again.firstPair, false);

    const pairOtherRes = await fetch(`${baseUrl}/api/pair`, {
      method: 'POST',
      headers: { Origin: 'chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' },
    });
    const pairOther = await pairOtherRes.json();
    assert.equal(pairOtherRes.status, 403);
    assert.equal(pairOther.code, 'ALREADY_PAIRED_OTHER');

    // Workspace add, stable ordering, isolation, missing-folder guard & remove to empty
    const ws2 = path.join(tempBase, 'workspace-2');
    fs.mkdirSync(ws2, { recursive: true });
    const addWs2 = await (
      await fetch(`${baseUrl}/api/workspaces/add`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ workspace: ws2 }),
      })
    ).json();
    assert.equal(addWs2.ok, true);
    assert.equal(addWs2.workspaces.length, 2);
    assert.equal(path.resolve(addWs2.workspaces[0].path), path.resolve(tempWorkspace));
    assert.equal(path.resolve(addWs2.workspaces[1].path), path.resolve(ws2));

    // Re-adding workspace 0 must NOT reorder the list
    const reAddWs1 = await (
      await fetch(`${baseUrl}/api/workspaces/add`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ workspace: tempWorkspace }),
      })
    ).json();
    assert.equal(reAddWs1.workspaces.length, 2);
    assert.equal(path.resolve(reAddWs1.workspaces[0].path), path.resolve(tempWorkspace));
    assert.equal(path.resolve(reAddWs1.workspaces[1].path), path.resolve(ws2));

    // Per-request workspace isolation
    const ws2Write = await (
      await fetch(`${baseUrl}/api/tool`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          workspace: ws2,
          tool: 'write_file',
          args: { path: 'isolated.txt', content: 'from ws2' },
        }),
      })
    ).json();
    assert.equal(ws2Write.ok, true);
    assert.equal(fs.existsSync(path.join(ws2, 'isolated.txt')), true);
    assert.equal(fs.existsSync(path.join(tempWorkspace, 'isolated.txt')), false);

    // Deleted workspace handling
    fs.rmSync(ws2, { recursive: true, force: true });
    const infoAfterDel = await (await fetch(`${baseUrl}/api/info`, { headers: authHeaders })).json();
    const ws2Entry = infoAfterDel.workspaces.find((w) => path.resolve(w.path) === path.resolve(ws2));
    assert.ok(ws2Entry);
    assert.equal(ws2Entry.exists, false);

    const missingToolRes = await (
      await fetch(`${baseUrl}/api/tool`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ workspace: ws2, tool: 'list_dir', args: {} }),
      })
    ).json();
    assert.equal(missingToolRes.ok, false);
    assert.equal(missingToolRes.code, 'WORKSPACE_MISSING');

    const missingCtxRes = await fetch(`${baseUrl}/api/workspaces/context`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ workspace: ws2 }),
    });
    const missingCtxJson = await missingCtxRes.json();
    assert.equal(missingCtxRes.status, 400);
    assert.equal(missingCtxJson.code, 'WORKSPACE_MISSING');

    // Unregistered or missing workspace parameter must be rejected (403)
    const unregRes = await fetch(`${baseUrl}/api/tool`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ workspace: tempBase, tool: 'list_dir', args: {} }),
    });
    const unregJson = await unregRes.json();
    assert.equal(unregRes.status, 403);
    assert.equal(unregJson.code, 'WORKSPACE_UNREGISTERED');

    const noWsRes = await fetch(`${baseUrl}/api/tool`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ tool: 'list_dir', args: {} }),
    });
    assert.equal(noWsRes.status, 403);

    // Removing ws2 leaves 1 workspace; removing last workspace leaves 0
    const rmWs2 = await (
      await fetch(`${baseUrl}/api/workspaces/remove`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ workspace: ws2 }),
      })
    ).json();
    assert.equal(rmWs2.ok, true);
    assert.equal(rmWs2.workspaces.length, 1);

    const rmLast = await (
      await fetch(`${baseUrl}/api/workspaces/remove`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ workspace: tempWorkspace }),
      })
    ).json();
    assert.equal(rmLast.ok, true);
    assert.equal(rmLast.workspaces.length, 0);

    // Re-add tempWorkspace and verify internal /api/workspaces/context endpoint
    await fetch(`${baseUrl}/api/workspaces/add`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ workspace: tempWorkspace }),
    });
    const ctxRes = await (
      await fetch(`${baseUrl}/api/workspaces/context`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ workspace: tempWorkspace }),
      })
    ).json();
    assert.equal(ctxRes.ok, true);
    assert.equal(path.resolve(ctxRes.data.workspace), path.resolve(tempWorkspace));
    assert.ok(Array.isArray(ctxRes.data.treePreview));
    assert.equal(
      (
        await fetch(`${baseUrl}/api/workspaces/context`, {
          method: 'POST',
          headers: authHeaders,
          body: JSON.stringify({ workspace: tempBase }),
        })
      ).status,
      403
    );
    console.log('✓ 1. Health, Auth, CORS, TOFU Pairing, Workspace Isolation & Context verified');

    // 2. File write/read/edit/list_dir, atomic multi-hunk edit & chained virtual preview
    const writeRes = await (
      await fetch(`${baseUrl}/api/tool`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          workspace: tempWorkspace,
          tool: 'write_file',
          args: {
            path: 'src/app.js',
            content: 'const a = "alpha";\r\nconst b = "beta";\r\nconsole.log(a, b);\r\n',
          },
        }),
      })
    ).json();
    assert.equal(writeRes.ok, true);
    assert.equal(writeRes.data.created, true);

    // Atomic multi-hunk edit rollback check: hunk #1 valid, hunk #2 missing -> file untouched
    const failMulti = await (
      await fetch(`${baseUrl}/api/tool`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          workspace: tempWorkspace,
          tool: 'edit_file',
          args: {
            path: 'src/app.js',
            edits: [
              { target: '"alpha"', replacement: '"ALPHA"' },
              { target: '"nonexistent"', replacement: '"X"' },
            ],
          },
        }),
      })
    ).json();
    assert.equal(failMulti.ok, false);
    assert.match(failMulti.error, /Edit #2/i);
    assert.match(fs.readFileSync(path.join(tempWorkspace, 'src/app.js'), 'utf8'), /"alpha"/);

    // Chained virtual preview across two sequential edit_file calls on the same file
    const chainedPreview = await (
      await fetch(`${baseUrl}/api/tool/preview`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          workspace: tempWorkspace,
          calls: [
            { tool: 'edit_file', args: { path: 'src/app.js', target: '"alpha"', replacement: '"ALPHA"' } },
            { tool: 'edit_file', args: { path: 'src/app.js', target: '"ALPHA"', replacement: '"FINAL"' } },
          ],
        }),
      })
    ).json();
    assert.equal(chainedPreview.ok, true);
    assert.equal(chainedPreview.previews[0].warning, null);
    assert.equal(chainedPreview.previews[1].warning, null);
    assert.match(chainedPreview.previews[1].diff, /\+ const a = "FINAL";/);

    // Atomic multi-hunk edit success + CRLF preservation
    const multiEditRes = await (
      await fetch(`${baseUrl}/api/tool`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          workspace: tempWorkspace,
          tool: 'edit_file',
          args: {
            path: 'src/app.js',
            edits: [
              { target: '"alpha"', replacement: '"hello Local Agent"' },
              { target: '"beta"', replacement: '"BETA"' },
            ],
          },
        }),
      })
    ).json();
    assert.equal(multiEditRes.ok, true);
    assert.equal(multiEditRes.data.edits, 2);
    const afterMulti = fs.readFileSync(path.join(tempWorkspace, 'src/app.js'), 'utf8');
    assert.match(afterMulti, /hello Local Agent/);
    assert.match(afterMulti, /"BETA"/);
    assert.ok(afterMulti.includes('\r\n'), 'CRLF line endings must be preserved');

    // Single edit_file must NOT corrupt $-patterns ($$, $&, $')
    await fetch(`${baseUrl}/api/tool`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        workspace: tempWorkspace,
        tool: 'write_file',
        args: { path: 'src/dollar.txt', content: 'PLACEHOLDER\n' },
      }),
    });
    const dollarEdit = await (
      await fetch(`${baseUrl}/api/tool`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          workspace: tempWorkspace,
          tool: 'edit_file',
          args: { path: 'src/dollar.txt', target: 'PLACEHOLDER', replacement: 'price=$$100 match=$&' },
        }),
      })
    ).json();
    assert.equal(dollarEdit.ok, true);
    assert.equal(
      fs.readFileSync(path.join(tempWorkspace, 'src/dollar.txt'), 'utf8'),
      'price=$$100 match=$&\n'
    );
    fs.unlinkSync(path.join(tempWorkspace, 'src/dollar.txt'));

    // write_file must reject overwriting a directory
    const dirOverwrite = await (
      await fetch(`${baseUrl}/api/tool`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          workspace: tempWorkspace,
          tool: 'write_file',
          args: { path: 'src', content: 'oops' },
        }),
      })
    ).json();
    assert.equal(dirOverwrite.ok, false);
    assert.match(dirOverwrite.error, /directory/i);

    // Ambiguous target must be warned in preview too
    await fetch(`${baseUrl}/api/tool`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        workspace: tempWorkspace,
        tool: 'write_file',
        args: { path: 'src/dup.txt', content: 'dup\ndup\n' },
      }),
    });
    const dupPreview = await (
      await fetch(`${baseUrl}/api/tool/preview`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          workspace: tempWorkspace,
          calls: [{ tool: 'edit_file', args: { path: 'src/dup.txt', target: 'dup', replacement: 'x' } }],
        }),
      })
    ).json();
    assert.match(dupPreview.previews[0].warning, /Found 2 matches/i);
    fs.unlinkSync(path.join(tempWorkspace, 'src/dup.txt'));

    // read_file (line range, out-of-range start_line, binary detection) & list_dir
    const readRes = await (
      await fetch(`${baseUrl}/api/tool`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          workspace: tempWorkspace,
          tool: 'read_file',
          args: { path: 'src/app.js', start_line: 1, end_line: 2 },
        }),
      })
    ).json();
    assert.equal(readRes.ok, true);
    assert.equal(readRes.data.startLine, 1);
    assert.equal(readRes.data.endLine, 2);
    assert.match(readRes.data.content, /^1: .*hello Local Agent/m);

    const readPastEof = await (
      await fetch(`${baseUrl}/api/tool`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          workspace: tempWorkspace,
          tool: 'read_file',
          args: { path: 'src/app.js', start_line: 999 },
        }),
      })
    ).json();
    assert.equal(readPastEof.ok, true);
    assert.equal(readPastEof.data.content, '');
    assert.equal(readPastEof.data.endLine, readPastEof.data.totalLines);

    fs.writeFileSync(path.join(tempWorkspace, 'src/bin.dat'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
    const readBin = await (
      await fetch(`${baseUrl}/api/tool`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          workspace: tempWorkspace,
          tool: 'read_file',
          args: { path: 'src/bin.dat' },
        }),
      })
    ).json();
    assert.equal(readBin.ok, true);
    assert.equal(readBin.data.binary, true);

    // edit_file must reject binary files, and write_file preview must warn when content is missing
    const editBin = await (
      await fetch(`${baseUrl}/api/tool`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          workspace: tempWorkspace,
          tool: 'edit_file',
          args: { path: 'src/bin.dat', target: 'PNG', replacement: 'JPG' },
        }),
      })
    ).json();
    assert.equal(editBin.ok, false);
    assert.match(editBin.error, /Binary file/i);

    // Overwriting a binary file with write_file must omit garbled diff
    const overwriteBin = await (
      await fetch(`${baseUrl}/api/tool`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          workspace: tempWorkspace,
          tool: 'write_file',
          args: { path: 'src/bin.dat', content: 'now plain text' },
        }),
      })
    ).json();
    assert.equal(overwriteBin.ok, true);
    assert.match(overwriteBin.data.diff, /previous file was binary/i);
    fs.unlinkSync(path.join(tempWorkspace, 'src/bin.dat'));

    const missingContentPreview = await (
      await fetch(`${baseUrl}/api/tool/preview`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          workspace: tempWorkspace,
          calls: [{ tool: 'write_file', args: { path: 'src/app.js' } }],
        }),
      })
    ).json();
    assert.match(missingContentPreview.previews[0].warning, /requires parameter: content/i);

    const listRes = await (
      await fetch(`${baseUrl}/api/tool`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          workspace: tempWorkspace,
          tool: 'list_dir',
          args: { path: '.', max_depth: 2 },
        }),
      })
    ).json();
    assert.equal(listRes.ok, true);
    assert.ok(listRes.data.entries.some((e) => e.path === 'src/app.js' && e.type === 'file'));
    console.log('✓ 2. write_file, read_file, list_dir, atomic multi-hunk edit_file & chained preview verified');

    // 3. Discovery, grep (context_lines & files_only), run_command, high-risk seatbelt & path sandbox
    const previewRes = await (
      await fetch(`${baseUrl}/api/tool/preview`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          workspace: tempWorkspace,
          calls: [
            { tool: 'run_command', args: { command: 'Remove-Item -Recurse -Force C:\\temp' } },
            { tool: 'run_command', args: { command: 'rm -rf /important' } },
            { tool: 'run_command', args: { command: 'git reset --hard HEAD~1' } },
            { tool: 'run_command', args: { command: 'npm test -- --watch=false' } },
          ],
        }),
      })
    ).json();
    assert.equal(previewRes.ok, true);
    assert.equal(previewRes.previews[0].dangerous, true);
    assert.equal(previewRes.previews[1].dangerous, true);
    assert.equal(previewRes.previews[2].dangerous, true);
    assert.equal(previewRes.previews[3].dangerous, false);
    assert.equal(inspectCommandRisk('rm \\\n-rf /tmp/x').dangerous, true);
    assert.equal(inspectCommandRisk('git push --force origin main').dangerous, true);
    assert.equal(inspectCommandRisk('del -Recurse -Force C:\\temp').dangerous, true);
    assert.equal(inspectCommandRisk('rmdir /q /s C:\\temp').dangerous, true);
    assert.equal(inspectCommandRisk('del /f /q /s C:\\temp').dangerous, true);
    assert.equal(inspectCommandRisk('Stop-Computer -Force').dangerous, true);
    assert.equal(inspectCommandRisk('git clean --force -d').dangerous, true);
    assert.equal(inspectCommandRisk('Remove-Item -Rec C:\\temp').dangerous, true);
    // Harmless commands must NOT trigger false positives
    assert.equal(inspectCommandRisk('del src/utils').dangerous, false);
    assert.equal(inspectCommandRisk('rm a && echo -r -foo').dangerous, false);

    // run_command execution
    const runRes = await (
      await fetch(`${baseUrl}/api/tool`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          workspace: tempWorkspace,
          tool: 'run_command',
          args: { command: 'node -e "console.log(123 + 456)"' },
        }),
      })
    ).json();
    assert.equal(runRes.ok, true);
    assert.equal(runRes.data.exitCode, 0);
    assert.match(runRes.data.stdout, /579/);

    // Unknown tools must be rejected by /api/tool
    const unknownRes = await (
      await fetch(`${baseUrl}/api/tool`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ workspace: tempWorkspace, tool: 'nonexistent_tool', args: {} }),
      })
    ).json();
    assert.equal(unknownRes.ok, false);
    assert.match(unknownRes.error, /Unknown tool/i);

    // /api/tool/preview requires calls array
    const badPreviewRes = await fetch(`${baseUrl}/api/tool/preview`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ workspace: tempWorkspace, tool: 'read_file', args: {} }),
    });
    assert.equal(badPreviewRes.status, 400);

    // grep_search (context_lines & files_only) + find_files (**/*.js glob) on both HTTP and pure-Node fallback
    const grepCtxHttp = await (
      await fetch(`${baseUrl}/api/tool`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          workspace: tempWorkspace,
          tool: 'grep_search',
          args: { query: 'BETA', context_lines: 1 },
        }),
      })
    ).json();
    assert.equal(grepCtxHttp.ok, true);
    assert.equal(grepCtxHttp.data.count, 1);
    assert.ok(Array.isArray(grepCtxHttp.data.matches[0].context));

    const grepCtxNode = await executeTool(
      'grep_search',
      { query: 'BETA', context_lines: 1.5 },
      { workspace: tempWorkspace, allowOutsideWorkspace: false, forceNodeSearch: true }
    );
    assert.equal(grepCtxNode.ok, true);
    assert.equal(grepCtxNode.data.engine, 'node');
    assert.equal(grepCtxNode.data.count, 1);
    assert.ok(grepCtxNode.data.matches[0].context.length >= 2);

    const grepFilesNode = await executeTool(
      'grep_search',
      { query: 'hello Local Agent', files_only: true },
      { workspace: tempWorkspace, allowOutsideWorkspace: false, forceNodeSearch: true }
    );
    assert.equal(grepFilesNode.ok, true);
    assert.equal(grepFilesNode.data.filesOnly, true);
    assert.deepEqual(grepFilesNode.data.files, ['src/app.js']);

    const findGlobNode = await executeTool(
      'find_files',
      { pattern: '**/*.js' },
      { workspace: tempWorkspace, allowOutsideWorkspace: false, forceNodeSearch: true }
    );
    assert.equal(findGlobNode.ok, true);
    assert.equal(findGlobNode.data.engine, 'node');
    assert.deepEqual(findGlobNode.data.matches, ['src/app.js']);

    // In-workspace filenames starting with ".." (e.g. "..config") must NOT be falsely rejected
    assert.equal(
      path.basename(resolveWorkspacePath(tempWorkspace, '..config', false)),
      '..config'
    );

    const escapeRes = await (
      await fetch(`${baseUrl}/api/tool`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          workspace: tempWorkspace,
          tool: 'read_file',
          args: { path: '../../outside.txt' },
        }),
      })
    ).json();
    assert.equal(escapeRes.ok, false);
    assert.match(escapeRes.error, /escapes workspace boundary/i);

    // Symlink/junction escape guard
    const outsideDir = path.join(tempBase, 'outside-secret');
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.writeFileSync(path.join(outsideDir, 'secret.txt'), 'TOP_SECRET', 'utf8');
    const linkPath = path.join(tempWorkspace, 'escape-link');
    let symlinkCreated = false;
    try {
      fs.symlinkSync(outsideDir, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
      symlinkCreated = true;
    } catch {
      // Skip if OS policy restricts symlink creation
    }
    if (symlinkCreated) {
      const symRes = await (
        await fetch(`${baseUrl}/api/tool`, {
          method: 'POST',
          headers: authHeaders,
          body: JSON.stringify({
            workspace: tempWorkspace,
            tool: 'read_file',
            args: { path: 'escape-link/secret.txt' },
          }),
        })
      ).json();
      assert.equal(symRes.ok, false);
      assert.match(symRes.error, /escapes workspace boundary via symlink/i);
      fs.unlinkSync(linkPath);
    }
    console.log('✓ 3. grep_search (rg/node), run_command, high-risk seatbelt & symlink sandbox verified');

    // 4. Cross-midnight continuous audit logs & secret redaction
    const logsJson = await (await fetch(`${baseUrl}/api/logs`, { headers: authHeaders })).json();
    assert.equal(logsJson.ok, true);
    assert.equal(path.resolve(logsJson.logDir), path.resolve(tempLogsDir));
    assert.ok(logsJson.logs.length >= 5);

    const rawLogs = await (
      await fetch(`${baseUrl}/api/logs?format=raw`, { headers: authHeaders })
    ).text();
    assert.ok(rawLogs.trim().split('\n').length >= 5);

    // Verify continuous hydration & raw export across multiple day files
    const multiDayDir = path.join(tempBase, 'multi-day-logs');
    fs.mkdirSync(multiDayDir, { recursive: true });
    fs.writeFileSync(
      path.join(multiDayDir, '2026-11-23.jsonl'),
      `${JSON.stringify({ ts: '2026-11-23T23:59:00.000Z', tool: 'read_file', ok: true, summary: 'day1' })}\n`,
      'utf8'
    );
    fs.writeFileSync(
      path.join(multiDayDir, '2026-11-24.jsonl'),
      `${JSON.stringify({ ts: '2026-11-24T00:01:00.000Z', tool: 'write_file', ok: true, summary: 'day2' })}\n`,
      'utf8'
    );
    const multiLogger = new AuditLogger(multiDayDir);
    const hydrated = multiLogger.getRecent(10);
    assert.equal(hydrated.length, 2);
    assert.equal(hydrated[0].summary, 'day2');
    assert.equal(hydrated[1].summary, 'day1');
    const multiRaw = multiLogger.readRecentRaw(10).trim().split('\n');
    assert.equal(multiRaw.length, 2);

    // Deep nested secrets (depth > 4) and apiKey fields must be truncated/redacted
    const deepRec = multiLogger.log({
      tool: 'test_redact',
      ok: true,
      args: {
        apiKey: 'sk-super-secret-value-1234',
        a: { b: { c: { d: { e: { secretLeak: 'Bearer abcdef1234567890' } } } } },
      },
    });
    assert.equal(deepRec.args.apiKey, '[REDACTED]');
    assert.doesNotMatch(JSON.stringify(deepRec), /abcdef1234567890/);
    assert.doesNotMatch(JSON.stringify(deepRec), /sk-super-secret/);

    const redacted = redactSecrets(
      'Authorization: Bearer abc+def/1234567890== token=gla_0123456789abcdef0123456789abcdef'
    );
    assert.doesNotMatch(redacted, /abc\+def/);
    assert.doesNotMatch(redacted, /1234567890/);
    assert.doesNotMatch(redacted, /0123456789abcdef/);
    console.log('✓ 4. Cross-midnight JSONL audit logging and secret redaction verified');

    // 5. Minimalist 7-tool Parser & English Prompt Templates
    assert.equal(Parser.KNOWN_TOOLS.size, 7);
    assert.equal(Parser.READ_ONLY_TOOLS.size, 4);

    const parsedValid = Parser.extractToolCallsFromBlocks([
      {
        lang: 'json',
        text: '{"$local_agent": true, "calls": [{"tool": "grep_search", "args": {"query": "foo"}},]}',
      },
    ]);
    assert.ok(parsedValid);
    assert.equal(parsedValid.calls[0].tool, 'grep_search');

    // Collapsed <model-thoughts> draft blocks must be ignored by extractFromDomElement
    const mockThoughtNode = {
      tagName: 'CODE',
      innerText: '',
      textContent: '{"$local_agent": true, "calls": [{"tool": "run_command", "args": {"command": "echo draft"}}]}',
      querySelector: () => null,
      closest: (sel) => (sel.includes('model-thoughts') ? {} : null),
    };
    const mockFinalNode = {
      tagName: 'CODE',
      innerText: '{"$local_agent": true, "calls": [{"tool": "read_file", "args": {"path": "README.md"}}]}',
      textContent: '',
      querySelector: () => null,
      closest: () => null,
    };
    const fromThoughtsOnly = Parser.extractFromDomElement({
      querySelectorAll: () => [mockThoughtNode],
    });
    assert.equal(fromThoughtsOnly, null);
    const fromMixed = Parser.extractFromDomElement({
      querySelectorAll: () => [mockThoughtNode, mockFinalNode],
    });
    assert.ok(fromMixed);
    assert.equal(fromMixed.calls[0].tool, 'read_file');

    // Unknown tool names and plain JSON without "$local_agent": true MUST be ignored
    const rejectedUnknown = Parser.extractToolCallsFromBlocks([
      {
        lang: 'json',
        text: '{"$local_agent": true, "calls": [{"tool": "nonexistent_tool", "args": {}}]}',
      },
    ]);
    assert.equal(rejectedUnknown, null);

    const ignoredPlain = Parser.extractToolCallsFromBlocks([
      { lang: 'json', text: '{"tool": "read_file", "args": {"path": "a.txt"}}' },
    ]);
    assert.equal(ignoredPlain, null);

    // Legacy single-tool object without "calls" array must be rejected under strict protocol
    const rejectedLegacySingle = Parser.extractToolCallsFromBlocks([
      { lang: 'json', text: '{"$local_agent": true, "tool": "read_file", "args": {"path": "a.txt"}}' },
    ]);
    assert.equal(rejectedLegacySingle, null);

    assert.throws(() => PromptTpl.buildSystemPrompt({}, 'Inspect the project'), /workspace/i);

    const promptText = PromptTpl.buildSystemPrompt(
      { workspace: tempWorkspace, os: 'win32', shell: 'powershell.exe' },
      'Inspect the project'
    );
    assert.match(promptText, /\[LOCAL_AGENT_SYSTEM_PROMPT\]/);
    assert.match(promptText, /\$local_agent/);
    assert.match(promptText, /Inspect the project/);

    const rejectedMsg = PromptTpl.formatToolResults([
      {
        tool: 'edit_file',
        ok: false,
        rejected: true,
        status: 'REJECTED_BY_USER',
        reason: 'Please edit utils.js instead of app.js',
      },
    ]);
    assert.match(rejectedMsg, /\[LOCAL_AGENT_TOOL_RESULT\]/);
    assert.match(rejectedMsg, /Please edit utils\.js instead of app\.js/);
    const queuedMsg = PromptTpl.formatToolResults(
      [{ tool: 'run_command', ok: true, status: 'SUCCESS', data: { command: 'npm test', cwd: '.', durationMs: 120, exitCode: 0, stdout: '```js\nok\n```' } }],
      ['Also add a README note']
    );
    assert.match(queuedMsg, /\[USER_FOLLOW_UP\]/);
    assert.match(queuedMsg, /Also add a README note/);
    assert.match(queuedMsg, /````\n```js\nok\n```\n````/);
    console.log('✓ 5. Minimalist 7-tool parser & English prompt templates verified');

    // 5b. Conversation Session State Machine & Rich-Formatted Gemini DOM Detection
    assert.equal(Session.getChatIdFromPath('/app'), null);
    assert.equal(Session.getChatIdFromPath('/u/0/app'), null);
    assert.equal(Session.getChatIdFromPath('/app/d293b4e5a1d14e49'), 'd293b4e5a1d14e49');
    assert.equal(Session.getChatIdFromPath('/u/1/app/abc123'), 'abc123');
    assert.equal(Session.getChatIdFromPath('/gem/coding-bot'), null);
    assert.equal(Session.getChatIdFromPath('/gem/coding-bot/xyz789'), 'xyz789');

    // Detect raw Markdown prompt ("- Workspace: ...")
    const rawDetected = Session.detectConversationFromSnapshot({
      queryTexts: [promptText],
      responseCount: 1,
    });
    assert.equal(rawDetected.detected, 'agent');
    assert.equal(rawDetected.workspace, tempWorkspace);

    // Detect live Gemini rich-formatted prompt where "- " is stripped into <ul><li> ("Workspace: ...")
    const richFormattedQuery =
      '你说 [LOCAL_AGENT_SYSTEM_PROMPT] You are operating as a local software engineering agent...\n\n' +
      '[LOCAL_AGENT_SYSTEM_PROMPT]\n\n' +
      '## Environment\n\n' +
      'Workspace: C:\\Users\\linqi\\Downloads\\de-ai-traces\n' +
      'OS: win32 10.0.26300 (x64)\n' +
      'Shell: powershell.exe\n\n' +
      '## Tool Call Protocol (Strict)\n';
    const richDetected = Session.detectConversationFromSnapshot({
      queryTexts: [richFormattedQuery],
      responseCount: 1,
    });
    assert.equal(richDetected.detected, 'agent');
    assert.equal(richDetected.workspace, 'C:\\Users\\linqi\\Downloads\\de-ai-traces');

    // Bullet symbol & indented variants
    const bulletDetected = Session.detectConversationFromSnapshot({
      queryTexts: ['[LOCAL_AGENT_SYSTEM_PROMPT]\n## Environment\n  • Workspace: /srv/my-app\n'],
      responseCount: 0,
    });
    assert.equal(bulletDetected.detected, 'agent');
    assert.equal(bulletDetected.workspace, '/srv/my-app');

    // Partial prompt without parseable workspace must NEVER be misclassified as 'normal'
    const partialDetected = Session.detectConversationFromSnapshot({
      queryTexts: ['[LOCAL_AGENT_SYSTEM_PROMPT]\n## Environment\n'],
      responseCount: 1,
    });
    assert.equal(partialDetected.detected, 'agent_partial');
    assert.equal(partialDetected.workspace, null);

    // Normal chat mentioning marker text without structure stays 'normal'
    assert.deepEqual(
      Session.detectConversationFromSnapshot({
        queryTexts: ['What does [LOCAL_AGENT_SYSTEM_PROMPT] mean?'],
        responseCount: 1,
      }),
      { detected: 'normal', workspace: null }
    );
    assert.deepEqual(
      Session.detectConversationFromSnapshot({ queryTexts: [] }),
      { detected: 'empty', workspace: null }
    );
    // Skeleton/unhydrated <user-query> with whitespace-only text must stay 'empty', NEVER 'normal'
    assert.deepEqual(
      Session.detectConversationFromSnapshot({ queryTexts: ['   \n  '] }),
      { detected: 'empty', workspace: null }
    );

    // URL transition classification
    const t0 = 1_700_000_000_000;
    const pendingAgent = {
      mode: 'agent',
      workspace: 'C:\\Users\\linqi\\Downloads\\de-ai-traces',
      mounted: true,
      locked: true,
      createdAt: t0,
    };
    assert.equal(
      Session.classifyUrlChange({
        prevUrl: 'https://gemini.google.com/app',
        nextUrl: 'https://gemini.google.com/app?hl=zh-CN',
        pendingNewChat: pendingAgent,
        now: t0 + 2000,
      }).action,
      'ignore'
    );
    // Slow Thinking model response taking 45s (> old 15s timeout) must still bind cleanly
    assert.deepEqual(
      Session.classifyUrlChange({
        prevUrl: 'https://gemini.google.com/app',
        nextUrl: 'https://gemini.google.com/app/chat45s',
        chatModes: {},
        pendingNewChat: pendingAgent,
        now: t0 + 45_000,
      }),
      { action: 'bind_new_chat', nextChatId: 'chat45s' }
    );
    // Expired pendingNewChat (> 5 min) falls back to switch_chat
    assert.equal(
      Session.classifyUrlChange({
        prevUrl: 'https://gemini.google.com/app',
        nextUrl: 'https://gemini.google.com/app/chatExpired',
        chatModes: {},
        pendingNewChat: pendingAgent,
        now: t0 + Session.PENDING_NEW_CHAT_TTL_MS + 1000,
      }).action,
      'switch_chat'
    );

    // First response URL transition with rich-formatted DOM preserves agent mode & persists it
    const firstTurnBind = Session.resolveConversationSync({
      chatId: 'd293b4e5a1d14e49',
      storedRecord: null,
      pendingNewChat: pendingAgent,
      domState: richDetected,
      now: t0 + 45_000,
    });
    assert.equal(firstTurnBind.chatMode, 'agent');
    assert.equal(firstTurnBind.chatBoundWorkspace, 'C:\\Users\\linqi\\Downloads\\de-ai-traces');
    assert.equal(firstTurnBind.conversationMounted, true);
    assert.equal(firstTurnBind.chatLocked, true);
    assert.equal(firstTurnBind.clearPendingNewChat, true);
    assert.equal(firstTurnBind.persistRecord?.mode, 'agent');

    // Partial DOM during first response binding still preserves pendingNewChat workspace
    const partialBind = Session.resolveConversationSync({
      chatId: 'chatPartial',
      storedRecord: null,
      pendingNewChat: pendingAgent,
      domState: partialDetected,
      now: t0 + 10_000,
    });
    assert.equal(partialBind.chatMode, 'agent');
    assert.equal(partialBind.chatBoundWorkspace, pendingAgent.workspace);
    assert.equal(partialBind.persistRecord?.mode, 'agent');

    // Genuine contradiction (user jumped to a normal existing chat) does NOT pollute that chat with agent mode
    const jumpedToNormal = Session.resolveConversationSync({
      chatId: 'existingNormal',
      storedRecord: null,
      pendingNewChat: pendingAgent,
      domState: { detected: 'normal', workspace: null },
      now: t0 + 3000,
    });
    assert.equal(jumpedToNormal.chatMode, 'normal');
    assert.equal(jumpedToNormal.chatBoundWorkspace, null);
    assert.equal(jumpedToNormal.persistRecord?.mode, 'normal');

    // Self-healing: previously mis-cached 'normal' record upgrades to 'agent' once DOM proves it
    const healed = Session.resolveConversationSync({
      chatId: 'd293b4e5a1d14e49',
      storedRecord: { mode: 'normal', workspace: null, mounted: false, locked: true },
      pendingNewChat: null,
      domState: richDetected,
      now: t0 + 60_000,
    });
    assert.equal(healed.chatMode, 'agent');
    assert.equal(healed.chatBoundWorkspace, 'C:\\Users\\linqi\\Downloads\\de-ai-traces');
    assert.equal(healed.conversationMounted, true);
    assert.equal(healed.persistRecord?.mode, 'agent');

    // Unhydrated empty chat must NOT prematurely persist 'normal'
    const unhydrated = Session.resolveConversationSync({
      chatId: 'loadingChat',
      storedRecord: null,
      pendingNewChat: null,
      domState: { detected: 'empty', workspace: null },
      now: t0,
    });
    assert.equal(unhydrated.persistRecord, null);
    console.log('✓ 5b. Conversation session state machine & rich-formatted DOM detection verified');

    // 6. Manifest V3, Asset Integrity & Exact i18n Locale Coverage
    const extDir = path.join(rootDir, 'extension');
    const manifest = JSON.parse(fs.readFileSync(path.join(extDir, 'manifest.json'), 'utf8'));
    const bridgePkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
    assert.equal(manifest.manifest_version, 3);
    assert.equal(manifest.version, '1.0.0');
    assert.equal(bridgePkg.version, '1.0.0');
    assert.equal(manifest.default_locale, 'en');
    assert.equal(manifest.name, '__MSG_extName__');
    assert.equal(manifest.description, '__MSG_extDescription__');

    const assetPaths = [
      manifest.background.service_worker,
      manifest.action.default_popup,
      ...Object.values(manifest.icons),
      ...manifest.content_scripts.flatMap((cs) => [...(cs.js || []), ...(cs.css || [])]),
    ];
    for (const rel of assetPaths) {
      assert.ok(fs.existsSync(path.join(extDir, rel)), `Missing asset: ${rel}`);
    }

    const enLocale = JSON.parse(
      fs.readFileSync(path.join(extDir, '_locales', 'en', 'messages.json'), 'utf8')
    );
    const zhLocale = JSON.parse(
      fs.readFileSync(path.join(extDir, '_locales', 'zh_CN', 'messages.json'), 'utf8')
    );
    const enKeys = Object.keys(enLocale).sort();
    const zhKeys = Object.keys(zhLocale).sort();
    assert.deepEqual(enKeys, zhKeys, 'en and zh_CN locale key sets must match');
    for (const key of enKeys) {
      assert.ok(enLocale[key]?.message?.trim(), `Empty en message for key: ${key}`);
      assert.ok(zhLocale[key]?.message?.trim(), `Empty zh_CN message for key: ${key}`);
    }

    // Verify exact 1:1 correspondence between referenced i18n keys and locale files (no missing or dead keys)
    const referencedKeys = new Set();
    const scanFiles = ['manifest.json', 'background.js', 'content.js', 'popup.js', 'popup.html'];
    for (const file of scanFiles) {
      const src = fs.readFileSync(path.join(extDir, file), 'utf8');
      for (const re of [
        /\b(?:t|msg)\(\s*['"]([A-Za-z0-9_]+)['"]/g,
        /data-i18n(?:-(?:placeholder|title))?="([A-Za-z0-9_]+)"/g,
        /__MSG_([A-Za-z0-9_]+)__/g,
      ]) {
        let m;
        while ((m = re.exec(src))) {
          referencedKeys.add(m[1]);
        }
      }
    }
    assert.deepEqual(
      enKeys,
      [...referencedKeys].sort(),
      'Locale keys must match referenced i18n keys with zero missing or unused entries'
    );
    console.log(`✓ 6. Manifest V3, assets & exact i18n coverage (${referencedKeys.size} keys) verified`);

    console.log('\n🎉 ALL v1.0.0 TESTS PASSED!');
  } finally {
    server.close();
    await new Promise((r) => setTimeout(r, 250));
    fs.rmSync(tempBase, { recursive: true, force: true, maxRetries: 6, retryDelay: 120 });
  }
}

runTests().catch((err) => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
