import { app, BrowserWindow, clipboard, ipcMain, safeStorage, shell } from 'electron';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PtyManager } from './pty-manager';
import { ToolManager } from './tool-manager';
import { ConfigStore } from './config-store';
import { AppUpdater } from './app-updater';
import { AuthManager } from './auth-manager';
import { KeyProvisioner } from './key-provisioner';

let mainWindow: BrowserWindow | null = null;
let ptyManager: PtyManager;
let toolManager: ToolManager;
let configStore: ConfigStore;
let appUpdater: AppUpdater;
let authManager: AuthManager;
let keyProvisioner: KeyProvisioner;

function getResourcesPath(): string {
    if (app.isPackaged) {
        return path.join(process.resourcesPath, 'bundled-tools');
    }
    return path.join(__dirname, '..', '..', 'resources', 'bundled-tools');
}

function createWindow(): void {
    mainWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        minWidth: 800,
        minHeight: 600,
        title: '4RouterAi',
        backgroundColor: '#0d1117',
        frame: false,
        titleBarStyle: 'hidden',
        titleBarOverlay: {
            color: '#0d1117',
            symbolColor: '#c9d1d9',
            height: 38,
        },
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: false, // Required for node-pty IPC
            webviewTag: true, // Embedded 4Router login uses <webview>
        },
        icon: path.join(__dirname, '..', '..', 'resources', 'icon.ico'),
    });

    // Load renderer — dev mode loads the Vite server (HMR). Enable it with
    // `npm run start:dev` (passes --dev) or by setting NODE_ENV=development;
    // otherwise the built bundle in dist/renderer is loaded.
    const isDev = process.env.NODE_ENV === 'development' || process.argv.includes('--dev');
    if (isDev) {
        mainWindow.loadURL('http://localhost:5173');
        mainWindow.webContents.openDevTools({ mode: 'detach' });
    } else {
        mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
    }

    mainWindow.on('closed', () => {
        mainWindow = null;
    });

    // Open links in default browser
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        shell.openExternal(url);
        return { action: 'deny' };
    });
}

