(function (global) {
  function fenceFor(text) {
    const str = String(text ?? '');
    let n = 3;
    while (str.includes('`'.repeat(n))) n++;
    return '`'.repeat(n);
  }

  function buildSystemPrompt(envInfo, userTask) {
    if (!envInfo?.workspace) {
      throw new Error('buildSystemPrompt requires envInfo.workspace');
    }
    const workspaceLine = [
      `- Workspace: ${envInfo.workspace}`,
      `- OS: ${envInfo.os || 'unknown'}`,
      `- Shell: ${envInfo.shell || 'unknown'}`,
      envInfo.git?.branch ? `- Git Branch: ${envInfo.git.branch}` : null,
    ]
      .filter(Boolean)
      .join('\n');

    const treeSection =
      envInfo?.treePreview && envInfo.treePreview.length > 0
        ? `\nWorkspace tree preview:\n\`\`\`\n${envInfo.treePreview.slice(0, 60).join('\n')}${
            envInfo.treeTruncated || envInfo.treePreview.length > 60
              ? '\n... (use list_dir or find_files to inspect more)'
              : ''
          }\n\`\`\`\n`
        : '';

    const taskSection =
      userTask && userTask.trim()
        ? `\n---\nUser request:\n${userTask.trim()}`
        : '';

    return `[LOCAL_AGENT_SYSTEM_PROMPT]
You are operating as a local software engineering agent connected to the user's machine via Gemini Local Agent.
All file paths are resolved relative to the bound workspace root unless specified otherwise.

## Environment
${workspaceLine}
${treeSection}
## Available Tools
1. \`list_dir\` — \`{ "path": ".", "max_depth": 2, "include_hidden": false }\` — List directory entries.
2. \`find_files\` — \`{ "pattern": "*.ts", "path": ".", "max_depth": 10 }\` — Find files matching a glob pattern.
3. \`grep_search\` — \`{ "query": "text", "path": ".", "is_regex": false, "case_sensitive": false, "file_pattern": "*.js", "context_lines": 0, "files_only": false, "max_results": 80 }\` — Search text or regex across files (supports \`context_lines\` up to 5 and \`files_only\` mode).
4. \`read_file\` — \`{ "path": "src/app.js", "start_line": 1, "end_line": 200 }\` — Read numbered lines of a text file.
5. \`write_file\` — \`{ "path": "src/new.js", "content": "..." }\` — Create or overwrite a file (auto-creates parent directories).
6. \`edit_file\` — \`{ "path": "src/app.js", "target": "exact old text", "replacement": "new text", "replace_all": false }\` OR atomic multi-hunk \`{ "path": "src/app.js", "edits": [{ "target": "...", "replacement": "..." }] }\` — Perform exact surgical replacement(s) in an existing file.
7. \`run_command\` — \`{ "command": "npm test", "cwd": ".", "timeout_ms": 30000 }\` — Run a finite shell command (max 120000ms) for tests, builds, git, file management, or scripts; returns exitCode, stdout, and stderr.

## Tool Call Protocol (Strict)
Whenever you need to inspect or modify the local environment, end your message with **exactly one** \`json\` fenced code block containing \`"$local_agent": true\` and a \`"calls"\` array:

\`\`\`json
{
  "$local_agent": true,
  "calls": [
    {
      "tool": "read_file",
      "args": {
        "path": "package.json"
      }
    }
  ]
}
\`\`\`

## Operating Rules
1. **Stop immediately after emitting a tool block**: Wait for the \`[LOCAL_AGENT_TOOL_RESULT]\` message before continuing. Never fabricate file contents, diffs, or command outputs.
2. **Read before modifying**: Inspect relevant files with \`read_file\` / \`grep_search\` first. Prefer \`edit_file\` for targeted changes rather than rewriting entire files.
3. **Batch independent reads**: Combine multiple read-only calls in a single \`calls\` array to reduce round-trips.
4. **Finite shell commands only**: Use \`run_command\` for finite commands (tests, builds, linters, git). Avoid starting long-running servers or blocking watchers that never exit.
5. **Verify your work**: After making edits, run relevant tests, type checks, or builds to confirm correctness.
6. **Respect rejections and errors**: If the user rejects an action or a tool fails, incorporate their feedback or error details before retrying.
7. **Final response**: When the task is complete (or when asking the user for clarification), reply concisely in the user's language **without** any \`"$local_agent": true\` JSON block.
${taskSection}`;
  }

  function formatToolResults(entries, queuedMessages = []) {
    const blocks = entries.map((entry, idx) => {
      const header = `### [${idx + 1}] ${entry.tool} — ${entry.status}`;
      if (entry.rejected) {
        return `${header}\nThe user rejected this action.${
          entry.reason
            ? `\nUser feedback: ${entry.reason}\nAdjust your plan accordingly.`
            : ' Adjust your approach or ask the user how to proceed.'
        }`;
      }
      if (!entry.ok) {
        return `${header}\nError: ${entry.error || 'Unknown error'}`;
      }

      const data = entry.data || {};
      if (entry.tool === 'read_file' && typeof data.content === 'string') {
        const meta = `File: ${data.path} (lines ${data.startLine}-${data.endLine} of ${data.totalLines}${
          data.truncated ? ', truncated' : ''
        })`;
        const f = fenceFor(data.content);
        return `${header}\n${meta}\n${f}\n${data.content}\n${f}`;
      }

      if (entry.tool === 'run_command') {
        const parts = [
          header,
          `Command: \`${data.command}\` (cwd: \`${data.cwd}\`, duration: ${data.durationMs}ms, exitCode: ${data.exitCode})`,
        ];
        if (data.stdout) {
          const fOut = fenceFor(data.stdout);
          parts.push(`STDOUT:\n${fOut}\n${data.stdout}\n${fOut}`);
        }
        if (data.stderr) {
          const fErr = fenceFor(data.stderr);
          parts.push(`STDERR:\n${fErr}\n${data.stderr}\n${fErr}`);
        }
        if (!data.stdout && !data.stderr) parts.push('(no output)');
        return parts.join('\n');
      }

      if ((entry.tool === 'edit_file' || entry.tool === 'write_file') && data.diff) {
        const f = fenceFor(data.diff);
        return `${header}\nFile: ${data.path}\n${f}diff\n${data.diff}\n${f}`;
      }

      const serialized = JSON.stringify(data, null, 2);
      const clipped =
        serialized.length > 16000
          ? `${serialized.slice(0, 16000)}\n... [JSON truncated]`
          : serialized;
      const f = fenceFor(clipped);
      return `${header}\n${f}json\n${clipped}\n${f}`;
    });

    const followUps = Array.isArray(queuedMessages)
      ? queuedMessages.map((m) => String(m || '').trim()).filter(Boolean)
      : [];
    const followUpSection =
      followUps.length > 0
        ? `\n\n---\n[USER_FOLLOW_UP]\nAdditional user message(s) queued while tools were executing:\n${followUps
            .map((m, i) => (followUps.length > 1 ? `${i + 1}. ${m}` : m))
            .join('\n')}\n\nIncorporate the user's message(s) above in your next step.`
        : '';

    return `[LOCAL_AGENT_TOOL_RESULT]\nLocal tool execution results:\n\n${blocks.join('\n\n')}${followUpSection}`;
  }

  const api = { buildSystemPrompt, formatToolResults };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    global.LocalAgentPrompt = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : window);
