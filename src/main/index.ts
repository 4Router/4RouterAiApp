import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { PtyManager } from './pty-manager';
import { ToolManager } from './tool-manager';
import { ConfigStore } from './config-store';
import { AppUpdater } from './app-updater';
import { AuthManager } from './auth-manager';
import { KeyProvisioner } from './key-provisioner';
import { createHandlers, WebApplyConfig } from './ipc-handlers';
import { WebBridge, ClientInfo } from './web-server';
import { WebAuth, AccessRequest } from './web-auth';
import { WebAudit } from './web-audit';
import { WebCertStore } from './web-cert';
import { installCaTrust, isCaTrusted, trustSupported } from './web-trust';

let mainWindow: BrowserWindow | null = null;
let ptyManager: PtyManager;
let toolManager: ToolManager;
let configStore: ConfigStore;
let appUpdater: AppUpdater;
let authManager: AuthManager;
let keyProvisioner: KeyProvisioner;
let webAuth: WebAuth;
let webAudit: WebAudit;
let webCerts: WebCertStore;
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
        backgroundColor: '#0b0d12',
        frame: false,
        titleBarStyle: 'hidden',
        titleBarOverlay: {
            color: '#0b0d12',
            symbolColor: '#9aa3b8',
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
            apply: async (cfg: WebApplyConfig) => {
                const wasEnabled = !!configStore.get('webEnabled');
                const wasHttps = configStore.get('webHttps') !== false;
                configStore.set('webEnabled', !!cfg.enabled);
                configStore.set('webPort', Number(cfg.port) || 4178);
                configStore.set('webRequireApproval', cfg.requireApproval !== false);
                configStore.set('webHttps', !!cfg.https);
                configStore.set('webAllowedHosts', sanitizeHosts(cfg.allowedHosts));
                configStore.set('webTrustedNetworks', sanitizeNetworks(cfg.trustedNetworks));
                // Enabling must never leave the bridge without its secrets.
                if (cfg.enabled) {
                    webAuth.ensureToken();
                    webAuth.ensurePathPrefix();
                }
                // Gate every transition INTO "enabled + built-in HTTPS": the
                // CA must already be trusted before the bridge serves its
                // first TLS byte, otherwise the first browser visit caches an
                // "insecure" verdict — the very thing this certificate model
                // exists to avoid. The UI walks the user through trusting;
                // this is the authoritative backstop.
                const enteringSecureServe = !!cfg.enabled && !!cfg.https && !(wasEnabled && wasHttps);
                if (enteringSecureServe && trustSupported()) {
                    try {
                        const cert = await ensureWebCert();
                        caTrustCache = null; // fresh probe — trust may have just changed
                        const trusted = await cachedCaTrust(cert.ca.cert, cert.ca.fingerprint);
                        if (trusted === false) {
                            // Roll back — a refused gate must mean "no change".
                            configStore.set('webEnabled', wasEnabled);
                            configStore.set('webHttps', wasHttps);
                            webAudit.record('cert-trust', { detail: '设置被暂缓：根证书尚未加入系统信任' });
                            await applyWebBridge();
                            return { ...(await getWebStatus()), trustRequired: true };
                        }
                    } catch {
                        // Certificate issuance failed — applyWebBridge has its
                        // own fallback path; don't let the gate block it.
                    }
                }
                await applyWebBridge();
                return getWebStatus();
            },
            createPairingCode: () => webAuth.createPairingCode(),
            clearPairingCode: () => webAuth.clearPairingCode(),
            rotateToken: () => {
                const token = webAuth.rotateToken();
                webAudit.record('token-rotate');
                return token;
            },
            rotatePathPrefix: async () => {
                webAuth.rotatePathPrefix();
                webAudit.record('prefix-rotate');
                // The prefix is baked into the running server's routing and into
                // the device cookie path, so the bridge has to come back up.
                await applyWebBridge();
                return getWebStatus();
            },
            regenerateCert: async () => {
                // Leaf only — the CA (and any trust installed for it) survives.
                webCerts.clearLeaf();
                webAudit.record('cert-regenerate');
                await applyWebBridge();
                return getWebStatus();
            },
            trustCert: async () => {
                // Issue on demand so trust can be established *before* the
                // service is ever enabled — that ordering is the whole point.
                let cert = webCerts.load();
                if (!cert) {
                    try {
                        cert = await ensureWebCert();
                    } catch (err: any) {
                        return { ok: false, message: `证书签发失败：${String(err?.message || err)}` };
                    }
                }
                const res = await installCaTrust(cert.ca.cert);
                caTrustCache = null;
                webAudit.record('cert-trust', {
                    detail: res.ok ? '根证书已加入系统信任（当前用户）' : res.message,
                });
                return { ...res, status: await getWebStatus() };
            },
            exportCa: async () => {
                const cert = webCerts.load();
                if (!cert) return { ok: false, message: '尚未签发证书，请先开启内置 HTTPS' };
                const options: Electron.SaveDialogOptions = {
                    title: '导出根证书',
                    defaultPath: path.join(safeDownloadsDir(), '4RouterAi-Local-CA.crt'),
                    filters: [{ name: '证书文件', extensions: ['crt'] }],
                };
                const picked = mainWindow
                    ? await dialog.showSaveDialog(mainWindow, options)
                    : await dialog.showSaveDialog(options);
                if (picked.canceled || !picked.filePath) return { ok: false, canceled: true };
                try {
                    fs.writeFileSync(picked.filePath, cert.ca.cert, 'utf8');
                    return { ok: true, path: picked.filePath };
                } catch (err: any) {
                    return { ok: false, message: String(err?.message || err) };
                }
            },
            listDevices: () => webAuth.listDevices(),
            renameDevice: (id, name) => webAuth.renameDevice(id, name),
            revokeDevice: (id) => {
                const device = webAuth.listDevices().find(d => d.id === id);
                const ok = webAuth.revokeDevice(id);
                if (ok) {
                    webBridge?.disconnectDevice(id);
                    webAudit.record('revoke', { device: device?.name, ip: device?.ip });
                }
                return ok;
            },
            revokeAllDevices: () => {
                const count = webAuth.listDevices().length;
                webAuth.revokeAllDevices();
                webBridge?.disconnectAll();
                webAudit.record('revoke', { detail: `撤销全部 ${count} 台设备` });
            },
            listClients: () => webBridge?.listClients() ?? [],
            disconnectClient: (id) => webBridge?.disconnectClient(id) ?? false,
            disconnectAll: () => webBridge?.disconnectAll() ?? 0,
            listRequests: () => webAuth.listPendingRequests(),
            resolveRequest: (id, approved) => {
                const request = webAuth.getRequest(id);
                const ok = !!webAuth.resolveRequest(id, approved);
                if (ok) {
                    webAudit.record(approved ? 'approve' : 'deny', {
                        ip: request?.ip, device: request?.name,
                    });
                }
                return ok;
            },
            listAudit: (limit) => webAudit.list(limit),
            clearAudit: () => webAudit.clear(),
            clearLockdown: () => {
                webAuth.clearLockdown();
                webAudit.record('lockdown-clear');
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
    webAudit = new WebAudit(
        path.join(app.getPath('userData'), 'remote-access-log.json'),
        (event) => mainWindow?.webContents.send('web:audit', event),
    );
    webCerts = new WebCertStore(path.join(app.getPath('userData'), 'remote-cert.json'));
    webAuth = new WebAuth(configStore);
    webAuth.onLockdown = (state) => {
        webAudit.record('lockdown', {
            detail: `${state.failures} 次失败尝试，暂停接受新设备至 ${new Date(state.until).toLocaleTimeString()}`,
        });
        mainWindow?.webContents.send('web:lockdown', state);
    };

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

/** Normalise the user-supplied tunnel hostnames into a clean, deduped list. */
function sanitizeHosts(hosts: unknown): string[] {
    if (!Array.isArray(hosts)) return [];
    const out = new Set<string>();
    for (const raw of hosts) {
        const value = String(raw || '').trim().toLowerCase();
        if (!value) continue;
        // Tolerate a pasted URL — keep only the hostname.
        const stripped = value.replace(/^[a-z]+:\/\//, '').split('/')[0];
        if (stripped) out.add(stripped);
    }
    return [...out].slice(0, 20);
}

/** Keep only well-formed CIDRs / bare addresses for the trusted-network list. */
function sanitizeNetworks(networks: unknown): string[] {
    if (!Array.isArray(networks)) return [];
    const out = new Set<string>();
    for (const raw of networks) {
        const value = String(raw || '').trim();
        if (!value) continue;
        const [address] = value.split('/');
        if (net.isIP(address)) out.add(value);
    }
    return [...out].slice(0, 20);
}

/**
 * Effective web settings. The settings panel is the only authority here — this
 * is a desktop app, so remote access is configured in the UI and nowhere else.
 *
 * The bridge always listens on every interface. There is no LAN-versus-internet
 * distinction anywhere in the design: a device on the same WiFi and a device
 * coming through a tunnel clear exactly the same gates (encrypted transport,
 * secret path, credential, host approval), so a separate "allow LAN" switch
 * would only add a way to end up listening yet unreachable.
 */
function resolveWebSettings(): {
    enabled: boolean;
    port: number;
    host: string;
    allowedHosts: string[];
    requireApproval: boolean;
    https: boolean;
    trustedNetworks: string[];
} {
    return {
        enabled: !!configStore.get('webEnabled'),
        port: Number(configStore.get('webPort')) || 4178,
        host: '0.0.0.0',
        allowedHosts: sanitizeHosts(configStore.get('webAllowedHosts')),
        requireApproval: configStore.get('webRequireApproval') !== false,
        https: configStore.get('webHttps') !== false,
        trustedNetworks: sanitizeNetworks(configStore.get('webTrustedNetworks')),
    };
}

/**
 * Issue (or reuse) the certificate covering every address the bridge would
 * serve right now. Shared by bridge startup and the pre-enable trust flow, so
 * both always agree on the material being trusted.
 */
async function ensureWebCert() {
    return webCerts.ensure([
        ...getLanIps(),
        ...sanitizeHosts(configStore.get('webAllowedHosts')),
    ]);
}

/** Stop any running bridge, then start it if the current settings enable it. */
async function applyWebBridge(): Promise<void> {
    if (webBridge) {
        webBridge.stop();
        webBridge = null;
        webAudit.record('bridge-stop');
    }
    const cfg = resolveWebSettings();
    if (!cfg.enabled || !webHandlers) {
        console.log('[WebBridge] disabled');
        notifyWebClients([]);
        return;
    }

    // A running bridge always has both secrets; there is no "no credential" mode.
    webAuth.ensureToken();

    // The certificate has to name every address the bridge answers on, so it is
    // reissued whenever the machine's addresses or the tunnel domains change.
    let tls: { key: string; cert: string; caCert?: string } | undefined;
    if (cfg.https) {
        try {
            const bundle = await ensureWebCert();
            // Serve the full chain; the CA itself is also downloadable at
            // <prefix>/api/ca so other devices can install it.
            tls = { key: bundle.key, cert: bundle.chain, caCert: bundle.ca.cert };
        } catch (err) {
            console.error('[WebBridge] certificate generation failed, falling back to HTTP:', err);
            webAudit.record('bridge-start', { detail: '证书生成失败，已回退到 HTTP' });
        }
    }

    const bridge = new WebBridge(webHandlers, {
        staticDir: getStaticDir(),
        auth: webAuth,
        audit: webAudit,
        pathPrefix: webAuth.ensurePathPrefix(),
        allowedHosts: cfg.allowedHosts,
        requireApproval: cfg.requireApproval,
        trustedNetworks: cfg.trustedNetworks,
        tls,
        onAccessRequest: (request) => notifyAccessRequest(request),
        onClientsChanged: (clients) => notifyWebClients(clients),
    });
    const bound = await bindBridge(bridge, cfg.port, cfg.host);
    if (!bound) {
        webBridge = null;
        return;
    }

    webBridge = bridge;
    if (bound.port !== cfg.port) {
        // Persist the port that actually worked, so the panel and the next
        // launch agree with reality instead of retrying a taken port forever.
        configStore.set('webPort', bound.port);
        webAudit.record('port-fallback', {
            detail: `端口 ${cfg.port} 被占用，已自动改用 ${bound.port}`,
        });
    } else {
        webAudit.record('bridge-start', {
            detail: `${tls ? 'https' : 'http'}://${cfg.host}:${bound.port}`,
        });
    }
}

/** Ports past the configured one to try before giving up. */
const PORT_FALLBACK_ATTEMPTS = 12;

/**
 * Bind the bridge, stepping to the next port when one is already taken.
 *
 * Unrelated software routinely squats on a fixed default (an OEM background
 * service, another dev server), and the previous behaviour was to log
 * EADDRINUSE and leave remote access silently dead — a failure mode the user
 * has no way to diagnose from the UI. Walking forward a few ports keeps the
 * feature working; anything other than a port conflict is still a hard failure.
 */
async function bindBridge(
    bridge: WebBridge,
    preferred: number,
    host: string,
): Promise<{ port: number } | null> {
    for (let offset = 0; offset <= PORT_FALLBACK_ATTEMPTS; offset++) {
        const port = preferred + offset;
        if (port > 65535) break;
        try {
            await bridge.start(port, host);
            if (offset > 0) console.warn(`[WebBridge] port ${preferred} taken, using ${port}`);
            return { port };
        } catch (err: any) {
            if (err?.code !== 'EADDRINUSE') {
                console.error('[WebBridge] failed to start:', err);
                return null;
            }
        }
    }
    console.error(`[WebBridge] no free port in ${preferred}-${preferred + PORT_FALLBACK_ATTEMPTS}`);
    webAudit.record('port-fallback', {
        detail: `${preferred}-${preferred + PORT_FALLBACK_ATTEMPTS} 端口全部被占用，远程访问未启动`,
    });
    return null;
}

/** A remote client is waiting to be let in — surface it on the desktop window. */
function notifyAccessRequest(request: AccessRequest): void {
    console.log(`[WebBridge] access request from ${request.name} @ ${request.ip}`);
    mainWindow?.webContents.send('web:access-request', request);
    if (mainWindow && !mainWindow.isVisible()) mainWindow.show();
    mainWindow?.flashFrame(true);
}

function notifyWebClients(clients: ClientInfo[]): void {
    mainWindow?.webContents.send('web:clients-changed', clients);
}

/**
 * Cached result of the certutil trust probe, so repainting the settings panel
 * doesn't spawn a process per refresh. Cleared whenever trust may change.
 */
let caTrustCache: { fingerprint: string; trusted: boolean | null; at: number } | null = null;
const CA_TRUST_CACHE_MS = 5_000;

async function cachedCaTrust(certPem: string, fingerprint: string): Promise<boolean | null> {
    const now = Date.now();
    if (caTrustCache && caTrustCache.fingerprint === fingerprint && now - caTrustCache.at < CA_TRUST_CACHE_MS) {
        return caTrustCache.trusted;
    }
    const trusted = await isCaTrusted(certPem);
    caTrustCache = { fingerprint, trusted, at: now };
    return trusted;
}

/** Where the export dialog should land by default. */
function safeDownloadsDir(): string {
    try {
        return app.getPath('downloads');
    } catch {
        return app.getPath('home');
    }
}

/** Status payload for the remote-access panel: config, runtime, credentials, peers. */
async function getWebStatus(): Promise<Record<string, any>> {
    const cfg = resolveWebSettings();
    const running = !!webBridge?.isRunning();
    const prefix = cfg.enabled ? webAuth.ensurePathPrefix() : configStore.getWebPathPrefix();

    // Direct URLs follow whatever we actually serve; tunnel domains are always
    // advertised as https since TLS is expected to terminate upstream.
    const scheme = cfg.https ? 'https' : 'http';
    const urls: string[] = [];
    if (running) {
        const suffix = prefix ? `/${prefix}/` : '/';
        urls.push(`${scheme}://127.0.0.1:${cfg.port}${suffix}`);
        for (const ip of getLanIps()) urls.push(`${scheme}://${ip}:${cfg.port}${suffix}`);
        for (const host of cfg.allowedHosts) urls.push(`https://${host}${suffix}`);
    }

    const cert = cfg.https ? webCerts.load() : null;
    const caTrusted = cert ? await cachedCaTrust(cert.ca.cert, cert.ca.fingerprint) : null;

    return {
        enabled: cfg.enabled,
        port: cfg.port,
        allowedHosts: cfg.allowedHosts,
        requireApproval: cfg.requireApproval,
        https: cfg.https,
        certFingerprint: cert?.fingerprint || '',
        certExpiresAt: cert?.expiresAt || 0,
        caFingerprint: cert?.ca.fingerprint || '',
        caExpiresAt: cert?.ca.expiresAt || 0,
        /** true/false from the OS probe; null = unknown or unsupported platform. */
        caTrusted,
        caTrustSupported: trustSupported(),
        trustedNetworks: cfg.trustedNetworks,
        running,
        urls,
        // Local-only payload: `web:*` never reaches a remote client.
        token: cfg.enabled ? webAuth.ensureToken() : configStore.getWebToken(),
        pathPrefix: prefix,
        pairingCode: webAuth.getPairingCode(),
        devices: webAuth.listDevices(),
        clients: webBridge?.listClients() ?? [],
        lockouts: webAuth.listLockouts(),
        lockdown: webAuth.lockdownState(),
    };
}

app.on('window-all-closed', () => {
    webBridge?.stop();
    // Audit writes are debounced; make sure the tail reaches disk before exit.
    webAudit?.flush();
    ptyManager?.destroyAll();
    app.quit();
});

app.on('activate', () => {
    if (mainWindow === null) {
        createWindow();
    }
});
