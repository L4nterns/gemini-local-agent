import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function terminateChild(child) {
  try {
    if (process.platform === 'win32' && child.pid) {
      spawnSync('taskkill', ['/pid', String(child.pid), '/f', '/t'], {
        windowsHide: true,
        timeout: 5000,
      });
    } else {
      child.kill('SIGTERM');
    }
  } catch {
    // Ignore kill error
  }
}

function runDialogProcess(cmd, args, { env, signal, timeoutMs = 180_000 } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      resolve({ code: null, stdout: '', stderr: '', aborted: true });
      return;
    }

    const child = spawn(cmd, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: env || process.env,
    });

    const stdoutChunks = [];
    const stderrChunks = [];
    let finished = false;
    let aborted = false;

    const abortHandler = () => {
      if (finished) return;
      aborted = true;
      terminateChild(child);
    };

    const timer = setTimeout(abortHandler, timeoutMs);
    if (signal) {
      signal.addEventListener('abort', abortHandler, { once: true });
    }

    const cleanup = () => {
      finished = true;
      clearTimeout(timer);
      if (signal) {
        signal.removeEventListener('abort', abortHandler);
      }
    };

    child.stdout.on('data', (c) => stdoutChunks.push(c));
    child.stderr.on('data', (c) => stderrChunks.push(c));

    child.on('error', (err) => {
      cleanup();
      reject(err);
    });

    child.on('close', (code) => {
      cleanup();
      resolve({
        code,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
        aborted,
      });
    });
  });
}

/**
 * Open a native OS directory picker dialog and return the chosen folder path (or null if cancelled/aborted).
 */
export async function openNativeFolderDialog(initialPath = '', options = {}) {
  const { signal, timeoutMs = 180_000 } = options;
  const safeInitial =
    initialPath && fs.existsSync(initialPath) ? path.resolve(initialPath) : os.homedir();

  if (process.platform === 'win32') {
    // Pass initial directory via environment variable to avoid PowerShell string-quoting issues
    const psScript = [
      '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8;',
      'Add-Type -AssemblyName System.Windows.Forms;',
      '$owner = New-Object System.Windows.Forms.Form;',
      '$owner.TopMost = $true;',
      '$owner.StartPosition = "CenterScreen";',
      '$owner.Width = 1; $owner.Height = 1; $owner.ShowInTaskbar = $false;',
      '$dlg = New-Object System.Windows.Forms.FolderBrowserDialog;',
      '$dlg.Description = "Select a local workspace folder for Gemini Local Agent";',
      'if ($env:GLA_INITIAL_DIR) { $dlg.SelectedPath = $env:GLA_INITIAL_DIR }',
      '$dlg.ShowNewFolderButton = $true;',
      '$result = $dlg.ShowDialog($owner);',
      '$owner.Dispose();',
      'if ($result -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $dlg.SelectedPath }',
    ].join(' ');

    let res;
    try {
      res = await runDialogProcess('powershell.exe', ['-STA', '-NoProfile', '-Command', psScript], {
        env: { ...process.env, GLA_INITIAL_DIR: safeInitial },
        signal,
        timeoutMs,
      });
    } catch (err) {
      throw new Error(`Failed to open folder picker: ${err.message}`);
    }
    if (res.aborted) return null;
    const chosen = res.stdout.trim();
    if (res.code !== 0 && !chosen && res.stderr.trim()) {
      throw new Error(`Folder picker error: ${res.stderr.trim()}`);
    }
    return chosen || null;
  }

  if (process.platform === 'darwin') {
    const res = await runDialogProcess(
      'osascript',
      [
        '-e',
        'on run argv',
        '-e',
        'set initDir to POSIX file (item 1 of argv)',
        '-e',
        'POSIX path of (choose folder with prompt "Select a local workspace folder for Gemini Local Agent" default location initDir)',
        '-e',
        'end run',
        '--',
        safeInitial,
      ],
      { signal, timeoutMs }
    );
    if (res.aborted) return null;
    const chosen = res.stdout.trim();
    // macOS user cancel returns error -128
    if (res.code !== 0 && !chosen && res.stderr && !res.stderr.includes('-128')) {
      throw new Error(`Folder picker error: ${res.stderr.trim()}`);
    }
    return chosen || null;
  }

  // Linux: try zenity first, fall back to kdialog (KDE)
  const initialWithSlash = safeInitial.endsWith('/') ? safeInitial : `${safeInitial}/`;
  const runLinuxPicker = async (cmd, args) => {
    const res = await runDialogProcess(cmd, args, { signal, timeoutMs });
    if (res.aborted) return null;
    const chosen = res.stdout.trim();
    // Exit code 1 with empty stdout is standard user cancellation in zenity/kdialog
    if (res.code !== 0 && res.code !== 1 && !chosen) {
      throw new Error(`${cmd} exited with code ${res.code}: ${res.stderr.trim()}`);
    }
    return chosen || null;
  };

  try {
    return await runLinuxPicker('zenity', [
      '--file-selection',
      '--directory',
      '--title=Select Workspace Folder',
      `--filename=${initialWithSlash}`,
    ]);
  } catch {
    if (signal?.aborted) return null;
    try {
      return await runLinuxPicker('kdialog', ['--getexistingdirectory', safeInitial]);
    } catch {
      if (signal?.aborted) return null;
      throw new Error(
        'Neither zenity nor kdialog is installed (or no GUI display is available) to open a folder picker.'
      );
    }
  }
}
