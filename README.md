<p align="center">
  <img src="logo.svg" width="120" alt="4RouterAi Logo">
</p>

<h1 align="center">4RouterAi</h1>

<p align="center">
  <strong>一键式多Agent编程助手</strong><br>
  Claude Code & Codex CLI，开箱即用
</p>

<p align="center">
  <img src="https://img.shields.io/badge/platform-Windows-blue?style=flat-square" alt="Platform">
  <img src="https://img.shields.io/badge/electron-33-47848f?style=flat-square&logo=electron" alt="Electron">
  <img src="https://img.shields.io/badge/license-MIT-green?style=flat-square" alt="License">
</p>

---

## ✨ 简介

**4RouterAi** 是一个开箱即用的多Agent桌面应用，将 [Claude Code](https://docs.anthropic.com/en/docs/claude-code) (Anthropic) 和 [Codex CLI](https://github.com/openai/codex) (OpenAI) 两大 AI 编程工具整合到一个统一的界面中。无需复杂的环境配置，开箱即用。

## 🎯 核心特性

### 🔧 双工具集成
- **Claude Code** — Anthropic 的 AI 编程助手，支持自定义 Base URL 和模型选择
- **Codex CLI** — OpenAI 的命令行编程代理，支持 Reasoning Effort 和 Verbosity 调节

### 💻 快捷终端
- 基于 [xterm.js](https://xtermjs.org/) 的全功能终端模拟器
- **多标签页管理** — 同时运行多个 AI 工具和终端会话，自由切换
- 内置 **复制/粘贴** 工具栏，支持 `Ctrl+C` / `Ctrl+V` 快捷键

### 📦 零配置运行环境
- **内置 Node.js 运行时** — 无需全局安装 Node.js
- **内置 MinGit** — Claude Code 运行所需的 Git 环境自动配置（Windows）
- **自动检测更新** — 启动时非阻塞检查 CLI 工具新版本，一键更新

### 📁 文件浏览器
- 侧边面板内置文件树浏览器
- 自动跟随当前活动标签页的工作目录
- 支持展开/折叠目录结构

---

## 📥 安装

### 方式一：下载安装包（推荐）

前往 [Releases](../../releases) 页面下载最新的 `.exe` 安装包，双击运行安装即可。

---

## 🚀 快速开始

### 1. 首次启动 — 配置 API Key

首次启动应用时，你会看到欢迎页面。在此输入你的 API Key 和Base URL

> 💡 **提示**：你也可以点击「跳过设置」稍后在设置页面中配置。

### 2. 选择工作目录(可选)

在侧栏的「工作目录」区域点击 📁 按钮，选择你的项目文件夹。所有 AI 工具和终端都将在此目录下运行。

### 3. 启动工具

在侧栏点击对应的工具按钮即可启动：

- 🟣 **Claude Code** — 启动 Anthropic 的 AI 编程助手
- 🟢 **Codex CLI** — 启动 OpenAI 的命令行代理
- ⬛ **Terminal** — 启动一个普通的 PowerShell 终端

每点击一次都会创建一个新的标签页，你可以同时运行多个会话。

### 4. 在线更新工具

侧栏中的 badge 会显示工具当前版本号。如果检测到新版本，badge 会变为 **「点击更新」** — 直接点击即可一键更新至最新版，无需重新下载安装包。

---

## ⚙️ 设置

点击侧栏底部的 ⚙️ **设置** 按钮打开设置面板，可配置：

| 设置项               | 说明                                                     |
| -------------------- | -------------------------------------------------------- |
| **API Key**          | Anthropic / OpenAI 的 API 密钥                           |
| **Base URL**         | 自定义 API 端点（支持中转代理）                          |
| **Model**            | 自定义模型名称（如 `opus`、`gpt-5.3-codex`）             |
| **Reasoning Effort** | Codex 的推理力度（如 `xhigh`）                           |
| **Verbosity**        | Codex 的输出详细程度（如 `high`）                        |
| **HTTP(S) 代理**     | 代理地址（如 `http://127.0.0.1:7890`）                   |
| **主题**             | Dark / Light / Fruit                                     |
| **终端字体大小**     | 终端显示字号（默认 14）                                  |
| **终端字体**         | 终端字体族（默认 `JetBrains Mono, Consolas, monospace`） |

> 设置底部还有 **调试信息 — 启动参数预览**，可查看工具实际执行的命令和环境变量。 
> 更改设置后需要打开新的终端标签页才能生效。

---

## 🛠️ 开发

```bash
# 安装依赖
npm install
# 启动开发模式（同时启动 main 进程编译和 Vite 开发服务器）
npm run dev
# 在另一个终端中启动 Electron
npm start
```

### 项目结构

```
4RouterApp/
├── src/
│   ├── main/                   # Electron 主进程
│   │   ├── index.ts            # 主入口，窗口创建和 IPC 注册
│   │   ├── tool-manager.ts     # 工具发现、启动配置和更新管理
│   │   ├── pty-manager.ts      # PTY 终端会话管理（node-pty）
│   │   ├── config-store.ts     # 配置存储与 API Key 加密
│   │   ├── preload.ts          # IPC 桥接，暴露安全 API 给渲染进程
│   │   └── process-env.ts      # 环境变量白名单过滤
│   └── renderer/               # 渲染进程（前端 UI）
│       ├── index.html          # 主页面
│       ├── app.js              # 应用逻辑
│       └── styles/global.css   # 全局样式
├── scripts/
│   ├── bundle-tools.mjs        # 打包工具脚本（下载 CLI 和运行时）
│   └── build*.bat / build.ps1  # 构建脚本
├── resources/
│   ├── bundled-tools/          # 内置的 CLI 工具和运行时
│   └── icon.ico                # 应用图标
├── vite.config.ts              # Vite 构建配置
└── package.json                # 项目配置
```
---

## 📝 许可证

[MIT License](LICENSE)

---

<p align="center">
  <sub>Made with ⚡ by 4RouterAi</sub>
</p>
