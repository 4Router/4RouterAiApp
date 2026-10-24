import { app, shell, BrowserWindow } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ConfigStore } from './config-store';
import { isNewerVersion } from './version-compare';
import { agreeOnRelease, pickInstallerAsset, verifyDownloadedAsset, ReleaseAsset } from './update-integrity';
import { downloadResumable, getText, NetOptions, probeSource, rankProbes } from './update-net';

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


const RELEASE_URL_PREFIX = 'https://github.com/4Router/4RouterAiApp/releases/download/';

/** Mirrors that must report the same release before their word is taken. */
const MIRROR_QUORUM = 2;

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

    /** Proxy and identification shared by every request the updater makes. */
    private netOptions(headers: Record<string, string> = {}): NetOptions {
        const proxy = (this.configStore.get('proxy') as string | undefined)?.trim();
        return {
            proxy: proxy || undefined,
            headers: { 'User-Agent': `4RouterAi/${app.getVersion()}`, ...headers },
        };
    }

    /**
     * Check the latest GitHub release for updates.
     */
    async checkForUpdate(): Promise<UpdateCheckResult> {
        const currentVersion = app.getVersion();
        const unknown = { hasUpdate: false, currentVersion, latestVersion: 'unknown', releaseNotes: '', downloadUrl: '' };

        try {
            const release = await this.fetchLatestRelease();
            if (!release) return unknown;

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
            return unknown;
        }
    }

    /**
     * The latest release, from api.github.com directly (or via the configured
     * proxy) when it answers. When it doesn't — unreachable, or rate-limited
     * behind a shared NAT — ask the mirrors, but only accept a release that
     * MIRROR_QUORUM of them describe identically: one mirror alone could hand
     * out a forged digest together with the matching forged installer.
     */
    private async fetchLatestRelease(): Promise<any | null> {
        const opts = this.netOptions({ 'Accept': 'application/vnd.github.v3+json' });

        try {
            const resp = await getText(GITHUB_API_URL, { ...opts, idleTimeoutMs: 15000 });
            if (resp.statusCode === 200) return JSON.parse(resp.body);
            console.warn(`[AppUpdater] GitHub API returned ${resp.statusCode}, asking mirrors`);
        } catch (err) {
            console.warn('[AppUpdater] GitHub API unreachable, asking mirrors:', err);
        }

        const replies = await Promise.all(PROXY_MIRRORS.map(async ([_name, baseUrl]) => {
            try {
                const resp = await getText(baseUrl + GITHUB_API_URL, { ...opts, idleTimeoutMs: 10000 });
                return resp.statusCode === 200 ? JSON.parse(resp.body) : null;
            } catch {
                return null;
            }
        }));
        const answered = replies.filter(Boolean);
        const release = agreeOnRelease(answered, MIRROR_QUORUM, RELEASE_URL_PREFIX);
        console.log(`[AppUpdater] ${answered.length} mirror(s) returned release info; quorum ${release ? 'reached' : 'not reached'}`);
        return release;
    }

    /**
     * Probe every source with a small ranged GET and return the usable ones,
     * resumable first and fastest first. Falls back to all of them, unranked,
     * when none answers in time — the download itself is verified anyway.
     */
    private async rankSources(asset: ReleaseAsset): Promise<string[]> {
        const candidates = [asset.url, ...PROXY_MIRRORS.map(([_name, baseUrl]) => baseUrl + asset.url)];
        console.log(`[AppUpdater] Probing ${candidates.length} download sources...`);

        this.sendProgress(-1, '正在测速选择最快的下载节点...');

        const magic = asset.name.endsWith('.exe') ? Buffer.from('MZ') : undefined;
        const opts = { ...this.netOptions(), idleTimeoutMs: 8000 };
        const ranked = rankProbes(await Promise.all(
            candidates.map(url => probeSource(url, { size: asset.size, magic }, opts))
        ));

        if (ranked.length === 0) {
            console.log('[AppUpdater] No source passed the probe; trying all of them');
            return candidates;
        }
        console.log(`[AppUpdater] ${ranked.length} usable source(s), fastest: ${ranked[0]}`);
        // Keep the rest as a last resort: a probe can time out on a source
        // that would still have worked.
        return [...ranked, ...candidates.filter(url => !ranked.includes(url))];
    }

    /**
     * Download the update installer, verify it against the digest GitHub
     * published for the asset, and only then launch it.
     *
     * The transfer resumes across dropped connections and across sources, and
     * a partial file left by an earlier attempt is picked up again. Mirrors
     * are third-party proxies, so the result is never trusted on its own: if
     * the assembled file fails verification, each source is retried alone so
     * a bad one can't spoil the rest. A release without a published digest
     * skips the mirrors entirely and is fetched from GitHub directly.
     */
    async downloadUpdate(downloadUrl: string): Promise<DownloadResult> {
        const asset = this.latestAsset;
        if (!asset || asset.url !== downloadUrl) {
            return { success: false, error: '更新信息已过期，请重新检查更新' };
        }

        try {
            const fileName = path.basename(new URL(asset.url).pathname) || '4RouterAi-Setup.exe';
            const filePath = path.join(os.tmpdir(), fileName);
            const partPath = `${filePath}.part`;

            // Already downloaded by an earlier attempt?
            if (fs.existsSync(filePath)) {
                try {
                    await verifyDownloadedAsset(filePath, asset);
                    return this.launchInstaller(filePath);
                } catch {
                    fs.rmSync(filePath, { force: true });
                }
            }

            // Step 1: Pick download sources
            if (!asset.sha256) {
                console.warn('[AppUpdater] Release asset has no published digest; downloading from GitHub directly');
            }
            const sources = asset.sha256 ? await this.rankSources(asset) : [asset.url];

            // Step 2: Download (resuming wherever possible) and verify
            this.sendProgress(0, `正在下载 ${fileName}...`);
            if (await this.downloadAndVerify(sources, partPath, asset)) {
                fs.renameSync(partPath, filePath);
                return this.launchInstaller(filePath);
            }

            console.warn('[AppUpdater] Assembled download failed verification; retrying each source alone');
            for (const source of sources) {
                this.sendProgress(0, '校验未通过，正在更换下载源...');
                if (await this.downloadAndVerify([source], partPath, asset)) {
                    fs.renameSync(partPath, filePath);
                    return this.launchInstaller(filePath);
                }
            }
            throw new Error('所有下载源的安装包都未通过校验');
        } catch (err: any) {
            console.error('[AppUpdater] Download failed:', err);
            return { success: false, error: err.message || String(err) };
        }
    }

    /**
     * Resumable download into `partPath`, then size + SHA-256 check. Resolves
     * false (and discards the file) when the bytes are wrong; rejects when no
     * source could deliver the whole file.
     */
    private async downloadAndVerify(sources: string[], partPath: string, asset: ReleaseAsset): Promise<boolean> {
        let lastPercent = -1;
        await downloadResumable(sources, partPath, {
            ...this.netOptions(),
            expectedSize: asset.size,
            onProgress: (received, total) => {
                if (total <= 0) return;
                const percent = Math.floor((received / total) * 100);
                if (percent !== lastPercent) {
                    lastPercent = percent;
                    this.sendProgress(percent);
                }
            },
            onRetry: (offset, err) => {
                console.warn(`[AppUpdater] Transfer interrupted at ${offset} bytes:`, err);
                this.sendProgress(lastPercent, `网络中断，正在续传（已下载 ${Math.max(lastPercent, 0)}%）...`);
            },
        });

        this.sendProgress(100, '正在校验安装包...');
        try {
            await verifyDownloadedAsset(partPath, asset);
            return true;
        } catch (err) {
            console.error('[AppUpdater] Verification failed:', err);
            fs.rmSync(partPath, { force: true });
            return false;
        }
    }

    private launchInstaller(filePath: string): DownloadResult {
        this.sendProgress(100, '下载完成！');
        shell.openPath(filePath);
        return { success: true, filePath };
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
            const opts = { ...this.netOptions(), idleTimeoutMs: 15000 };
            const fetchAttempts = [
                // Direct fetch
                getText(configUrl, opts).catch(() => null),
                // Through mirrors
                ...PROXY_MIRRORS.map(([_name, baseUrl]) =>
                    getText(baseUrl + configUrl, opts).catch(() => null)
                ),
            ];

            // Use Promise.any to get the first successful response. Parse
            // inside the race: some mirrors answer 200 with an HTML page, and
            // winning with one of those would sink the whole check.
            const remoteConfig = await Promise.any(
                fetchAttempts.map(async (attempt) => {
                    const r = await attempt;
                    if (r && r.statusCode === 200 && r.body) {
                        const parsed = JSON.parse(r.body);
                        if (parsed && typeof parsed === 'object') return parsed;
                    }
                    throw new Error('not ok');
                })
            );

            console.log('[AppUpdater] Remote config fetched successfully');
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
