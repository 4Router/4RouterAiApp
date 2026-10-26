import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { ConfigStore } from './config-store';
import { buildSanitizedEnv } from './process-env';
import { compareVersions, isNewerVersion } from './version-compare';
import {
    OFFICIAL_REGISTRY,
    CHINA_MIRROR_REGISTRY,
    NPM_INSTALL_TIMEOUT_MS,
    NPM_VIEW_TIMEOUT_MS,
    FsFailure,
    RegistryProbe,
    buildNpmInstallArgs,
    buildNpmNetworkArgs,
    classifyFsFailure,
    describeInstallTimeout,
    isTimeoutKill,
    pickTargetVersion,
    planInstall,
    platformInstallSpec,
    platformPackageName,
    platformVersionMatches,
    registryLabel,
    retryAfterTimeout,
} from './npm-install-plan';

export interface ToolInfo {
    id: string;
    name: string;
    description: string;
    provider: string;
    icon: string;
    envKeyName: string;
    envBaseUrlName: string;
    defaultBaseUrl: string;
    available: boolean;
    version?: string;
    source?: 'bundled' | 'global';
    /** Bundled, but its native-binary package is missing — launching would fail. */
    broken?: boolean;
}

export interface LaunchConfig {
    bin: string;
    args: string[];
    env: Record<string, string>;
}

interface ResolvedToolPath {
    path: string;
    source: 'bundled' | 'global';
    launchMode: 'node-script' | 'command';
}

/** First Codex release with `--no-daemon`; older releases reject the flag. */
const CODEX_NO_DAEMON_MIN_VERSION = '0.156.0';

/**
 * Extract user-managed sections from an existing Codex config.toml,
 * filtering out host-controlled keys and sections that 4RouterAi
 * regenerates on every launch.
 */
function preserveUserConfig(existing: string): string {
    // Section headers that the host app fully controls (regenerated each launch).
    const hostSections = new Set([
        '[model_providers.4routerai]',
        '[analytics]',
    ]);
    // Root-level keys that the host app controls.
    const hostRootKeys = new Set([
        'model_provider',
        'model',
        'model_reasoning_effort',
        'model_context_window',
        'model_auto_compact_token_limit',
        'check_for_update_on_startup',
        'model_verbosity',
        'approval_policy',
        'sandbox_mode',
    ]);

    const lines = existing.split('\n');
    const preserved: string[] = [];
    let inHostSection = false;

    for (const line of lines) {
        const trimmed = line.trim();

        // Detect section headers — e.g. [windows], [projects.'...'], [notice]
        if (/^\[.+\]/.test(trimmed)) {
            inHostSection = hostSections.has(trimmed);
            if (!inHostSection) {
                preserved.push(line);
            }
            continue;
        }

        // Inside a host-controlled section → skip the line
        if (inHostSection) continue;

        // Root-level area → filter out host-controlled keys
        const keyMatch = trimmed.match(/^(\w+)\s*=/);
        if (keyMatch && hostRootKeys.has(keyMatch[1])) continue;

        preserved.push(line);
    }

    // Trim leading/trailing blank lines and return with surrounding newlines
    const result = preserved.join('\n').trim();
    return result ? '\n' + result + '\n' : '';
}

export class ToolManager {
    private toolDefinitions: ToolInfo[] = [
        {
            id: 'claude-code',
            name: 'Claude Code',
            description: 'Anthropic 的 AI 编程助手',
            provider: 'anthropic',
            icon: '🟣',
            envKeyName: 'ANTHROPIC_API_KEY',
            envBaseUrlName: 'ANTHROPIC_BASE_URL',
            defaultBaseUrl: 'https://api.anthropic.com',
            available: false,
        },
        {
            id: 'codex',
            name: 'Codex CLI',
            description: 'OpenAI 的命令行编程代理',
            provider: 'openai',
            icon: '🟢',
            envKeyName: 'OPENAI_API_KEY',
            envBaseUrlName: 'OPENAI_BASE_URL',
            defaultBaseUrl: 'https://api.openai.com/v1',
            available: false,
        },
    ];

    /**
     * Runs the bundled npm. A field rather than a direct call so
     * scripts/verify-tool-update.cjs can stub it without spawning npm.
     */
    private runFile: typeof import('child_process').execFile = require('child_process').execFile;

    constructor(
        private bundledToolsPath: string,
        private configStore: ConfigStore
    ) {
        console.log('[ToolManager] Bundled tools path:', this.bundledToolsPath);
        this.detectTools();
    }

