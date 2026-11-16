import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Login-shell environment recovery for macOS (and other POSIX desktops).
 *
 * An app started from Finder, the Dock or Spotlight is spawned by launchd with
 * a bare environment: PATH is `/usr/bin:/bin:/usr/sbin:/sbin` and nothing the
 * user set up in ~/.zprofile / ~/.zshrc (Homebrew, nvm, pyenv, cargo…) is
 * visible. Every tool we spawn — Claude Code, Codex and the commands *they*
 * run — would then fail to find `brew`, `python3`, a project's `node`, etc.
 *
 * Same approach as VS Code: run the user's login shell once, have it print its
 * environment, and fold the result back into process.env before the first
 * session starts. The interactive flag is needed because many setups (nvm,
 * oh-my-zsh) only extend PATH from the rc file, not the profile.
 */

const RESOLVE_TIMEOUT_MS = 10_000;

/** Keys that describe the probe itself rather than the user's environment. */
const SKIP_KEYS = new Set([
    'ELECTRON_RUN_AS_NODE',
    'ELECTRON_NO_ATTACH_CONSOLE',
    'PWD',
    'OLDPWD',
    'SHLVL',
    '_',
]);

let pending: Promise<void> | null = null;

/** The user's login shell, falling back to the platform default. */
export function userShell(): string {
    const shell = process.env.SHELL;
    if (shell && fs.existsSync(shell)) return shell;
    if (os.platform() === 'darwin') return '/bin/zsh';
    return fs.existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh';
}

/**
 * Merge the login shell's environment into process.env. Safe to call many
 * times — the shell is only spawned once. Never rejects: on any failure the
 * current environment is kept as-is.
 */
export function resolveShellEnv(): Promise<void> {
    if (os.platform() === 'win32') return Promise.resolve();
    if (!pending) {
        pending = probeShellEnv()
            .then((env) => {
                if (env) mergeShellEnv(env);
            })
            .catch((err) => {
                console.warn('[ShellEnv] failed to resolve login shell environment:', err);
            })
            .finally(ensureUtf8Locale);
    }
    return pending;
}

function probeShellEnv(): Promise<Record<string, string> | null> {
    return new Promise((resolve) => {
        const shell = userShell();
        const name = path.basename(shell);
        const mark = `__4ROUTERAI_ENV_${Math.random().toString(36).slice(2)}__`;
        // Re-run this very binary as plain Node to serialise the env: unlike
        // `env`, JSON survives values that contain newlines.
        const nodeExpr = `"${mark}" + JSON.stringify(process.env) + "${mark}"`;
        const command = `'${process.execPath.replace(/'/g, `'\\''`)}' -p '${nodeExpr}'`;
        const args = name === 'tcsh' || name === 'csh'
            ? ['-ic', command]
            : ['-i', '-l', '-c', command];

        const child = spawn(shell, args, {
            detached: true, // own process group: an interactive shell must not grab our tty
            stdio: ['ignore', 'pipe', 'pipe'],
            env: {
                ...process.env,
                ELECTRON_RUN_AS_NODE: '1',
                ELECTRON_NO_ATTACH_CONSOLE: '1',
            },
        });

        let stdout = '';
        let settled = false;
        const finish = (value: Record<string, string> | null) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(value);
        };

        const timer = setTimeout(() => {
            console.warn(`[ShellEnv] ${shell} did not answer within ${RESOLVE_TIMEOUT_MS}ms, keeping launch environment`);
            try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* already gone */ }
            finish(null);
        }, RESOLVE_TIMEOUT_MS);

        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk: string) => { stdout += chunk; });
        child.stderr.resume();
        child.on('error', (err) => {
            console.warn('[ShellEnv] could not start login shell:', err);
            finish(null);
        });
        child.on('close', () => {
            const start = stdout.indexOf(mark);
            const end = stdout.lastIndexOf(mark);
            if (start < 0 || end <= start) {
                finish(null);
                return;
            }
            try {
                finish(JSON.parse(stdout.slice(start + mark.length, end)));
            } catch {
                finish(null);
            }
        });
    });
}

function mergeShellEnv(shellEnv: Record<string, string>): void {
    let added = 0;
    for (const [key, value] of Object.entries(shellEnv)) {
        if (SKIP_KEYS.has(key) || typeof value !== 'string') continue;
        // PATH is the whole point — always take the shell's. Anything else the
        // app already has (set by launchd or by a terminal that started us)
        // wins, so we never clobber Electron's own variables.
        if (key === 'PATH' || process.env[key] === undefined) {
            if (process.env[key] !== value) added++;
            process.env[key] = value;
        }
    }
    console.log(`[ShellEnv] merged login shell environment (${added} change(s)), PATH=${process.env.PATH}`);
}

/**
 * GUI apps get no LANG at all. Without one, zsh renders non-ASCII input as
 * `<00e4>` escapes and CLI tools fall back to the C locale — pick a UTF-8
 * locale that actually exists on this machine.
 */
function ensureUtf8Locale(): void {
    if (process.env.LANG || process.env.LC_ALL || process.env.LC_CTYPE) return;
    const candidates: string[] = [];
    const sys = Intl.DateTimeFormat().resolvedOptions().locale || '';
    const match = /^([a-z]{2,3})[-_]([A-Z]{2})/.exec(sys)
        || /^([a-z]{2,3})[-_](?:[A-Za-z]{4}[-_])?([A-Z]{2})/.exec(sys);
    if (match) candidates.push(`${match[1]}_${match[2]}.UTF-8`);
    candidates.push('en_US.UTF-8');
    const lang = candidates.find(c => fs.existsSync(path.join('/usr/share/locale', c))) || 'en_US.UTF-8';
    process.env.LANG = lang;
    console.log(`[ShellEnv] LANG was unset, using ${lang}`);
}
