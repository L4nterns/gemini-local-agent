# Gemini Local Agent

[English](README.md) | 简体中文

通过零依赖的本地 Node.js Bridge 与 Chrome Manifest V3 扩展，将 [Gemini Web](https://gemini.google.com) 变为直接连接本机工作区的本地编程 Agent。

## 环境要求

- **Node.js 18+**（仅使用内置模块，无需 `npm install`）
- **Chrome / Edge**（支持 Manifest V3 的 Chromium 内核浏览器）
- **操作系统**：Windows、macOS 或 Linux

## 快速开始

### 1. 启动本地 Bridge

```bash
node bridge/server.js
```

默认监听 `http://127.0.0.1:3847`。

### 2. 加载 Chrome 扩展

1. 打开 `chrome://extensions`，开启右上角 **开发者模式**。
2. 点击 **加载已解压的扩展程序**，选择本项目的 `extension/` 目录。
3. 打开 [gemini.google.com](https://gemini.google.com)。

首次连接时扩展会自动完成本机配对（TOFU）。点击 Gemini 页面右下角的悬浮胶囊，添加工作区即可开始使用。

## 会话隔离机制

每个 Gemini 会话按 URL 中的会话 ID 严格隔离：

- **新会话默认普通会话**：空白会话默认处于普通会话；发出首条消息前可在普通会话与已添加的工作区之间自由切换。
- **发出首条消息后锁定**：会话开始后绑定关系即锁定——普通会话保持纯净、不触发本地工具；Agent 会话始终绑定所属工作区，多标签页并行互不串扰。
- **状态指示灯**：悬浮胶囊状态灯（`🟢` 已连接 / `🟡` 工作区不可用 / `🔴` 未连接）独立反映服务与工作区健康状态，离线时仍保留会话绑定信息。

## 内置工具

- **只读探索**：`read_file`、`list_dir`、`find_files`、`grep_search`（检测到 `rg` 时自动走 ripgrep 加速，否则回退纯 Node 实现）
- **写入与执行**：`write_file`、`edit_file`（支持单处或原子多块替换及 Diff 预览）、`run_command`（单次有限时长命令，最长 120s）

## 审批模式

- **只读放行** *（默认）*：只读探索工具自动执行；写入与命令执行会在 Gemini 输入框上方弹出预览/Diff，确认后执行（直接回复输入框即可附带建议拒绝）。
- **自动执行**：自动放行常规读写与命令；内置防手滑安全带，对明显破坏性命令（如 `rm -rf`、`git reset --hard`、`git push --force`）仍强制弹出人工确认。

## 启动参数

```bash
node bridge/server.js [options]
```

| 参数 | 环境变量 | 说明 |
| --- | --- | --- |
| `--port <num>` | `LOCAL_AGENT_PORT` | 监听端口（默认 `3847`） |
| `--workspace <dir>` / `-w <dir>` | `LOCAL_AGENT_WORKSPACE` | 启动时预注册一个工作区目录 |
| `--reset-token` | — | 重新生成配对 Token |
| `--reset-pair` | — | 清除已配对的扩展 ID，允许重新自动配对 |
| `--allow-outside` | — | 仅在本次运行关闭工作区路径越界拦截 |

## 安全设计

- **仅监听本机回环**：强制绑定 `127.0.0.1` 并校验回环 `Host` 头以防 DNS 重绑定，扩展与服务端均拒绝非回环地址。
- **扩展源 TOFU 自动配对**：仅接受合法浏览器扩展源（`chrome-extension://` / `moz-extension://`）并锁定首个配对扩展 ID；未知扩展将被拒绝（`403`），需 `--reset-pair` 或手动填写配对 Token。
- **工作区白名单与符号链接沙箱**：每次工具调用都必须显式传入已授权且存在的 `workspace`，默认拦截路径穿越与符号链接/联接点逃逸（含悬空链接）。
- **脱敏审计日志**：保存在本地 `bridge/logs/`，按天轮转（保留 30 天）、前端连续展示，自动脱敏 Token 与常见密钥。

## 跨平台支持

- **系统原生目录选择器**：Windows 使用 WinForms、macOS 使用 AppleScript (`osascript`)、Linux 使用 `zenity`（自动回退 `kdialog`）。
- **命令执行**：Windows 使用 PowerShell（超时时 `taskkill /f /t`），macOS / Linux 使用 `$SHELL` 与 POSIX 进程组终止。
- **多语言界面**：扩展默认使用英文，当浏览器语言为简体中文时自动切换为简体中文。

## 目录结构

```text
.
├── bridge/
│   ├── package.json        # Node ESM 配置（零依赖）
│   ├── server.js           # 本地 HTTP Bridge 与 REST 接口
│   ├── tools.js            # 本地 Agent 工具执行与预览
│   ├── security.js         # 认证、TOFU 配对、工作区沙箱与 Diff
│   ├── folder-picker.js    # 跨平台原生目录选择器
│   ├── logger.js           # 脱敏 JSONL 审计日志
│   └── test-bridge.mjs     # 自动化集成与完整性测试
└── extension/
    ├── manifest.json       # Chrome Manifest V3
    ├── _locales/           # 国际化文案（en, zh_CN）
    ├── i18n.js             # 多语言工具模块
    ├── background.js       # Service Worker 与 Bridge 通信
    ├── content.js          # Gemini 页面集成、悬浮胶囊与控制台
    ├── styles.css          # 页面内 UI 样式
    ├── tool-parser.js      # 结构化工具调用解析器
    ├── session-state.js    # 会话隔离与 DOM 状态机
    ├── prompt-template.js  # Agent 系统提示词与结果格式化
    ├── popup.html/css/js   # 扩展弹框（工作区管理与连接设置）
    └── icons/              # 扩展图标
```

## 运行测试

```bash
node bridge/test-bridge.mjs
```

## 开源协议

[MIT](LICENSE)
