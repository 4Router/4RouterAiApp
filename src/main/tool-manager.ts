import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { ConfigStore } from './config-store';
import { buildSanitizedEnv } from './process-env';

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
            case 'claude-code':
                return path.join(toolDir, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
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
            if (Object.keys(settings.env).length > 0) {
                const settingsDir = path.join(
                    process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
                    '4RouterAi'
                );
                fs.mkdirSync(settingsDir, { recursive: true });
                const settingsFile = path.join(settingsDir, 'claude-settings.json');
                fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2), 'utf-8');
                args.push('--settings', settingsFile);
                console.log(`[ToolManager] Wrote Claude settings to ${settingsFile}`);
            }
        } else if (tool.id === 'codex') {
            // codex -c model_provider="4routerai" -c 'model_providers.4routerai.base_url="..."'
            if (baseUrl) {
                const providerName = '4routerai';
                args.push('-c', `model_provider="${providerName}"`);
                args.push('-c', `model_providers.${providerName}.base_url="${baseUrl}"`);
                args.push('-c', `model_providers.${providerName}.name="${providerName}"`);
                args.push('-c', `model_providers.${providerName}.requires_openai_auth=true`);
                args.push('-c', `model_providers.${providerName}.wire_api="responses"`);
            }
            // API key via env var (codex reads OPENAI_API_KEY from env)
            if (apiKey) {
                env[tool.envKeyName] = apiKey;
            }
            if (model) {
                args.push('-c', `model="${model}"`);
            }
            const reasoningEffort = this.configStore.get('codexReasoningEffort') as string;
            if (reasoningEffort) {
                args.push('-c', `model_reasoning_effort="${reasoningEffort}"`);
            }
            const verbosity = this.configStore.get('codexVerbosity') as string;
            if (verbosity) {
                args.push('-c', `model_verbosity="${verbosity}"`);
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

        return new Promise((resolve) => {
            const { execFile } = require('child_process') as typeof import('child_process');
            const npmExec = this.getBundledNodeExecutable();
            const npmCli = this.getBundledNpmCli();
            if (!this.hasBundledRuntime()) {
                resolve({ hasUpdate: false, currentVersion: tool.version!, latestVersion: 'unknown' });
                return;
            }

            execFile(npmExec, [npmCli, 'view', packageName, 'version'], {
                timeout: 15000,
                windowsHide: true,
                env: buildSanitizedEnv(this.buildRuntimeEnv()),
            }, (error, stdout) => {
                if (error || !stdout.trim()) {
                    resolve({ hasUpdate: false, currentVersion: tool.version!, latestVersion: 'unknown' });
                    return;
                }
                const latest = stdout.trim();
                const hasUpdate = latest !== tool.version;
                console.log(`[ToolManager] ${toolId}: current=${tool.version}, latest=${latest}, hasUpdate=${hasUpdate}`);
                resolve({ hasUpdate, currentVersion: tool.version!, latestVersion: latest });
            });
        });
    }

    /**
     * Update a bundled tool to the latest version by running
     * `npm install <package>@latest` in the tool's bundled directory.
     */
    async updateTool(toolId: string): Promise<{ success: boolean; version?: string; error?: string }> {
        const tool = this.toolDefinitions.find(t => t.id === toolId);
        if (!tool) return { success: false, error: 'Unknown tool' };

        const packageName = toolId === 'claude-code'
            ? '@anthropic-ai/claude-code'
            : '@openai/codex';

        const toolDir = path.join(this.bundledToolsPath,
            toolId === 'claude-code' ? 'claude-code' : 'codex');

        if (!fs.existsSync(toolDir)) {
            fs.mkdirSync(toolDir, { recursive: true });
        }

        // Ensure package.json exists (npm install requires it)
        const pkgJsonPath = path.join(toolDir, 'package.json');
        if (!fs.existsSync(pkgJsonPath)) {
            fs.writeFileSync(pkgJsonPath, '{"private":true}', 'utf-8');
        }

        console.log(`[ToolManager] Updating ${toolId} in ${toolDir}`);
        console.log(`[ToolManager] Package: ${packageName}@latest`);

        const result = await this.npmInstall(packageName, toolDir);
        if (!result.success) return result;

        // @openai/codex distributes platform binaries via dist-tag versions
        // (e.g. npm:@openai/codex@0.111.0-win32-x64). Chinese mirrors like
        // npmmirror may lag behind on syncing these. If the platform package
        // is missing after install, retry with the official npm registry.
        if (toolId === 'codex' && !this.hasCodexPlatformPackage(toolDir)) {
            console.log('[ToolManager] Codex platform package missing after install, retrying with official registry...');
            const fallback = await this.npmInstall(packageName, toolDir, 'https://registry.npmjs.org/');
            if (!fallback.success) return fallback;

            if (!this.hasCodexPlatformPackage(toolDir)) {
                return { success: false, error: 'Platform-specific binary still missing after fallback install' };
            }
        }

        this.detectTools();
        const updated = this.toolDefinitions.find(t => t.id === toolId);
        return { success: true, version: updated?.version || 'unknown' };
    }

    private npmInstall(
        packageName: string,
        cwd: string,
        registry?: string,
    ): Promise<{ success: boolean; error?: string }> {
        return new Promise((resolve) => {
            const { execFile } = require('child_process') as typeof import('child_process');
            if (!this.hasBundledRuntime()) {
                resolve({ success: false, error: 'Bundled Node.js runtime is missing' });
                return;
            }

            const npmExec = this.getBundledNodeExecutable();
            const npmCli = this.getBundledNpmCli();
            const commandArgs = [npmCli, 'install', `${packageName}@latest`];
            if (registry) {
                commandArgs.push('--registry', registry);
            }
            console.log(`[ToolManager] Running: ${npmExec} ${commandArgs.join(' ')}`);

            execFile(npmExec, commandArgs, {
                cwd,
                timeout: 120000,
                env: buildSanitizedEnv(this.buildRuntimeEnv()),
                windowsHide: true,
            }, (error: any, stdout: string, stderr: string) => {
                const output = (stdout || '') + (stderr || '');
                console.log(`[ToolManager] Install output:`, output);
                if (error) {
                    const msg = `${error.message}\n${output}`.trim();
                    console.error(`[ToolManager] Install failed:`, msg);
                    resolve({ success: false, error: msg });
                } else {
                    resolve({ success: true });
                }
            });
        });
    }

    private hasCodexPlatformPackage(toolDir: string): boolean {
        const PLATFORM_PKG: Record<string, Record<string, string>> = {
            win32:  { x64: 'codex-win32-x64', arm64: 'codex-win32-arm64' },
            darwin: { x64: 'codex-darwin-x64', arm64: 'codex-darwin-arm64' },
            linux:  { x64: 'codex-linux-x64',  arm64: 'codex-linux-arm64' },
        };
        const pkgName = PLATFORM_PKG[os.platform()]?.[os.arch()];
        if (!pkgName) return true; // unknown platform, skip check
        const pkgDir = path.join(toolDir, 'node_modules', '@openai', pkgName);
        const exists = fs.existsSync(pkgDir);
        console.log(`[ToolManager] Platform package check: ${pkgDir} → ${exists}`);
        return exists;
    }
}
