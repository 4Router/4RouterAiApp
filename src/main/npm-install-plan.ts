/**
 * Pure decisions behind ToolManager's npm calls — which registry to install
 * from, which version, and with which network flags. Kept free of
 * child_process / fs so scripts/verify-tool-update.cjs can test them directly.
 */

export const OFFICIAL_REGISTRY = 'https://registry.npmjs.org/';
export const CHINA_MIRROR_REGISTRY = 'https://registry.npmmirror.com/';

/**
 * Hard cap on one `npm install` run. Both tools ship their native binary as
 * a platform package, and those tarballs are big: claude-code-win32-x64 is
 * ~136 MB, codex-win32-x64 ~173 MB. The old 2-minute cap needed a sustained
 * 1.1–1.4 MB/s just to finish the download, so on slow links npm was always
 * SIGTERM'd mid-way — then the mirror retry got killed too. 30 minutes still
 * finishes at ~100 KB/s; a stalled connection is cut off sooner by npm's own
 * fetch-timeout (default 5 min — applied as the socket idle timeout, not a
 * cap on total transfer time) and then retried.
 */
export const NPM_INSTALL_TIMEOUT_MS = 30 * 60 * 1000;

/** `npm view` only fetches metadata; keep the probe short. */
export const NPM_VIEW_TIMEOUT_MS = 15000;

/**
 * npm retries failed registry requests (ECONNRESET, ETIMEDOUT, 5xx …) with
 * backoff. The default of 2 gives up quickly on flaky links; 4 rides out a
 * few resets at a worst-case ~3 minutes of backoff (10 s, then 60 s each).
 */
const NPM_FETCH_RETRIES = 4;

/**
 * How long a registry request may sit without receiving data before npm
 * gives up on it and retries. npm's default is 5 minutes, so a stalled
 * tarball burned 5 minutes per attempt and a few stalls used up the whole
 * NPM_INSTALL_TIMEOUT_MS. It is an idle timeout, so a slow but moving
 * download is not cut off.
 */
const NPM_FETCH_TIMEOUT_MS = 2 * 60 * 1000;

export interface RegistryProbe {
    registry: string;
    /** `latest` version this registry reported, or null if the query failed. */
    version: string | null;
    elapsedMs: number;
}

export interface InstallPlan {
    /** What goes after `pkg@`: an exact version, or `latest` when unknown. */
    spec: string;
    /** Registries to try, in order. */
    registries: [string, string];
}

/**
 * Flags shared by every npm call. `--registry` overrides any user ~/.npmrc,
 * so every install behaves the same. The configured proxy goes on the
 * command line rather than through HTTP(S)_PROXY: buildSanitizedEnv only
 * passes an allow-list of variables to the child, and an explicit flag also
 * wins over whatever a user's npmrc says.
 */
export function buildNpmNetworkArgs(registry: string, proxy?: string): string[] {
    const args = ['--registry', registry];
    const trimmed = proxy?.trim();
    if (trimmed) {
        args.push('--proxy', trimmed, '--https-proxy', trimmed);
    }
    return args;
}

/**
 * Args after npm-cli.js for installing `specs` (e.g. `@openai/codex@0.163.0`
 * plus its platform package). --no-audit / --no-fund drop two extra registry
 * round-trips that do nothing for an embedded tool and only add waiting on a
 * slow link.
 */
export function buildNpmInstallArgs(specs: string[], registry: string, proxy?: string): string[] {
    return [
        'install', ...specs,
        ...buildNpmNetworkArgs(registry, proxy),
        '--fetch-retries', String(NPM_FETCH_RETRIES),
        '--fetch-timeout', String(NPM_FETCH_TIMEOUT_MS),
        '--no-audit',
        '--no-fund',
    ];
}

/**
 * The version the user is offered (checkUpdate) and the one updateTool
 * installs — whatever the registry it will come from serves.
 *
 * Without a proxy that is npmmirror: from mainland China the official
 * registry is often reachable but crawls, and the ~150 MB platform tarball
 * is exactly where that hurts. A mirror that hasn't synced the newest
 * release yet just means that release is offered a little later, rather
 * than downloaded from the slow registry. Through a proxy the official
 * registry is usable, so its version wins and the mirror only covers for it.
 */
export function pickTargetVersion(official: RegistryProbe, mirror: RegistryProbe, viaProxy: boolean): string | null {
    return viaProxy ? official.version ?? mirror.version : mirror.version ?? official.version;
}

/**
 * Decide what to install and from where. The version is pinned first
 * (pickTargetVersion); the other registry stays as the fallback.
 *
 * Without a proxy the mirror goes first whenever it answered. A timing race
 * isn't used here: the probe is one small metadata request, and the official
 * registry winning it says nothing about how a 150 MB download will go.
 * Through a proxy the faster probe goes first, but npmmirror only leads when
 * it already has the target; a lagging mirror would just fail with ETARGET.
 *
 * When neither probe answered the network is in bad shape and nothing can be
 * pinned; install `latest` from the mirror first.
 */
