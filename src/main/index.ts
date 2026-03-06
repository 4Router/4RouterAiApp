import { app, BrowserWindow, ipcMain, safeStorage, shell } from 'electron';
import * as path from 'path';
import { PtyManager } from './pty-manager';
import { ToolManager } from './tool-manager';
import { ConfigStore } from './config-store';
import { AppUpdater } from './app-updater';

let mainWindow: BrowserWindow | null = null;
let ptyManager: PtyManager;
let toolManager: ToolManager;
let configStore: ConfigStore;
let appUpdater: AppUpdater;

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
        },
        icon: path.join(__dirname, '..', '..', 'resources', 'icon.ico'),
    });

    // Load renderer
    if (process.env.NODE_ENV === 'development') {
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

    // ===== Remote Config Sync =====
    ipcMain.handle('app:check-remote-config', async () => {
        return appUpdater.checkRemoteConfig();
    });

    ipcMain.handle('app:apply-remote-config', async (_event, remoteConfig: Record<string, any>) => {
        appUpdater.applyRemoteConfig(remoteConfig);
        return { success: true };
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
}

app.whenReady().then(() => {
    const bundledToolsPath = getResourcesPath();

    configStore = new ConfigStore();
    toolManager = new ToolManager(bundledToolsPath, configStore);
    ptyManager = new PtyManager(toolManager);
    appUpdater = new AppUpdater(configStore);

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