    private detectTools(): void {
        for (const tool of this.toolDefinitions) {
            const result = this.findToolBin(tool.id);
            tool.available = result !== null;
            tool.source = result?.source;
            if (result) {
                console.log(`[ToolManager] ${tool.id}: found at ${result.path} (${result.source})`);
            }

            if (tool.available) {
                try {
                    const pkgDir = path.join(this.bundledToolsPath,
                        tool.id === 'claude-code' ? 'claude-code' : 'codex');
                    const pkgJsonPath = path.join(pkgDir, 'node_modules',
                        tool.id === 'claude-code' ? '@anthropic-ai' : '@openai',
                        tool.id === 'claude-code' ? 'claude-code' : 'codex',
                        'package.json');
                    if (fs.existsSync(pkgJsonPath)) {
                        const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'));
                        tool.version = pkg.version;
                    }
                } catch { /* best-effort */ }
            }

            tool.broken = tool.available && tool.source === 'bundled' && !this.platformPackageOk(tool.id);
            if (tool.broken) {
                console.warn(`[ToolManager] ${tool.id}: native binary package missing or mismatched — needs repair`);
            }
        }
    }

    private getPackageName(toolId: string): string {
        return toolId === 'claude-code' ? '@anthropic-ai/claude-code' : '@openai/codex';
    }

    /**
     * Whether the native-binary package the launcher needs is really there:
     * its package.json present (what cli-wrapper.cjs / codex.js resolve) and
     * built for the installed main version. A bare directory isn't enough —
     * a half-finished update can leave one behind.
     */
    private platformPackageOk(toolId: string): boolean {
        const packageName = this.getPackageName(toolId);
        const platformPkg = platformPackageName(packageName, os.platform(), os.arch());
        if (!platformPkg) return true; // no native package for this platform
        const nodeModules = path.join(this.getToolDir(toolId), 'node_modules');
        try {
            const read = (name: string) =>
                JSON.parse(fs.readFileSync(path.join(nodeModules, ...name.split('/'), 'package.json'), 'utf-8'));
            const ok = platformVersionMatches(read(platformPkg).version, read(packageName).version);
            console.log(`[ToolManager] ${toolId} platform package ${platformPkg}: ${ok ? 'ok' : 'version mismatch'}`);
            return ok;
        } catch {
            console.log(`[ToolManager] ${toolId} platform package ${platformPkg}: missing`);
            return false;
        }
    }

    private getToolDir(toolId: string): string {
        return path.join(this.bundledToolsPath, toolId === 'claude-code' ? 'claude-code' : 'codex');
    }

    private getBundledNodeDir(): string {
        return path.join(this.bundledToolsPath, 'node-runtime');
    }

    private getBundledGitDir(): string {
        return path.join(this.bundledToolsPath, 'mingit');
    }

    private getBundledNodeExecutable(): string {
        const exeName = os.platform() === 'win32' ? 'node.exe' : 'node';
        return path.join(this.getBundledNodeDir(), exeName);
    }

    private getBundledNpmCli(): string {
        return path.join(this.getBundledNodeDir(), 'node_modules', 'npm', 'bin', 'npm-cli.js');
    }

    private getBundledGitBashPath(): string {
        return path.join(this.getBundledGitDir(), 'bin', 'bash.exe');
    }

    private getBundledGitPathEntries(): string[] {
        const gitDir = this.getBundledGitDir();
        return [
            path.join(gitDir, 'cmd'),
            path.join(gitDir, 'bin'),
            path.join(gitDir, 'usr', 'bin'),
            path.join(gitDir, 'mingw64', 'bin'),
        ].filter(entry => fs.existsSync(entry));
    }

    private hasBundledRuntime(): boolean {
        return fs.existsSync(this.getBundledNodeExecutable()) && fs.existsSync(this.getBundledNpmCli());
    }

