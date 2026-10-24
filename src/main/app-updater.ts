import { app, shell, BrowserWindow } from 'electron';
import * as https from 'https';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ConfigStore } from './config-store';
import { isNewerVersion } from './version-compare';
import { pickInstallerAsset, verifyDownloadedAsset, ReleaseAsset } from './update-integrity';

const GITHUB_API_URL = 'https://api.github.com/repos/4Router/4RouterAiApp/releases/latest';
const REMOTE_CONFIG_URL = 'https://raw.githubusercontent.com/4Router/4RouterAiApp/main/remote-config.json';

/**
 * All Chinese GitHub proxy/mirror services for speed testing.
 * Each entry is [name, baseUrl].
 */
const PROXY_MIRRORS: [string, string][] = [
    ['Gh-Proxy', 'https://gh-proxy.com/'],
    ['BGithub', 'https://bgithub.xyz/'],
    ['Ghfast', 'https://ghfast.top/'],
    ['GhProxy', 'https://ghproxy.com/'],
    ['GhProxyNet', 'https://ghproxy.net/'],
    ['GhProxyMirror', 'https://mirror.ghproxy.com/'],
    ['Flash', 'https://flash.aaswordsman.org/'],
    ['GitMirror', 'https://hub.gitmirror.com/'],
    ['Moeyy', 'https://github.moeyy.xyz/'],
    ['Workers', 'https://github.abskoop.workers.dev/'],
    ['H233', 'https://gh.h233.eu.org/'],
    ['Gh1888866', 'https://ghproxy.1888866.xyz/'],
    ['GhProxyCfd', 'https://ghproxy.cfd/'],
    ['BokiMoe', 'https://github.boki.moe/'],
    ['GhProxyNetHyphen', 'https://gh-proxy.net/'],
    ['JasonZeng', 'https://gh.jasonzeng.dev/'],
    ['Monlor', 'https://gh.monlor.com/'],
    ['FastGitCc', 'https://fastgit.cc/'],
    ['Tbedu', 'https://github.tbedu.top/'],
    ['FirewallLxstd', 'https://firewall.lxstd.org/'],
    ['Ednovas', 'https://github.ednovas.xyz/'],
    ['GeekerTao', 'https://ghfile.geekertao.top/'],
    ['Chjina', 'https://gh.chjina.com/'],
    ['Hwinzniej', 'https://ghpxy.hwinzniej.top/'],
    ['CrashMc', 'https://cdn.crashmc.com/'],
    ['Yylx', 'https://git.yylx.win/'],
    ['Mrhjx', 'https://gitproxy.mrhjx.cn/'],
    ['Cxkpro', 'https://ghproxy.cxkpro.top/'],
    ['Xxooo', 'https://gh.xxooo.cf/'],
    ['Limoruirui', 'https://github.limoruirui.com/'],
    ['Llkk', 'https://gh.llkk.cc/'],
    ['Npee', 'https://down.npee.cn/?'],
    ['Nxnow', 'https://gh.nxnow.top/'],
    ['Zwy', 'https://gh.zwy.one/'],
    ['Monkeyray', 'https://ghproxy.monkeyray.net/'],
    ['Xx9527', 'https://gh.xx9527.cn/'],
];

export interface UpdateCheckResult {
    hasUpdate: boolean;
    currentVersion: string;
    latestVersion: string;
    releaseNotes: string;
    downloadUrl: string;
}

export interface DownloadResult {
    success: boolean;
    filePath?: string;
    error?: string;
}


/**
 * Helper: make an HTTPS GET request and return the response body as a string.
 * Supports optional HTTP(S) proxy.
 */
function httpsGet(url: string, proxy?: string): Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; body: string }> {
    return new Promise((resolve, reject) => {
        const parsedUrl = new URL(url);
        const options: https.RequestOptions = {
            hostname: parsedUrl.hostname,
            port: parsedUrl.port || 443,
            path: parsedUrl.pathname + parsedUrl.search,
            method: 'GET',
            headers: {
                'User-Agent': `4RouterAi/${app.getVersion()}`,
                'Accept': 'application/vnd.github.v3+json',
            },
            timeout: 15000,
        };

        // Use proxy if configured
        if (proxy) {
            try {
                const proxyUrl = new URL(proxy);
                options.hostname = proxyUrl.hostname;
                options.port = parseInt(proxyUrl.port) || (proxyUrl.protocol === 'https:' ? 443 : 80);
                options.path = url; // Full URL as path for proxy
                (options.headers as Record<string, string>)['Host'] = parsedUrl.hostname;
            } catch { /* ignore invalid proxy */ }
        }

        const req = https.request(options, (res) => {
            let body = '';
            res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
            res.on('end', () => {
                resolve({ statusCode: res.statusCode || 0, headers: res.headers, body });
            });
        });

        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
        req.end();
    });
}