function setupIPC(): void {
    // ===== Tool Management =====
    ipcMain.handle('tools:list', () => {
        return toolManager.listTools();
    });

    ipcMain.handle('tools:get-status', (_event, toolId: string) => {
        return toolManager.getToolStatus(toolId);
    });

    ipcMain.handle('tools:update', async (_event, toolId: string) => {
        return toolManager.updateTool(toolId);
    });

    ipcMain.handle('tools:get-launch-preview', (_event, toolId: string) => {
        return toolManager.getLaunchConfig(toolId);
    });

    ipcMain.handle('tools:check-update', async (_event, toolId: string) => {
        return toolManager.checkUpdate(toolId);
    });

    // ===== PTY Management =====
    ipcMain.handle('pty:create', (_event, toolId: string, cwd?: string) => {
        const sessionId = ptyManager.createSession(toolId, cwd);
        return sessionId;
    });

    ipcMain.on('pty:write', (_event, sessionId: string, data: string) => {
        ptyManager.write(sessionId, data);
    });

    ipcMain.on('pty:resize', (_event, sessionId: string, cols: number, rows: number) => {
        ptyManager.resize(sessionId, cols, rows);
    });

    ipcMain.handle('pty:destroy', (_event, sessionId: string) => {
        ptyManager.destroySession(sessionId);
    });

    // ===== Window Titlebar Overlay =====
    ipcMain.handle('window:set-titlebar-overlay', (_event, colors: { color: string; symbolColor: string }) => {
        if (mainWindow) {
            mainWindow.setTitleBarOverlay({
                color: colors.color,
                symbolColor: colors.symbolColor,
                height: 38,
            });
        }
    });

    // ===== Config Management =====
    ipcMain.handle('config:get', (_event, key: string) => {
        return configStore.get(key);
    });

    ipcMain.handle('config:set', (_event, key: string, value: any) => {
        configStore.set(key, value);
    });

    ipcMain.handle('config:get-api-key', (_event, provider: string) => {
        return configStore.getApiKey(provider);
    });

    ipcMain.handle('config:set-api-key', (_event, provider: string, key: string) => {
        configStore.setApiKey(provider, key);
    });

    ipcMain.handle('config:has-api-key', (_event, provider: string) => {
        return configStore.hasApiKey(provider);
    });

    ipcMain.handle('config:get-base-url', (_event, provider: string) => {
        return configStore.getBaseUrl(provider);
    });

    ipcMain.handle('config:set-base-url', (_event, provider: string, url: string) => {
        configStore.setBaseUrl(provider, url);
    });

    ipcMain.handle('config:get-model', (_event, provider: string) => {
        return configStore.getModel(provider);
    });

    ipcMain.handle('config:set-model', (_event, provider: string, model: string) => {
        configStore.setModel(provider, model);
    });

    // ===== Window Controls =====
    ipcMain.on('window:minimize', () => mainWindow?.minimize());
    ipcMain.on('window:maximize', () => {
        if (mainWindow?.isMaximized()) {
            mainWindow.unmaximize();
        } else {
            mainWindow?.maximize();
        }
    });
    ipcMain.on('window:close', () => mainWindow?.close());

    // ===== App Info =====
    ipcMain.handle('app:get-version', () => app.getVersion());
    ipcMain.handle('app:is-encryption-available', () => safeStorage.isEncryptionAvailable());

    // ===== App Update =====
    ipcMain.handle('app:check-app-update', async () => {
        return appUpdater.checkForUpdate();
    });

    ipcMain.handle('app:download-update', async (_event, downloadUrl: string) => {
        return appUpdater.downloadUpdate(downloadUrl);
    });

    // ===== Reset to defaults =====
    // Wipes API keys, base URLs, models, preferences AND the 4Router auth
    // session, then asks the renderer to reload back to the welcome screen.
    ipcMain.handle('app:reset-all', async () => {
        try {
            ptyManager.destroyAll();
            await authManager.clearSession();
            configStore.resetAll();
            return { success: true };
        } catch (err: any) {
            return { success: false, error: String(err?.message || err) };
        }
    });

    // ===== Remote Config Sync =====
    ipcMain.handle('app:check-remote-config', async () => {
        return appUpdater.checkRemoteConfig();
    });

    ipcMain.handle('app:apply-remote-config', async (_event, remoteConfig: Record<string, any>) => {
        appUpdater.applyRemoteConfig(remoteConfig);
        return { success: true };
    });

    // ===== Auth (Module 1) =====
    // Renderer drives login via an in-page <webview>; this handler polls the
    // shared `auth-4router` session to detect a logged-in cookie state and
    // mint an accessToken.
    ipcMain.handle('auth:check-login-status', async () => {
        return authManager.checkLoginStatus();
    });

    ipcMain.handle('auth:is-logged-in', () => {
        return authManager.isLoggedIn();
    });

    ipcMain.handle('auth:logout', () => {
        authManager.logout();
    });

    // ===== Key Provisioning (Module 2) =====
    ipcMain.handle('provision:create-keys', async () => {
        const accessToken = authManager.getAccessToken();
        if (!accessToken) return { success: false, error: '未登录 4Router' };

        const result = await keyProvisioner.provisionKeys(accessToken);
        if (result.success) {
            // Auto-configure API keys and base URLs in ConfigStore
            if (result.claudeKey) {
                configStore.setApiKey('anthropic', result.claudeKey);
                configStore.setBaseUrl('anthropic', 'https://4router.net');
            }
            if (result.codexKey) {
                configStore.setApiKey('openai', result.codexKey);
                configStore.setBaseUrl('openai', 'https://4router.net/v1');
            }
        }
        return result;
    });

    // ===== Dialog =====
    ipcMain.handle('dialog:select-directory', async () => {
        const { dialog } = require('electron');
        const result = await dialog.showOpenDialog(mainWindow!, {
            properties: ['openDirectory'],
        });
        return result.canceled ? null : result.filePaths[0];
    });

    // ===== File System =====
    ipcMain.handle('fs:read-dir', async (_event, dirPath: string) => {
        const fs = require('fs') as typeof import('fs');
        const nodePath = require('path') as typeof import('path');
        try {
            const entries = fs.readdirSync(dirPath, { withFileTypes: true });
            return entries
                .filter(e => !e.name.startsWith('.'))
                .map(e => ({
                    name: e.name,
                    path: nodePath.join(dirPath, e.name),
                    isDirectory: e.isDirectory(),
                }))
                .sort((a, b) => {
                    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
                    return a.name.localeCompare(b.name);
                });
        } catch {
            return [];
        }
    });

    // ===== Clipboard =====
    // Read an image from the OS clipboard, write it to a temp .png file,
    // and return the path. Returns null when the clipboard has no image.
    ipcMain.handle('clipboard:read-image', async () => {
        try {
            const image = clipboard.readImage();
            if (image.isEmpty()) return null;
            const buf = image.toPNG();
            if (!buf || buf.length === 0) return null;

            const dir = path.join(os.tmpdir(), '4routerai-paste');
            fs.mkdirSync(dir, { recursive: true });
            const filename = `clip-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`;
            const filePath = path.join(dir, filename);
            fs.writeFileSync(filePath, buf);
            return filePath;
        } catch (err) {
            console.error('[clipboard:read-image] failed:', err);
            return null;
        }
    });
}

app.whenReady().then(() => {
    const bundledToolsPath = getResourcesPath();

    configStore = new ConfigStore();
    toolManager = new ToolManager(bundledToolsPath, configStore);
    ptyManager = new PtyManager(toolManager);
    appUpdater = new AppUpdater(configStore);
    authManager = new AuthManager(configStore);
    keyProvisioner = new KeyProvisioner();

    // Forward PTY data to renderer
    ptyManager.onData((sessionId: string, data: string) => {
        mainWindow?.webContents.send('pty:data', sessionId, data);
    });

    ptyManager.onExit((sessionId: string, exitCode: number) => {
        mainWindow?.webContents.send('pty:exit', sessionId, exitCode);
    });

    setupIPC();
    createWindow();

    // Set mainWindow reference for app updater progress events
    appUpdater.setMainWindow(mainWindow);
});

app.on('window-all-closed', () => {
    ptyManager?.destroyAll();
    app.quit();
});

app.on('activate', () => {
    if (mainWindow === null) {
        createWindow();
    }
});