    private getBundledToolScript(toolId: string): string | null {
        const toolDir = this.getToolDir(toolId);
        switch (toolId) {
            case 'claude-code': {
                const pkgDir = path.join(toolDir, 'node_modules', '@anthropic-ai', 'claude-code');
                const candidates = [
                    path.join(pkgDir, 'cli.js'),
                    path.join(pkgDir, 'cli-wrapper.cjs'),
                ];
                return candidates.find(c => fs.existsSync(c)) || null;
            }
            case 'codex':
                return path.join(toolDir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
            default:
                return null;
        }
    }

    private resolveClaudeGitBashPath(): string | null {
        if (os.platform() !== 'win32') {
            return null;
        }

        const bundledBashPath = this.getBundledGitBashPath();
        if (fs.existsSync(bundledBashPath)) {
            return bundledBashPath;
        }

        const explicitPath = process.env.CLAUDE_CODE_GIT_BASH_PATH;
        if (explicitPath && fs.existsSync(explicitPath)) {
            return explicitPath;
        }

        const pathKey = Object.keys(process.env).find(k => k.toUpperCase() === 'PATH') || 'PATH';
        const pathEntries = (process.env[pathKey] || process.env.PATH || '')
            .split(';')
            .map(entry => entry.trim())
            .filter(Boolean);

        const candidates = [
            ...pathEntries.map(entry => path.join(entry, 'bash.exe')),
            path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'bin', 'bash.exe'),
            path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Git', 'bin', 'bash.exe'),
            path.join(process.env.LocalAppData || path.join(os.homedir(), 'AppData', 'Local'), 'Programs', 'Git', 'bin', 'bash.exe'),
        ];

        for (const candidate of candidates) {
            if (fs.existsSync(candidate)) {
                return candidate;
            }
        }

        return null;
    }

    private buildRuntimeEnv(extraEnv: Record<string, string> = {}): Record<string, string> {
        const env = { ...extraEnv };
        if (!this.hasBundledRuntime()) {
            return env;
        }

        const pathKey = Object.keys(process.env).find(k => k.toUpperCase() === 'PATH') || 'PATH';
        const pathSep = os.platform() === 'win32' ? ';' : ':';
        const currentPath = process.env[pathKey] || process.env.PATH || '';
        env[pathKey] = [
            this.getBundledNodeDir(),
            ...this.getBundledGitPathEntries(),
            currentPath,
        ].filter(Boolean).join(pathSep);
        return env;
    }

    private findToolBin(toolId: string): ResolvedToolPath | null {
        const isWin = os.platform() === 'win32';
        const binExt = isWin ? '.cmd' : '';
        let binName: string;
        const toolDir = this.getToolDir(toolId);

        switch (toolId) {
            case 'claude-code':
                binName = 'claude' + binExt;
                break;
            case 'codex':
                binName = 'codex' + binExt;
                break;
            default:
                return null;
        }

        const bundledScript = this.getBundledToolScript(toolId);
        if (bundledScript && this.hasBundledRuntime() && fs.existsSync(bundledScript)) {
            return { path: bundledScript, source: 'bundled', launchMode: 'node-script' };
        }

        const globalBin = isWin
            ? path.join(process.env.APPDATA || '', 'npm', binName)
            : path.join('/usr/local/bin', binName);
        if (fs.existsSync(globalBin)) {
            return { path: globalBin, source: 'global', launchMode: 'command' };
        }

        return null;
    }

    listTools(): ToolInfo[] {
        this.detectTools();
        return this.toolDefinitions;
    }

    getToolStatus(toolId: string): ToolInfo | null {
        return this.toolDefinitions.find(t => t.id === toolId) || null;
    }

