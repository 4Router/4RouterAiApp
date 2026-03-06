import { app, shell, BrowserWindow } from 'electron';
import * as https from 'https';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ConfigStore } from './config-store';

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

            // Find .exe asset for Windows
            let downloadUrl = '';
            if (release.assets && Array.isArray(release.assets)) {
                const exeAsset = release.assets.find((a: any) =>
                    a.name && (a.name.endsWith('.exe') || a.name.endsWith('.zip')) && a.browser_download_url
                );
                if (exeAsset) {
                    downloadUrl = exeAsset.browser_download_url;
                }
            }

            const hasUpdate = latestVersion !== currentVersion && latestVersion !== 'unknown' && latestVersion !== '';

            console.log(`[AppUpdater] current=${currentVersion}, latest=${latestVersion}, hasUpdate=${hasUpdate}`);

            return { hasUpdate, currentVersion, latestVersion, releaseNotes, downloadUrl };
        } catch (err) {
            console.error('[AppUpdater] Failed to check for update:', err);
            return { hasUpdate: false, currentVersion, latestVersion: 'unknown', releaseNotes: '', downloadUrl: '' };
        }
    }

    /**
     * Speed-test all proxy mirrors and return the fastest one.
     */
    async findFastestProxy(downloadUrl: string): Promise<string> {
        console.log(`[AppUpdater] Speed testing ${PROXY_MIRRORS.length} proxy mirrors...`);

        this.sendProgress(-1, '正在测速选择最快的下载节点...');

        const results = await Promise.all(
            PROXY_MIRRORS.map(([_name, baseUrl]) => testMirrorSpeed(baseUrl, downloadUrl))
        );

        // Sort by response time
        results.sort((a, b) => a.timeMs - b.timeMs);

        const best = results[0];
        if (best && best.timeMs !== Infinity) {
            console.log(`[AppUpdater] Fastest mirror: ${best.name} (${best.timeMs}ms)`);
            return best.url;
        }

        // Fallback: try direct download URL
        console.log('[AppUpdater] No proxy mirrors responded, falling back to direct URL');
        return downloadUrl;
    }

    /**
     * Download update installer via the fastest proxy mirror.
     */
    async downloadUpdate(downloadUrl: string): Promise<DownloadResult> {
        try {
            // Step 1: Find fastest proxy
            const finalUrl = await this.findFastestProxy(downloadUrl);
            console.log(`[AppUpdater] Downloading from: ${finalUrl}`);

            // Step 2: Download the file
            const fileName = path.basename(new URL(downloadUrl).pathname) || '4RouterAi-Setup.exe';
            const filePath = path.join(os.tmpdir(), fileName);

            this.sendProgress(0, `正在下载 ${fileName}...`);

            await this.downloadFile(finalUrl, filePath);

            this.sendProgress(100, '下载完成！');

            // Step 3: Open the downloaded file
            shell.openPath(filePath);

            return { success: true, filePath };
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

                file.on('finish', () => {
                    file.close();
                    resolve();
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
        console.log('[AppUpdater] Remote config applied successfully');
    }
}

export interface ConfigChange {
    key: string;
    configKey: string;
    oldValue: string;
    newValue: string;
}