/**
 * Helper: speed-test a single proxy mirror with a HEAD request.
 * Returns the response time in ms, or Infinity on failure.
 */
function testMirrorSpeed(mirrorBaseUrl: string, downloadUrl: string, timeoutMs: number = 5000): Promise<{ name: string; url: string; timeMs: number }> {
    return new Promise((resolve) => {
        const proxiedUrl = mirrorBaseUrl + downloadUrl;
        const parsedUrl = new URL(proxiedUrl);
        const isHttps = parsedUrl.protocol === 'https:';
        const lib = isHttps ? https : http;

        const start = Date.now();
        const options: http.RequestOptions = {
            hostname: parsedUrl.hostname,
            port: parsedUrl.port || (isHttps ? 443 : 80),
            path: parsedUrl.pathname + parsedUrl.search,
            method: 'HEAD',
            headers: { 'User-Agent': `4RouterAi/${app.getVersion()}` },
            timeout: timeoutMs,
        };

        const req = lib.request(options, (res) => {
            const timeMs = Date.now() - start;
            // Accept 2xx and 3xx as success
            const code = res.statusCode || 0;
            if (code >= 200 && code < 400) {
                resolve({ name: mirrorBaseUrl, url: proxiedUrl, timeMs });
            } else {
                resolve({ name: mirrorBaseUrl, url: proxiedUrl, timeMs: Infinity });
            }
            res.resume(); // Consume response to free memory
        });

        req.on('error', () => {
            resolve({ name: mirrorBaseUrl, url: proxiedUrl, timeMs: Infinity });
        });
        req.on('timeout', () => {
            req.destroy();
            resolve({ name: mirrorBaseUrl, url: proxiedUrl, timeMs: Infinity });
        });
        req.end();
    });
}

export class AppUpdater {
    private configStore: ConfigStore;
    private mainWindow: BrowserWindow | null = null;
    /** Installer of the release last seen by checkForUpdate — the only thing downloadUpdate will fetch. */
    private latestAsset: ReleaseAsset | null = null;

    constructor(configStore: ConfigStore) {
        this.configStore = configStore;
    }

    setMainWindow(win: BrowserWindow | null) {
        this.mainWindow = win;
    }

    /**
     * Check the latest GitHub release for updates.
     */
    async checkForUpdate(): Promise<UpdateCheckResult> {
        const currentVersion = app.getVersion();
        const proxy = this.configStore.get('proxy') as string | undefined;

        try {
            const resp = await httpsGet(GITHUB_API_URL, proxy || undefined);

            if (resp.statusCode !== 200) {
                console.error(`[AppUpdater] GitHub API returned ${resp.statusCode}`);
                return { hasUpdate: false, currentVersion, latestVersion: 'unknown', releaseNotes: '', downloadUrl: '' };
            }

            const release = JSON.parse(resp.body);
            const latestVersion = (release.tag_name || '').replace(/^v/, '');
            const releaseNotes = release.body || '';

            // Find .exe asset for Windows, remembering its published digest
            // so the download can be verified no matter which mirror serves it.
            this.latestAsset = pickInstallerAsset(release.assets);
            const downloadUrl = this.latestAsset?.url || '';

            // Only a strictly newer release counts. Comparing for inequality
            // used to flag a *downgrade* as an update whenever the local build
            // ran ahead of the published tag.
            const hasUpdate = isNewerVersion(latestVersion, currentVersion);

            console.log(`[AppUpdater] current=${currentVersion}, latest=${latestVersion}, hasUpdate=${hasUpdate}`);

            return { hasUpdate, currentVersion, latestVersion, releaseNotes, downloadUrl };
        } catch (err) {
            console.error('[AppUpdater] Failed to check for update:', err);
            return { hasUpdate: false, currentVersion, latestVersion: 'unknown', releaseNotes: '', downloadUrl: '' };
        }
    }

    /**
     * Speed-test all proxy mirrors and return the responsive ones, fastest first.
     */
    async rankProxies(downloadUrl: string): Promise<string[]> {
        console.log(`[AppUpdater] Speed testing ${PROXY_MIRRORS.length} proxy mirrors...`);

        this.sendProgress(-1, '正在测速选择最快的下载节点...');

        const results = await Promise.all(
            PROXY_MIRRORS.map(([_name, baseUrl]) => testMirrorSpeed(baseUrl, downloadUrl))
        );

        // Sort by response time
        results.sort((a, b) => a.timeMs - b.timeMs);

        const alive = results.filter(r => r.timeMs !== Infinity);
        if (alive.length > 0) {
            console.log(`[AppUpdater] Fastest mirror: ${alive[0].name} (${alive[0].timeMs}ms)`);
        } else {
            console.log('[AppUpdater] No proxy mirrors responded');
        }
        return alive.map(r => r.url);
    }

