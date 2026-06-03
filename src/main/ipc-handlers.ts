import { BrowserWindow, clipboard, dialog, safeStorage, shell } from 'electron';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PtyManager } from './pty-manager';
import { ToolManager } from './tool-manager';
import { ConfigStore } from './config-store';
import { AppUpdater } from './app-updater';
import { AuthManager } from './auth-manager';
import { KeyProvisioner } from './key-provisioner';

/**
 * Everything the request handlers need from the main process. Passed in so the
 * same handler table can be driven by either Electron IPC (local window) or the
 * WebSocket bridge (remote browser) without duplicating logic.
 */
export interface HandlerDeps {
    getMainWindow: () => BrowserWindow | null;
    getAppVersion: () => string;
    ptyManager: PtyManager;
    toolManager: ToolManager;
    configStore: ConfigStore;
    appUpdater: AppUpdater;
    authManager: AuthManager;
    keyProvisioner: KeyProvisioner;
    /** Controls the remote web bridge (start/stop + status) for the settings UI. */
    webController: {
        getStatus: () => Record<string, any>;
        apply: (cfg: { enabled: boolean; port: number; allowLan: boolean; token: string }) => Promise<Record<string, any>>;
    };
}

/**
 * A flat registry of request handlers, keyed by the same channel strings the
 * renderer uses through `window.routerAi`.
 *
 * - `invoke` channels are request/response (Electron `ipcMain.handle`).
 * - `send` channels are fire-and-forget (Electron `ipcMain.on`).
 */
export interface HandlerRegistry {
    invoke: Record<string, (...args: any[]) => any>;
    send: Record<string, (...args: any[]) => void>;
}

export function createHandlers(deps: HandlerDeps): HandlerRegistry {
    const {
        getMainWindow,
        getAppVersion,
        ptyManager,
        toolManager,
        configStore,
        appUpdater,
        authManager,
        keyProvisioner,
        webController,
    } = deps;

    const invoke: HandlerRegistry['invoke'] = {
        // ===== Tool Management =====
        'tools:list': () => toolManager.listTools(),
        'tools:get-status': (toolId: string) => toolManager.getToolStatus(toolId),
        'tools:update': (toolId: string) => toolManager.updateTool(toolId),
        'tools:get-launch-preview': (toolId: string) => toolManager.getLaunchConfig(toolId),
        'tools:check-update': (toolId: string) => toolManager.checkUpdate(toolId),

        // ===== PTY Management =====
        'pty:create': (toolId: string, cwd?: string) => ptyManager.createSession(toolId, cwd),
        'pty:destroy': (sessionId: string) => ptyManager.destroySession(sessionId),
        // Shared-session sync: list live sessions and replay a session's scrollback.
        'pty:list': () => ptyManager.listSessions(),
        'pty:attach': (sessionId: string) => ptyManager.getBuffer(sessionId),

        // ===== Window Titlebar Overlay =====
        'window:set-titlebar-overlay': (colors: { color: string; symbolColor: string }) => {
            const win = getMainWindow();
            if (win) {
                win.setTitleBarOverlay({ color: colors.color, symbolColor: colors.symbolColor, height: 38 });
            }
        },

        // ===== Config Management =====
        'config:get': (key: string) => configStore.get(key),
        'config:set': (key: string, value: any) => configStore.set(key, value),
        'config:get-api-key': (provider: string) => configStore.getApiKey(provider),
        'config:set-api-key': (provider: string, key: string) => configStore.setApiKey(provider, key),
        'config:has-api-key': (provider: string) => configStore.hasApiKey(provider),
        'config:get-base-url': (provider: string) => configStore.getBaseUrl(provider),
        'config:set-base-url': (provider: string, url: string) => configStore.setBaseUrl(provider, url),
        'config:get-model': (provider: string) => configStore.getModel(provider),
        'config:set-model': (provider: string, model: string) => configStore.setModel(provider, model),

        // ===== Remote Web Access =====
        'web:get-status': () => webController.getStatus(),
        'web:apply': (cfg: { enabled: boolean; port: number; allowLan: boolean; token: string }) =>
            webController.apply(cfg),

        // ===== App Info =====
        'app:get-version': () => getAppVersion(),
        'app:is-encryption-available': () => safeStorage.isEncryptionAvailable(),

        // ===== App Update =====
        'app:check-app-update': async () => appUpdater.checkForUpdate(),
        'app:download-update': async (downloadUrl: string) => appUpdater.downloadUpdate(downloadUrl),

        // ===== Reset to defaults =====
        'app:reset-all': async () => {
            try {
                ptyManager.destroyAll();
                await authManager.clearSession();
                configStore.resetAll();
                return { success: true };
            } catch (err: any) {
                return { success: false, error: String(err?.message || err) };
            }
        },

        // ===== Remote Config Sync =====
        'app:check-remote-config': async () => appUpdater.checkRemoteConfig(),
        'app:apply-remote-config': async (remoteConfig: Record<string, any>) => {
            appUpdater.applyRemoteConfig(remoteConfig);
            return { success: true };
        },

        // ===== Auth =====
        'auth:check-login-status': async () => authManager.checkLoginStatus(),
        'auth:is-logged-in': () => authManager.isLoggedIn(),
        'auth:logout': () => authManager.logout(),

        // ===== Key Provisioning =====
        'provision:create-keys': async () => {
            const accessToken = authManager.getAccessToken();
            if (!accessToken) return { success: false, error: '未登录 4Router' };

            const result = await keyProvisioner.provisionKeys(accessToken);
            if (result.success) {
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
        },

        // ===== Dialog =====
        // Note: this opens a native picker on the HOST machine. For a remote
        // browser the host user picks the directory; acceptable for now.
        'dialog:select-directory': async () => {
            const win = getMainWindow();
            const result = await dialog.showOpenDialog(win!, { properties: ['openDirectory'] });
            return result.canceled ? null : result.filePaths[0];
        },

        // ===== File System =====
        'fs:read-dir': async (dirPath: string) => {
            try {
                const entries = fs.readdirSync(dirPath, { withFileTypes: true });
                return entries
                    .filter(e => !e.name.startsWith('.'))
                    .map(e => ({
                        name: e.name,
                        path: path.join(dirPath, e.name),
                        isDirectory: e.isDirectory(),
                    }))
                    .sort((a, b) => {
                        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
                        return a.name.localeCompare(b.name);
                    });
            } catch {
                return [];
            }
        },

        // ===== Clipboard =====
        // Reads the HOST clipboard, writes a temp .png, returns its path.
        'clipboard:read-image': async () => {
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
        },
    };

    const send: HandlerRegistry['send'] = {
        // ===== PTY I/O =====
        'pty:write': (sessionId: string, data: string) => ptyManager.write(sessionId, data),
        'pty:resize': (sessionId: string, cols: number, rows: number) =>
            ptyManager.resize(sessionId, cols, rows),

        // ===== Window Controls =====
        // These act on the host Electron window. The web client hides its own
        // titlebar, so remote calls here are effectively unused.
        'window:minimize': () => getMainWindow()?.minimize(),
        'window:maximize': () => {
            const win = getMainWindow();
            if (win?.isMaximized()) win.unmaximize();
            else win?.maximize();
        },
        'window:close': () => getMainWindow()?.close(),
    };

    return { invoke, send };
}
