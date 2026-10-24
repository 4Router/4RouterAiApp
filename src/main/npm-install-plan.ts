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
 * Args after npm-cli.js for installing `spec` (e.g. `@openai/codex@0.163.0`).
 * --no-audit / --no-fund drop two extra registry round-trips that do
 * nothing for an embedded tool and only add waiting on a slow link.
 */
export function buildNpmInstallArgs(spec: string, registry: string, proxy?: string): string[] {
    return [
        'install', spec,
        ...buildNpmNetworkArgs(registry, proxy),
        '--fetch-retries', String(NPM_FETCH_RETRIES),
        '--no-audit',
        '--no-fund',
    ];
}

/**
 * The version the user is offered (checkUpdate) and the one updateTool
 * installs. The official registry is authoritative; npmmirror can lag, so
 * its answer is only used when the official registry couldn't be reached.
 */
export function pickTargetVersion(official: RegistryProbe, mirror: RegistryProbe): string | null {
    return official.version ?? mirror.version;
}

/**
 * Decide what to install and from where.
 *
 * The version is pinned first (pickTargetVersion), so the source no longer
 * decides *what* gets installed — only how fast. From mainland China the
 * official registry is often reachable but crawls, and the ~150 MB platform
 * tarballs are exactly where that hurts, so the faster of the two probes
 * goes first. npmmirror only leads when it already serves the target as
 * `latest`; if it is lagging it would just fail with ETARGET. The other
 * registry stays as the fallback.
 *
 * When neither probe answered the network is in bad shape and nothing can be
 * pinned; install `latest` from the mirror first, since for this app's users
 * the official registry is the one that is usually unreachable.
 */
export function planInstall(official: RegistryProbe, mirror: RegistryProbe): InstallPlan {
    const officialFirst: [string, string] = [OFFICIAL_REGISTRY, CHINA_MIRROR_REGISTRY];
    const mirrorFirst: [string, string] = [CHINA_MIRROR_REGISTRY, OFFICIAL_REGISTRY];

    const target = pickTargetVersion(official, mirror);
    if (!target) {
        return { spec: 'latest', registries: mirrorFirst };
    }
    if (!official.version) {
        return { spec: target, registries: mirrorFirst };
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