    /**
     * Download the update installer, verify it against the digest GitHub
     * published for the asset, and only then launch it.
     *
     * Mirrors are third-party proxies, so a download from one is never trusted
     * on its own: a mismatch discards the file and moves on to the next mirror,
     * ending with the direct github.com URL. A release without a published
     * digest skips the mirrors entirely and is fetched from GitHub directly.
     */
    async downloadUpdate(downloadUrl: string): Promise<DownloadResult> {
        const asset = this.latestAsset;
        if (!asset || asset.url !== downloadUrl) {
            return { success: false, error: '更新信息已过期，请重新检查更新' };
        }

        try {
            // Step 1: Pick download sources
            const MAX_MIRROR_ATTEMPTS = 3;
            const sources = asset.sha256
                ? [...(await this.rankProxies(asset.url)).slice(0, MAX_MIRROR_ATTEMPTS), asset.url]
                : [asset.url];
            if (!asset.sha256) {
                console.warn('[AppUpdater] Release asset has no published digest; downloading from GitHub directly');
            }

            const fileName = path.basename(new URL(asset.url).pathname) || '4RouterAi-Setup.exe';
            const filePath = path.join(os.tmpdir(), fileName);

            // Step 2: Download and verify, falling through to the next source on failure
            let lastError: unknown = null;
            for (const sourceUrl of sources) {
                console.log(`[AppUpdater] Downloading from: ${sourceUrl}`);
                this.sendProgress(0, `正在下载 ${fileName}...`);
                try {
                    await this.downloadFile(sourceUrl, filePath);
                    this.sendProgress(100, '正在校验安装包...');
                    await verifyDownloadedAsset(filePath, asset);
                } catch (err) {
                    console.error(`[AppUpdater] Download from ${sourceUrl} rejected:`, err);
                    fs.rmSync(filePath, { force: true });
                    lastError = err;
                    continue;
                }

                this.sendProgress(100, '下载完成！');

                // Step 3: Open the verified file
                shell.openPath(filePath);

                return { success: true, filePath };
            }
            throw lastError ?? new Error('没有可用的下载源');
        } catch (err: any) {
            console.error('[AppUpdater] Download failed:', err);
            return { success: false, error: err.message || String(err) };
        }
    }