    getLaunchConfig(toolId: string): LaunchConfig | null {
        const tool = this.toolDefinitions.find(t => t.id === toolId);
        if (!tool) return null;

        const result = this.findToolBin(toolId);
        if (!result) return null;

        const apiKey = this.configStore.getApiKey(tool.provider);
        const baseUrl = this.configStore.getBaseUrl(tool.provider);
        const model = this.configStore.getModel(tool.provider);
        const args: string[] = [];
        const env: Record<string, string> = this.buildRuntimeEnv();

        // =============================================
        // Use CLI FLAGS — highest precedence, guaranteed
        // =============================================

        // Shared config root for all embedded tools.
        const appDataDir = path.join(
            process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
            '4RouterAi'
        );

        if (tool.id === 'claude-code') {
            if (os.platform() === 'win32') {
                const gitBashPath = this.resolveClaudeGitBashPath();
                if (!gitBashPath) {
                    throw new Error(
                        'Claude Code 在 Windows 上需要 Git Bash/MinGit。请重新打包内置 MinGit，或设置 CLAUDE_CODE_GIT_BASH_PATH 指向 bash.exe。'
                    );
                }
                env['CLAUDE_CODE_GIT_BASH_PATH'] = gitBashPath;
                console.log(`[ToolManager] Using Git Bash for Claude Code: ${gitBashPath}`);
            }

            // Isolate bundled Claude Code config from any system-installed Claude Code.
            // Source: cc/src/utils/envUtils.ts → CLAUDE_CONFIG_DIR overrides ~/.claude
            // Source: cc/src/utils/env.ts:25  → .claude.json = join(CLAUDE_CONFIG_DIR, filename)
            //
            // When CLAUDE_CONFIG_DIR is set, CC places everything directly inside
            // it (settings.json, sessions/, backups/, etc.) — no nested .claude/.
            const claudeHomeDir = path.join(appDataDir, 'claude-home');
            fs.mkdirSync(claudeHomeDir, { recursive: true });
            env['CLAUDE_CONFIG_DIR'] = claudeHomeDir;
            console.log(`[ToolManager] Isolated CLAUDE_CONFIG_DIR: ${claudeHomeDir}`);

            // Skip Claude Code's built-in onboarding — 4RouterAi's own welcome page replaces it.
            // .claude.json lives at join(CLAUDE_CONFIG_DIR, filename) (see cc/src/utils/env.ts:24-25).
            const claudeJsonPath = path.join(claudeHomeDir, '.claude.json');
            try {
                let claudeJson: any = {};
                if (fs.existsSync(claudeJsonPath)) {
                    claudeJson = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf-8'));
                }
                if (!claudeJson.hasCompletedOnboarding) {
                    claudeJson.hasCompletedOnboarding = true;
                    fs.writeFileSync(claudeJsonPath, JSON.stringify(claudeJson, null, 2), 'utf-8');
                    console.log(`[ToolManager] Marked onboarding complete: ${claudeJsonPath}`);
                }
            } catch (e) {
                console.warn(`[ToolManager] Failed to update .claude.json:`, e);
            }

            // Write settings JSON to a temp file to avoid shell escaping issues.
            // Passing JSON inline through PowerShell → cmd.exe → node.exe
            // mangles the string. A file path is always safe.
            const settings: any = { env: {} };
            if (apiKey) {
                settings.env['ANTHROPIC_AUTH_TOKEN'] = apiKey;
            }
            if (baseUrl) {
                settings.env['ANTHROPIC_BASE_URL'] = baseUrl;
            }
            if (model) {
                settings['model'] = model;
            }

            // ── 4RouterAi embedded-environment defaults ──
            // Disable attribution header — 3rd-party base_url proxies don't
            // recognise x-anthropic-billing-header and may reject it.
            settings.env['CLAUDE_CODE_ATTRIBUTION_HEADER'] = '0';
            // Suppress all nonessential network traffic (telemetry, auto-update
            // checks, release notes, MCP registry, GrowthBook, etc.). The host
            // app handles updates; these requests would just add latency.
            settings.env['CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC'] = '1';
            // Prevent cc from writing OSC escape sequences to change the
            // terminal title — inside xterm.js they are either ignored or
            // produce visual artefacts.
            settings.env['CLAUDE_CODE_DISABLE_TERMINAL_TITLE'] = '1';
            // When ANTHROPIC_BASE_URL is a non-Anthropic host, cc auto-disables
            // tool search (defer_loading / tool_reference). Force it on so MCP
            // tools are lazily loaded, saving context window tokens.
            settings.env['ENABLE_TOOL_SEARCH'] = 'true';
            // Set reasoning effort level for Claude Code.
            const ccEffort = this.configStore.get('ccEffortLevel') as string;
            if (ccEffort) {
                settings.env['CLAUDE_CODE_EFFORT_LEVEL'] = ccEffort;
            }
            // Skip the WebFetch domain-blocklist preflight that hits
            // api.anthropic.com — unreachable through a 3rd-party proxy,
            // causing every WebFetch call to fail with DomainCheckFailedError.
            settings['skipWebFetchPreflight'] = true;

            // Bypass all permission prompts when the user has opted in.
            if (this.configStore.get('ccBypassPermissions')) {
                settings.permissions = { defaultMode: 'bypassPermissions' };
            }

            // Always write the settings file — the env block now contains
            // 4RouterAi defaults even when apiKey/baseUrl are absent.
            // Uses the native CC user-settings filename (settings.json) at
            // CLAUDE_CONFIG_DIR root, matching cc/src/utils/settings/settings.ts.
            const settingsFile = path.join(claudeHomeDir, 'settings.json');

            fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2), 'utf-8');
            args.push('--settings', settingsFile);
            console.log(`[ToolManager] Wrote Claude settings to ${settingsFile}`);
        } else if (tool.id === 'codex') {
            // ── Merge host-controlled settings into config.toml ──
            // Codex reads its config from $CODEX_HOME/config.toml
            // (default: ~/.codex/config.toml). Using a 4RouterAi-
            // scoped directory keeps our config isolated.
            //
            // Important: Codex writes user preferences (trust_level,
            // sandbox mode, notice acknowledgements, etc.) back into
            // this same config.toml at runtime. A full overwrite would
            // destroy those preferences, forcing the user to re-confirm
            // settings on every new session. Instead we regenerate only
            // the host-controlled fields and preserve the rest.
            const codexHomeDir = path.join(appDataDir, 'codex-home');
            fs.mkdirSync(codexHomeDir, { recursive: true });

            const lines: string[] = [];

            // ── Root-level keys ──
            // All root-level keys MUST appear before any [section] header,
            // because in TOML everything after a section header belongs to
            // that table until the next section header.
            if (baseUrl) {
                const providerName = '4routerai';
                lines.push(`model_provider = "${providerName}"`);
            }
            if (model) {
                lines.push(`model = "${model}"`);
            }
            const reasoningEffort = this.configStore.get('codexReasoningEffort') as string;
            if (reasoningEffort) {
                lines.push(`model_reasoning_effort = "${reasoningEffort}"`);
            }
            const verbosity = this.configStore.get('codexVerbosity') as string;
            if (verbosity) {
                lines.push(`model_verbosity = "${verbosity}"`);
            }
            lines.push('model_context_window = 1000000');
            lines.push('model_auto_compact_token_limit = 9000000');
            lines.push('check_for_update_on_startup = false');

            // Bypass all approval prompts and sandbox when the user has opted in.
            if (this.configStore.get('codexBypassPermissions')) {
                lines.push('approval_policy = "never"');
                lines.push('sandbox_mode = "danger-full-access"');
            }

            // ── Sections ──
            if (baseUrl) {
                const providerName = '4routerai';
                lines.push('');
                lines.push(`[model_providers.${providerName}]`);
                lines.push(`name = "${providerName}"`);
                lines.push(`base_url = "${baseUrl}"`);
                lines.push(`wire_api = "responses"`);
                // Codex >=0.148 sends NO Authorization header for a custom
                // provider unless the provider opts into one of its auth
                // mechanisms — see model-provider/src/auth.rs:
                //   if !provider.requires_openai_auth && provider.auth.is_none()
                //       { return unauthenticated_auth_provider() }
                // Without this flag every request fails with
                // `401 Unauthorized: 未提供令牌`. Setting it makes codex read the
                // key from auth.json (auth_mode = "apikey", written below),
                // which keeps the key out of the child process environment.
                // Accepted by older releases too (verified on 0.147.0).
                lines.push('requires_openai_auth = true');
            }

            lines.push('');
            lines.push('[analytics]');
            lines.push('enabled = false');

            // ── Preserve user preferences from existing config ──
            const configFile = path.join(codexHomeDir, 'config.toml');
            let userConfig = '';
            if (fs.existsSync(configFile)) {
                try {
                    userConfig = preserveUserConfig(fs.readFileSync(configFile, 'utf-8'));
                } catch (e) {
                    console.warn(`[ToolManager] Failed to read existing config.toml, starting fresh:`, e);
                }
            }

            const configToml = lines.join('\n') + '\n' + userConfig;
            fs.writeFileSync(configFile, configToml, 'utf-8');
            console.log(`[ToolManager] Wrote Codex config to ${configFile}`);

            // Tell codex to use our isolated config directory.
            env['CODEX_HOME'] = codexHomeDir;

            // Write API key into auth.json — codex's native credential
            // storage format (see codex-rs/login/src/auth/manager.rs).
            // This avoids relying on the OPENAI_API_KEY env var which
            // could leak into child processes.
            if (apiKey) {
                const authJson = {
                    auth_mode: 'apikey',
                    OPENAI_API_KEY: apiKey,
                };
                const authFile = path.join(codexHomeDir, 'auth.json');
                fs.writeFileSync(authFile, JSON.stringify(authJson, null, 2), 'utf-8');
                console.log(`[ToolManager] Wrote Codex auth to ${authFile}`);
            }

            // Since 0.157 Codex attaches the TUI to a shared background daemon
            // that outlives the session, runs its own auto-updated codex copy, and
            // keeps the API key and proxy env it was started with — key or proxy
            // changes made here wouldn't reach it until it restarts. On Windows it
            // also aborts startup with `failed to open daemon process (os error 5)`
            // once a stale daemon.pid names a PID reused by a process we can't open.
            if (tool.version && compareVersions(tool.version, CODEX_NO_DAEMON_MIN_VERSION) >= 0) {
                args.push('--no-daemon');
            }
        }

        // Proxy
        const proxy = this.configStore.get('proxy') as string | undefined;
        if (proxy) {
            env['HTTP_PROXY'] = proxy;
            env['HTTPS_PROXY'] = proxy;
        }

        console.log(`[ToolManager] Launch: ${toolId}`, {
            bin: result.launchMode === 'node-script' ? this.getBundledNodeExecutable() : result.path,
            args,
            hasApiKey: !!apiKey,
            hasBaseUrl: !!baseUrl,
        });

        if (result.launchMode === 'node-script') {
            return { bin: this.getBundledNodeExecutable(), args: [result.path, ...args], env };
        }

        return { bin: result.path, args, env };
    }

    /**
     * Check if a newer version is available by querying npm registry.
     */
    async checkUpdate(toolId: string): Promise<{ hasUpdate: boolean; currentVersion: string; latestVersion: string }> {
        const tool = this.toolDefinitions.find(t => t.id === toolId);
        if (!tool || !tool.version) {
            return { hasUpdate: false, currentVersion: 'unknown', latestVersion: 'unknown' };
        }

        const packageName = toolId === 'claude-code'
            ? '@anthropic-ai/claude-code'
            : '@openai/codex';

        if (!this.hasBundledRuntime()) {
            return { hasUpdate: false, currentVersion: tool.version, latestVersion: 'unknown' };
        }

        // Same version choice as updateTool (pickTargetVersion): the version
        // of the registry it will be downloaded from — npmmirror unless a
        // proxy is set. updateTool then pins that exact version, so the
        // version seen here is the version that gets installed.
        const [official, mirror] = await this.probeLatestVersions(packageName);
        const latest = pickTargetVersion(official, mirror, !!this.getProxy());
        if (!latest) {
            return { hasUpdate: false, currentVersion: tool.version, latestVersion: 'unknown' };
        }

        // A mirror can lag behind the official registry and report an older
        // version; treating "different" as "newer" would offer a downgrade.
        const hasUpdate = isNewerVersion(latest, tool.version);
        console.log(`[ToolManager] ${toolId}: current=${tool.version}, latest=${latest}, hasUpdate=${hasUpdate}`);
        return { hasUpdate, currentVersion: tool.version, latestVersion: latest };
    }

    /** The settings-page proxy (e.g. http://127.0.0.1:7890), if any. */
    private getProxy(): string | undefined {
        const proxy = (this.configStore.get('proxy') as string | undefined)?.trim();
        return proxy || undefined;
    }

    /**
     * Ask both registries for `latest` at the same time and time each
     * answer. Concurrent, so an unreachable official registry costs one
     * NPM_VIEW_TIMEOUT_MS instead of delaying the mirror query behind it.
     * Going through npm (rather than a hand-rolled HTTPS GET) means the
     * probe uses the same proxy handling as the install that follows.
     */
    private probeLatestVersions(packageName: string): Promise<[RegistryProbe, RegistryProbe]> {
        const probe = async (registry: string): Promise<RegistryProbe> => {
            const start = Date.now();
            const version = await this.npmViewVersion(packageName, registry);
            return { registry, version, elapsedMs: Date.now() - start };
        };
        return Promise.all([probe(OFFICIAL_REGISTRY), probe(CHINA_MIRROR_REGISTRY)]);
    }

    private npmViewVersion(packageName: string, registry: string): Promise<string | null> {
        return new Promise((resolve) => {
            const args = [
                this.getBundledNpmCli(), 'view', packageName, 'version',
                ...buildNpmNetworkArgs(registry, this.getProxy()),
            ];
            this.runFile(this.getBundledNodeExecutable(), args, {
                timeout: NPM_VIEW_TIMEOUT_MS,
                windowsHide: true,
                env: buildSanitizedEnv(this.buildRuntimeEnv()),
            }, (error, stdout) => {
                resolve(error || !stdout.trim() ? null : stdout.trim());
            });
        });
    }

    /** `optionalDependencies` of an exact version, or null if the query failed. */
    private npmViewOptionalDeps(spec: string, registry: string): Promise<Record<string, string> | null> {
        return new Promise((resolve) => {
            const args = [
                this.getBundledNpmCli(), 'view', spec, 'optionalDependencies', '--json',
                ...buildNpmNetworkArgs(registry, this.getProxy()),
            ];
            this.runFile(this.getBundledNodeExecutable(), args, {
                timeout: NPM_VIEW_TIMEOUT_MS,
                windowsHide: true,
                env: buildSanitizedEnv(this.buildRuntimeEnv()),
            }, (error, stdout) => {
                try {
                    resolve(error ? null : JSON.parse(stdout));
                } catch {
                    resolve(null);
                }
            });
        });
    }

    /**
     * Update a bundled tool to the latest version by running
     * `npm install <package>@<version>` in the tool's bundled directory.
     */
    async updateTool(toolId: string): Promise<{ success: boolean; version?: string; error?: string }> {
        const tool = this.toolDefinitions.find(t => t.id === toolId);
        if (!tool) return { success: false, error: 'Unknown tool' };

        if (!this.hasBundledRuntime()) {
            return { success: false, error: 'Bundled Node.js runtime is missing' };
        }

        const packageName = toolId === 'claude-code'
            ? '@anthropic-ai/claude-code'
            : '@openai/codex';

        const toolDir = path.join(this.bundledToolsPath,
            toolId === 'claude-code' ? 'claude-code' : 'codex');
        const previousVersion = tool.broken ? undefined : tool.version;
        const fail = (error?: string, failure?: FsFailure | null) =>
            this.updateFailure(tool, previousVersion, toolDir, error, failure);

        // Before any network round trip: npm would only hit EPERM after the
        // version probes.
        if (!this.canWrite(toolDir, packageName)) {
            return fail(undefined, 'no-permission');
        }

        if (!fs.existsSync(toolDir)) {
            fs.mkdirSync(toolDir, { recursive: true });
        }

        // Ensure package.json exists (npm install requires it)
        const pkgJsonPath = path.join(toolDir, 'package.json');
        if (!fs.existsSync(pkgJsonPath)) {
            fs.writeFileSync(pkgJsonPath, '{"private":true}', 'utf-8');
        }

        // Pin the version first, then install it from the registry
        // planInstall puts first (npmmirror unless a proxy is set). The other
        // registry is the fallback (a lagging mirror fails fast with
        // ETARGET), unless the failure is one a different registry can't
        // fix: a permission error or a locked file, or a timeout the official
        // registry would only repeat (retryAfterTimeout).
        const viaProxy = !!this.getProxy();
        const [official, mirror] = await this.probeLatestVersions(packageName);
        const plan = planInstall(official, mirror, viaProxy);
        const spec = `${packageName}@${plan.spec}`;
        const [primary, secondary] = plan.registries;

        // Name the native-binary package explicitly so a dropped download
        // fails the install (and npm rolls back) instead of silently leaving
        // a tool without its binary — see platformInstallSpec.
        const specs = [spec];
        const platformPkg = platformPackageName(packageName, os.platform(), os.arch());
        if (platformPkg && plan.spec !== 'latest') {
            const optional = await this.npmViewOptionalDeps(spec, primary)
                ?? await this.npmViewOptionalDeps(spec, secondary);
            const platformSpec = platformInstallSpec(optional, platformPkg);
            if (platformSpec) {
                specs.push(platformSpec);
            } else {
                console.warn(`[ToolManager] Could not resolve ${platformPkg} for ${spec}; relying on optional dependencies`);
            }
        }

        console.log(`[ToolManager] Updating ${toolId} in ${toolDir}`);
        console.log(`[ToolManager] Packages: ${specs.join(' ')}`, {
            official: `${official.version ?? 'unreachable'} (${official.elapsedMs}ms)`,
            npmmirror: `${mirror.version ?? 'unreachable'} (${mirror.elapsedMs}ms)`,
            order: plan.registries.map(registryLabel),
            viaProxy,
        });

        let used = primary;
        const result = await this.npmInstall(specs, toolDir, primary);
        if (!result.success) {
            if (classifyFsFailure(result.error || '') || (result.timedOut && !retryAfterTimeout(secondary))) {
                return fail(result.error);
            }

            console.log(`[ToolManager] Install from ${registryLabel(primary)} failed, retrying with ${registryLabel(secondary)}...`);
            const retry = await this.npmInstall(specs, toolDir, secondary);
            if (!retry.success) {
                return fail(`Install failed from both the ${registryLabel(primary)} and ${registryLabel(secondary)}.\n--- ${registryLabel(primary)} ---\n${result.error}\n--- ${registryLabel(secondary)} ---\n${retry.error}`);
            }
            used = secondary;
        }

        // The launcher needs the platform package's package.json, at the
        // main package's version. If it's not there (an unpinned install, or
        // a registry that lags on the platform packages), retry once with
        // the other registry.
        if (!this.platformPackageOk(toolId)) {
            const other = used === OFFICIAL_REGISTRY ? CHINA_MIRROR_REGISTRY : OFFICIAL_REGISTRY;
            console.log(`[ToolManager] ${toolId} platform package missing after install, retrying with ${registryLabel(other)}...`);
            const fallback = await this.npmInstall(specs, toolDir, other);
            if (!fallback.success) return fail(fallback.error);
            if (!this.platformPackageOk(toolId)) {
                return fail('Platform-specific binary still missing after fallback install');
            }
        }

        this.detectTools();
        const updated = this.toolDefinitions.find(t => t.id === toolId);
        return { success: true, version: updated?.version || 'unknown' };
    }

    /**
     * Whether npm can write where it will start writing: a temp directory
     * next to the installed package. Under Program Files (a machine-wide
     * install) the app, which never runs elevated, can't.
     */
    private canWrite(toolDir: string, packageName: string): boolean {
        const scopeDir = path.join(toolDir, 'node_modules', packageName.split('/')[0]);
        const dir = [scopeDir, path.dirname(scopeDir), toolDir, this.bundledToolsPath].find(d => fs.existsSync(d));
        if (!dir) return true;
        const probe = path.join(dir, `.4router-write-test-${process.pid}-${Date.now()}`);
        try {
            fs.mkdirSync(probe);
            fs.rmdirSync(probe);
            return true;
        } catch (err: any) {
            console.warn(`[ToolManager] ${dir} is not writable:`, err?.code || err);
            return !(err?.code === 'EPERM' || err?.code === 'EACCES');
        }
    }

    /**
     * A failed update, worded for the user: whether the tool still works (npm
     * rolled back to the previous version) or needs another try, plus what to
     * do about a permission problem or locked files. Raw npm output follows.
     */
    private updateFailure(
        tool: ToolInfo,
        previousVersion: string | undefined,
        toolDir: string,
        error?: string,
        failure: FsFailure | null = classifyFsFailure(error || ''),
    ) {
        this.detectTools();
        const lines: string[] = [];
        if (!tool.broken && tool.version && tool.version === previousVersion) {
            lines.push(`${tool.name} 更新未完成，已保留原来的版本 ${tool.version}，可以继续使用。`);
        } else if (tool.broken) {
            lines.push(`${tool.name} 更新未完成，原生程序不完整，网络好一些时请点击版本号重试修复。`);
        } else {
            lines.push(`${tool.name} 更新未完成。`);
        }
        if (failure === 'no-permission') {
            lines.push(`安装目录没有写入权限（${toolDir}）：4RouterAi 可能装在了「所有用户」目录（如 C:\\Program Files）。请卸载后重新安装，安装时保持默认目录。`);
        } else if (failure === 'locked') {
            lines.push(`文件被占用：请关闭所有 ${tool.name} 标签页后重试。`);
        } else if (failure === 'locked-or-no-permission') {
            lines.push(`文件被占用或没有写入权限：请先关闭所有 ${tool.name} 标签页再试；仍然失败的话，卸载后重新安装到默认目录。`);
        }
        if (error) lines.push('', error);
        return { success: false, version: tool.version, error: lines.join('\n') };
    }

    private npmInstall(
        specs: string[],
        cwd: string,
        registry: string,
    ): Promise<{ success: boolean; error?: string; timedOut?: boolean }> {
        return new Promise((resolve) => {
            const npmExec = this.getBundledNodeExecutable();
            const proxy = this.getProxy();
            const commandArgs = [this.getBundledNpmCli(), ...buildNpmInstallArgs(specs, registry, proxy)];
            // The proxy URL may carry credentials; keep it out of the log.
            const loggedArgs = commandArgs.map(arg => arg === proxy ? '<proxy>' : arg);
            console.log(`[ToolManager] Running: ${npmExec} ${loggedArgs.join(' ')}`);

            this.runFile(npmExec, commandArgs, {
                cwd,
                timeout: NPM_INSTALL_TIMEOUT_MS,
                env: buildSanitizedEnv(this.buildRuntimeEnv()),
                windowsHide: true,
            }, (error: any, stdout: string, stderr: string) => {
                const output = (stdout || '') + (stderr || '');
                console.log(`[ToolManager] Install output:`, output);
                if (!error) {
                    resolve({ success: true });
                    return;
                }
                // A timeout kill surfaces as a bare `Command failed … ` with
                // no npm error in the output — say what actually happened.
                if (isTimeoutKill(error)) {
                    console.error(`[ToolManager] Install timed out after ${NPM_INSTALL_TIMEOUT_MS}ms (${registryLabel(registry)})`);
                    resolve({ success: false, error: describeInstallTimeout(proxy), timedOut: true });
                    return;
                }
                let msg = `${error.message}\n${output}`.trim();
                if (proxy) msg = msg.split(proxy).join('<proxy>');
                console.error(`[ToolManager] Install failed:`, msg);
                resolve({ success: false, error: msg });
            });
        });
    }
}
