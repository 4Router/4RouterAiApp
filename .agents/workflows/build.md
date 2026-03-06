---
description: 4RouterAi 项目编译和打包流程
---

# 4RouterAi 编译打包流程

项目路径: `c:\Users\W1NDe\Documents\GitHub\4RouterApp`

## 前置条件

- Node.js 已安装
- 依赖已安装 (`npm install --ignore-scripts` 然后手动 `node node_modules/electron/install.js` 和 `node node_modules/node-pty/scripts/post-install.js`)

## 编译步骤

### 1. 编译 TypeScript 主进程

// turbo
```
npx tsc -p tsconfig.main.json
```

输出到 `dist/main/`（5 个 JS 模块: index.js, config-store.js, tool-manager.js, pty-manager.js, preload.js）

### 2. 编译 Vite 渲染进程

// turbo
```
npx vite build
```

输出到 `dist/renderer/`（index.html + assets/）

### 3. 打包 EXE 安装包

**关键注意事项:**
- 必须先杀掉所有 Electron/4RouterAi 进程（否则 rcedit 会失败: "Unable to commit changes"）
- 必须清除旧的 release 目录
- 必须加 `--config.win.requestedExecutionLevel=asInvoker`（否则 rcedit 也会失败）
- 必须在清除 release 目录后等待 2-3 秒再开始构建
- 打包命令会自动执行步骤 1 和 2，所以可以直接从这步开始

```powershell
Get-Process -Name "electron","4RouterAi" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep 3
Remove-Item -Recurse -Force release -ErrorAction SilentlyContinue
Start-Sleep 2
npm run package 2>&1
```

其中 `npm run package` 等价于 `npm run build && electron-builder --win`。

如果 `npm run package` 失败（rcedit 报错），拆开执行:

// turbo
```
npm run build
```

然后:

```
npx electron-builder --win nsis --config.win.requestedExecutionLevel=asInvoker
```

### 4. 输出

- `release/4RouterAi Setup 1.0.0.exe` — NSIS 安装程序 (~137MB)
- `release/win-unpacked/` — 免安装版本

## 仅开发测试（不打包）

如果只需要快速测试代码修改:

// turbo
```
npx tsc -p tsconfig.main.json
```

// turbo
```
npx vite build
```

```
npx electron .
```

## 预打包 CLI 工具（仅首次需要）

```
npm run bundle-tools
```

将 Claude Code 和 Codex CLI 安装到 `resources/bundled-tools/`。

## package.json 中的 scripts 对照

| 命令                     | 实际执行                          |
| ------------------------ | --------------------------------- |
| `npm run build:main`     | `tsc -p tsconfig.main.json`       |
| `npm run build:renderer` | `vite build`                      |
| `npm run build`          | `build:main && build:renderer`    |
| `npm run package`        | `build && electron-builder --win` |
| `npm run bundle-tools`   | `node scripts/bundle-tools.mjs`   |
| `npm start`              | `electron .`                      |