    /**
     * Download a file with progress reporting. Follows redirects.
     */
    private downloadFile(url: string, destPath: string, redirectCount: number = 0): Promise<void> {
        if (redirectCount > 5) {
            return Promise.reject(new Error('Too many redirects'));
        }

        return new Promise((resolve, reject) => {
            const parsedUrl = new URL(url);
            const isHttps = parsedUrl.protocol === 'https:';
            const lib = isHttps ? https : http;

            const options: http.RequestOptions = {
                hostname: parsedUrl.hostname,
                port: parsedUrl.port || (isHttps ? 443 : 80),
                path: parsedUrl.pathname + parsedUrl.search,
                method: 'GET',
                headers: { 'User-Agent': `4RouterAi/${app.getVersion()}` },
                timeout: 60000,
            };

            const req = lib.request(options, (res) => {
                // Follow redirects
                if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    res.resume();
                    this.downloadFile(res.headers.location, destPath, redirectCount + 1)
                        .then(resolve)
                        .catch(reject);
                    return;
                }

                if (!res.statusCode || res.statusCode >= 400) {
                    res.resume();
                    reject(new Error(`HTTP ${res.statusCode}`));
                    return;
                }

                const totalBytes = parseInt(res.headers['content-length'] || '0', 10);
                let downloadedBytes = 0;
                let lastProgressPercent = 0;

                const file = fs.createWriteStream(destPath);
                res.pipe(file);

                res.on('data', (chunk: Buffer) => {
                    downloadedBytes += chunk.length;
                    if (totalBytes > 0) {
                        const percent = Math.round((downloadedBytes / totalBytes) * 100);
                        if (percent !== lastProgressPercent) {
                            lastProgressPercent = percent;
                            this.sendProgress(percent);
                        }
                    }
                });

                // Resolve on 'close', not 'finish': the handle must be released
                // before the file is hashed and handed to the installer.
                file.on('close', () => {
                    if (totalBytes > 0 && downloadedBytes !== totalBytes) {
                        reject(new Error(`下载不完整（${downloadedBytes}/${totalBytes} 字节）`));
                    } else {
                        resolve();
                    }
                });

                // pipe() does not forward source errors; a connection dropped
                // mid-body would otherwise leave this promise pending forever.
                res.on('error', (err) => {
                    file.destroy();
                    reject(err);
                });

                file.on('error', (err) => {
                    fs.unlink(destPath, () => { /* ignore */ });
                    reject(err);
                });
            });

            req.on('error', (err) => {
                fs.unlink(destPath, () => { /* ignore */ });
                reject(err);
            });
            req.on('timeout', () => {
                req.destroy();
                reject(new Error('Download timed out'));
            });
            req.end();
        });
    }

    private sendProgress(percent: number, message?: string) {
        if (this.mainWindow) {
            this.mainWindow.webContents.send('app-update:progress', percent, message);
        }
    }

    /**
     * Fetch remote model config from GitHub and compare with local settings.
     * Returns a list of changes if the remote config differs.
     */
    async checkRemoteConfig(): Promise<{ hasChanges: boolean; changes: ConfigChange[]; remoteConfig: Record<string, any> }> {
        const noResult = { hasChanges: false, changes: [] as ConfigChange[], remoteConfig: {} };

        try {
            // Race all proxy mirrors + direct URL to get the fastest response
            const configUrl = REMOTE_CONFIG_URL;
            const fetchAttempts = [
                // Direct fetch
                httpsGet(configUrl).catch(() => null),
                // Through mirrors
                ...PROXY_MIRRORS.map(([_name, baseUrl]) =>
                    httpsGet(baseUrl + configUrl).catch(() => null)
                ),
            ];

            // Use Promise.any to get the first successful response
            const resp = await Promise.any(
                fetchAttempts.map(async (attempt) => {
                    const r = await attempt;
                    if (r && r.statusCode === 200 && r.body) return r;
                    throw new Error('not ok');
                })
            );

            console.log('[AppUpdater] Remote config fetched successfully');
            const remoteConfig = JSON.parse(resp.body);
            const changes: ConfigChange[] = [];

            // Compare models
            if (remoteConfig.models) {
                const localModels = (this.configStore.get('models') as Record<string, string>) || {};
                for (const [provider, remoteModel] of Object.entries(remoteConfig.models)) {
                    const localModel = localModels[provider] || '';
                    if (localModel !== remoteModel) {
                        changes.push({
                            key: `模型 (${provider})`,
                            configKey: `models.${provider}`,
                            oldValue: localModel || '(未设置)',
                            newValue: remoteModel as string,
                        });
                    }
                }
            }

            // Compare codexReasoningEffort
            if (remoteConfig.codexReasoningEffort !== undefined) {
                const local = (this.configStore.get('codexReasoningEffort') as string) || '';
                if (local !== remoteConfig.codexReasoningEffort) {
                    changes.push({
                        key: 'Codex Reasoning Effort',
                        configKey: 'codexReasoningEffort',
                        oldValue: local || '(未设置)',
                        newValue: remoteConfig.codexReasoningEffort,
                    });
                }
            }

            // Compare codexVerbosity
            if (remoteConfig.codexVerbosity !== undefined) {
                const local = (this.configStore.get('codexVerbosity') as string) || '';
                if (local !== remoteConfig.codexVerbosity) {
                    changes.push({
                        key: 'Codex Verbosity',
                        configKey: 'codexVerbosity',
                        oldValue: local || '(未设置)',
                        newValue: remoteConfig.codexVerbosity,
                    });
                }
            }

            // Compare ccEffortLevel
            if (remoteConfig.ccEffortLevel !== undefined) {
                const local = (this.configStore.get('ccEffortLevel') as string) || '';
                if (local !== remoteConfig.ccEffortLevel) {
                    changes.push({
                        key: 'Claude Code Effort Level',
                        configKey: 'ccEffortLevel',
                        oldValue: local || '(未设置)',
                        newValue: remoteConfig.ccEffortLevel,
                    });
                }
            }

            console.log(`[AppUpdater] Remote config check: ${changes.length} change(s) found`);
            return { hasChanges: changes.length > 0, changes, remoteConfig };
        } catch (err) {
            console.error('[AppUpdater] Failed to check remote config:', err);
            return noResult;
        }
    }

    /**
     * Apply remote config changes to local config store.
     */
    applyRemoteConfig(remoteConfig: Record<string, any>): void {
        if (remoteConfig.models) {
            const localModels = (this.configStore.get('models') as Record<string, string>) || {};
            for (const [provider, model] of Object.entries(remoteConfig.models)) {
                localModels[provider] = model as string;
            }
            this.configStore.set('models', localModels);
        }
        if (remoteConfig.codexReasoningEffort !== undefined) {
            this.configStore.set('codexReasoningEffort', remoteConfig.codexReasoningEffort);
        }
        if (remoteConfig.codexVerbosity !== undefined) {
            this.configStore.set('codexVerbosity', remoteConfig.codexVerbosity);
        }
        if (remoteConfig.ccEffortLevel !== undefined) {
            this.configStore.set('ccEffortLevel', remoteConfig.ccEffortLevel);
        }
        console.log('[AppUpdater] Remote config applied successfully');
    }
}

export interface ConfigChange {
    key: string;
    configKey: string;
    oldValue: string;
    newValue: string;
}