export function planInstall(official: RegistryProbe, mirror: RegistryProbe, viaProxy: boolean): InstallPlan {
    const officialFirst: [string, string] = [OFFICIAL_REGISTRY, CHINA_MIRROR_REGISTRY];
    const mirrorFirst: [string, string] = [CHINA_MIRROR_REGISTRY, OFFICIAL_REGISTRY];

    const target = pickTargetVersion(official, mirror, viaProxy);
    if (!target) {
        return { spec: 'latest', registries: mirrorFirst };
    }
    if (!official.version || !viaProxy) {
        return { spec: target, registries: mirror.version === target ? mirrorFirst : officialFirst };
    }
    if (mirror.version !== target) {
        return { spec: target, registries: officialFirst };
    }
    return {
        spec: target,
        registries: mirror.elapsedMs < official.elapsedMs ? mirrorFirst : officialFirst,
    };
}

/**
 * Whether to try the other registry after an install timed out. A timeout
 * means the link was too slow for that registry, which npmmirror can still
 * beat; the official registry won't beat a mirror that already timed out,
 * and would only add another NPM_INSTALL_TIMEOUT_MS of waiting.
 */
export function retryAfterTimeout(next: string): boolean {
    return next === CHINA_MIRROR_REGISTRY;
}

export type FsFailure = 'no-permission' | 'locked' | 'locked-or-no-permission';

/**
 * What a failed npm install's EPERM / EACCES / EBUSY means for the user,
 * judged from npm's `code` and `syscall` lines. On Windows, creating a
 * directory fails with EPERM only for lack of permission (npm's first step
 * is mkdir of a fresh temp name next to the old package, which nothing can
 * be holding), while renaming or deleting fails with EPERM when the file is
 * in use — a running claude.exe. Null for every other failure.
 */
export function classifyFsFailure(output: string): FsFailure | null {
    const code = /\b(EPERM|EACCES|EBUSY)\b/.exec(output)?.[1];
    if (!code) return null;
    if (code === 'EBUSY') return 'locked';
    if (code === 'EACCES') return 'no-permission';
    const syscall = /npm (?:error|ERR!) syscall (\w+)/.exec(output)?.[1];
    if (syscall === 'mkdir' || syscall === 'open' || syscall === 'copyfile') return 'no-permission';
    if (syscall === 'rename' || syscall === 'unlink' || syscall === 'rmdir') return 'locked';
    return 'locked-or-no-permission';
}

/**
 * True when execFile killed the child because `timeout` elapsed. Node also
 * sets `killed` when stdout overflows maxBuffer, so rule that case out.
 */
export function isTimeoutKill(error: any): boolean {
    return !!error && error.killed === true && error.code !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
}

export function describeInstallTimeout(proxy?: string): string {
    const minutes = Math.round(NPM_INSTALL_TIMEOUT_MS / 60000);
    const hint = proxy?.trim()
        ? '请检查设置中的代理是否可用后重试'
        : '网络较慢时可在设置中配置代理后重试';
    return `下载超时（${minutes} 分钟内未完成），${hint}`;
}

export function registryLabel(registry: string): string {
    return registry === CHINA_MIRROR_REGISTRY ? 'npmmirror' : 'official registry';
}

/**
 * Name of the package carrying the native binary for this machine, e.g.
 * `@anthropic-ai/claude-code-win32-x64`, or `@openai/codex-win32-x64` (an npm
 * alias for `@openai/codex@<ver>-win32-x64`). Null where neither tool ships one.
 */
export function platformPackageName(packageName: string, platform: string, arch: string): string | null {
    const supported: Record<string, string[]> = {
        win32: ['x64', 'arm64'],
        darwin: ['x64', 'arm64'],
        linux: ['x64', 'arm64'],
    };
    return supported[platform]?.includes(arch) ? `${packageName}-${platform}-${arch}` : null;
}

/**
 * `name@spec` for installing the platform package explicitly, taken from the
 * main package's optionalDependencies: "2.1.310" for Claude Code, an
 * `npm:@openai/codex@0.164.0-win32-x64` alias for Codex.
 *
 * Why explicitly: as an optional dependency, a platform tarball that fails to
 * download — the ~150 MB part, so the part a weak link drops — is skipped
 * with exit code 0. npm still swaps in the new main package and deletes the
 * old binary, leaving a tool that dies with `Could not find native binary
 * package`. Named on the command line it is a hard dependency: the failure
 * fails the install, and npm rolls back to the previous, working version.
 */
export function platformInstallSpec(optionalDeps: unknown, platformPkg: string): string | null {
    if (!optionalDeps || typeof optionalDeps !== 'object') return null;
    const spec = (optionalDeps as Record<string, unknown>)[platformPkg];
    return typeof spec === 'string' && spec ? `${platformPkg}@${spec}` : null;
}

/** Platform package built for this main version ("0.164.0-win32-x64" counts for "0.164.0"). */
export function platformVersionMatches(platformVersion: unknown, mainVersion: unknown): boolean {
    if (typeof platformVersion !== 'string' || typeof mainVersion !== 'string' || !mainVersion) return false;
    return platformVersion === mainVersion || platformVersion.startsWith(`${mainVersion}-`);
}
