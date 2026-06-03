import { app, BrowserWindow, ipcMain, shell } from 'electron';
import * as os from 'os';
import * as path from 'path';
import { PtyManager } from './pty-manager';
import { ToolManager } from './tool-manager';
import { ConfigStore } from './config-store';
import { AppUpdater } from './app-updater';
import { AuthManager } from './auth-manager';
import { KeyProvisioner } from './key-provisioner';
import { createHandlers } from './ipc-handlers';
import { WebBridge } from './web-server';

let mainWindow: BrowserWindow | null = null;
let ptyManager: PtyManager;
let toolManager: ToolManager;
let configStore: ConfigStore;
let appUpdater: AppUpdater;
let authManager: AuthManager;
let keyProvisioner: KeyProvisioner;
let webBridge: WebBridge | null = null;

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

/**
 * Build the shared handler table and register every channel with Electron IPC.
 * The same table is also handed to the WebBridge so remote browsers hit
 * identical logic. Returns the registry for the bridge to reuse.
 */
function setupIPC() {
    const handlers = createHandlers({
        getMainWindow: () => mainWindow,
        getAppVersion: () => app.getVersion(),
        ptyManager,
        toolManager,
        configStore,
        appUpdater,
        authManager,
        keyProvisioner,
        webController: {
            getStatus: () => getWebStatus(),
            apply: async (cfg) => {
                configStore.set('webEnabled', !!cfg.enabled);
                configStore.set('webPort', Number(cfg.port) || 4178);
                configStore.set('webAllowLan', !!cfg.allowLan);
                configStore.set('webToken', cfg.token || '');
                await applyWebBridge();
                return getWebStatus();
            },
        },
    });

    for (const [channel, fn] of Object.entries(handlers.invoke)) {
        ipcMain.handle(channel, (_event, ...args: any[]) => fn(...args));
    }
    for (const [channel, fn] of Object.entries(handlers.send)) {
        ipcMain.on(channel, (_event, ...args: any[]) => fn(...args));
    }

    return handlers;
}

app.whenReady().then(() => {
    const bundledToolsPath = getResourcesPath();

    configStore = new ConfigStore();
    toolManager = new ToolManager(bundledToolsPath, configStore);
    ptyManager = new PtyManager(toolManager);
    appUpdater = new AppUpdater(configStore);
    authManager = new AuthManager(configStore);
    keyProvisioner = new KeyProvisioner();

    // Forward PTY data to the local renderer AND every connected web client.
    // endOffset lets a late-joining client replay scrollback then resume the
    // live stream with no gap or overlap.
    ptyManager.onData((sessionId: string, data: string, endOffset: number) => {
        mainWindow?.webContents.send('pty:data', sessionId, data, endOffset);
        webBridge?.broadcast('pty:data', [sessionId, data, endOffset]);
    });

    ptyManager.onExit((sessionId: string, exitCode: number) => {
        mainWindow?.webContents.send('pty:exit', sessionId, exitCode);
        webBridge?.broadcast('pty:exit', [sessionId, exitCode]);
    });

    // A session created by ANY client (local window or remote browser) is
    // announced to every client so they can mirror it as a new tab.
    ptyManager.onCreated((session) => {
        mainWindow?.webContents.send('pty:created', session);
        webBridge?.broadcast('pty:created', [session]);
    });

    // A session deliberately closed by one client → every client drops its tab.
    ptyManager.onClosed((sessionId) => {
        mainWindow?.webContents.send('pty:closed', sessionId);
        webBridge?.broadcast('pty:closed', [sessionId]);
    });

    webHandlers = setupIPC();
    createWindow();

    // Set mainWindow reference for app updater progress events
    appUpdater.setMainWindow(mainWindow);

    // Start the remote web bridge if it's enabled in settings (off by default).
    void applyWebBridge();
});

/** The shared handler registry, kept so the web bridge can be (re)started. */
let webHandlers: ReturnType<typeof setupIPC> | null = null;

function getStaticDir(): string {
    return app.isPackaged
        ? path.join(__dirname, '..', 'renderer')
        : path.join(__dirname, '..', '..', 'dist', 'renderer');
}

/** IPv4 LAN addresses, for building reachable URLs to show in settings. */
function getLanIps(): string[] {
    const nets = os.networkInterfaces();
    const ips: string[] = [];
    for (const list of Object.values(nets)) {
        for (const net of list || []) {
            if (net.family === 'IPv4' && !net.internal) ips.push(net.address);
        }
    }
    return ips;
}

/**
 * Effective web settings. Config (settings panel) is the source of truth;
 * env vars override it as a dev/testing escape hatch:
 *   ROUTER_WEB_PORT (number | "off"), ROUTER_WEB_HOST, ROUTER_WEB_TOKEN
 */
function resolveWebSettings(): { enabled: boolean; port: number; host: string; token?: string } {
    const enabledCfg = !!configStore.get('webEnabled');
    const port = Number(configStore.get('webPort')) || 4178;
    const allowLan = !!configStore.get('webAllowLan');
    const token = (configStore.get('webToken') as string) || '';

    const portEnv = process.env.ROUTER_WEB_PORT;
    const envForced = portEnv != null && portEnv.toLowerCase() !== 'off';

    return {
        enabled: envForced || enabledCfg,
        port: envForced ? (parseInt(portEnv!, 10) || port) : port,
        host: process.env.ROUTER_WEB_HOST || (allowLan ? '0.0.0.0' : '127.0.0.1'),
        token: (process.env.ROUTER_WEB_TOKEN || token) || undefined,
    };
}

/** Stop any running bridge, then start it if the current settings enable it. */
async function applyWebBridge(): Promise<void> {
    if (webBridge) {
        webBridge.stop();
        webBridge = null;
    }
    const cfg = resolveWebSettings();
    if (!cfg.enabled || !webHandlers) {
        console.log('[WebBridge] disabled');
        return;
    }
    const bridge = new WebBridge(webHandlers, { staticDir: getStaticDir(), token: cfg.token });
    try {
        await bridge.start(cfg.port, cfg.host);
        webBridge = bridge;
    } catch (err) {
        console.error('[WebBridge] failed to start:', err);
        webBridge = null;
    }
}

/** Status payload for the settings panel: current config + runtime + URLs. */
function getWebStatus(): Record<string, any> {
    const enabled = !!configStore.get('webEnabled');
    const port = Number(configStore.get('webPort')) || 4178;
    const allowLan = !!configStore.get('webAllowLan');
    const token = (configStore.get('webToken') as string) || '';
    const running = !!webBridge?.isRunning();

    const urls: string[] = [];
    if (running) {
        const q = token ? `?token=${encodeURIComponent(token)}` : '';
        urls.push(`http://127.0.0.1:${port}${q}`);
        if (allowLan) for (const ip of getLanIps()) urls.push(`http://${ip}:${port}${q}`);
    }
    return { enabled, port, allowLan, token, running, urls };
}

app.on('window-all-closed', () => {
    webBridge?.stop();
    ptyManager?.destroyAll();
    app.quit();
});

app.on('activate', () => {
    if (mainWindow === null) {
        createWindow();
    }
});
