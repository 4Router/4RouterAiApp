import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { spawn as ptySpawn, IPty } from 'node-pty';
import { ToolManager, LaunchConfig } from './tool-manager';
import { buildSanitizedEnv } from './process-env';

/** Per-session scrollback kept in main so late-joining clients can replay it.
 *  Measured in JS string length (UTF-16 units) to stay consistent with the
 *  byte-offset dedup the renderer does on replay. */
const MAX_BUFFER_CHARS = 256 * 1024;

interface PtySession {
    id: string;
    toolId: string;
    pty: IPty;
    cwd: string;
    /** Rolling tail of everything the pty has emitted (trimmed to MAX_BUFFER_CHARS). */
    buffer: string;
    /** Cumulative count of all chars ever emitted — the offset at buffer's end. */
    totalChars: number;
}

/** Lightweight session descriptor shared with clients for tab reconciliation. */
export interface SessionInfo {
    sessionId: string;
    toolId: string;
    cwd: string;
}

type DataCallback = (sessionId: string, data: string, endOffset: number) => void;
type ExitCallback = (sessionId: string, exitCode: number) => void;
type CreatedCallback = (session: SessionInfo) => void;
type ClosedCallback = (sessionId: string) => void;

/** Spawn a pty, preferring node-pty's bundled conpty.dll on Windows.
 *
 *  Windows 10's inbox ConPTY (frozen on 2019-era conhost) mishandles DECSTBM
 *  scroll-region sequences: region scrolls are re-rendered with absolute
 *  positioning instead of real scrolls, so lines pushed "off the top" never
 *  reach the host terminal's scrollback. Codex relies on DECSTBM to move chat
 *  history into scrollback — on Win10 the history silently vanished and the
 *  scrollbar never appeared. The conpty.dll shipped with node-pty (same build
 *  VS Code enables by default) carries the rewritten conhost and handles this
 *  correctly on every Windows version. */
function spawnPty(
    bin: string,
    args: string[],
    opts: { cwd: string; env: { [key: string]: string } },
): IPty {
    const base = { name: 'xterm-256color', cols: 120, rows: 30, ...opts };
    if (os.platform() !== 'win32') {
        return ptySpawn(bin, args, base);
    }
    try {
        return ptySpawn(bin, args, { ...base, useConptyDll: true });
    } catch (err) {
        // Bundled dll missing/blocked (e.g. AV quarantine) — inbox ConPTY
        // still beats no terminal at all.
        console.warn('[PtyManager] Bundled ConPTY unavailable, falling back to inbox ConPTY:', err);
        return ptySpawn(bin, args, base);
    }
}

/** Absolute path to Windows PowerShell, resolved from %SystemRoot%.
 *
 *  node-pty resolves a *relative* program name (e.g. 'powershell.exe') by
 *  searching the host process's OWN `Path` (conpty.cc → get_shell_path) — not
 *  the env we hand it for the child. On machines whose `Path` is missing
 *  `…\System32\WindowsPowerShell\v1.0\` — dropped by a legacy PATH editor that
 *  truncates the registry value, a stripped corporate image, or an empty
 *  inherited environment — that search returns nothing and node-pty throws
 *  `File not found:` before the tool can even launch (surfaced to the renderer
 *  as `Error invoking remote method 'pty:create'`). Handing node-pty an
 *  absolute path skips the PATH search entirely (it trusts the path verbatim
 *  when PathIsRelativeW is false). The historical `v1.0` folder is the current
 *  home of Windows PowerShell 5.1 and is present on every supported desktop
 *  Windows, so this resolves even when `Path` itself is broken. */
function windowsShellPath(): string {
    const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
    const pwsh = path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    // Last-resort fall back to the bare name — no worse than the old behaviour.
    return fs.existsSync(pwsh) ? pwsh : 'powershell.exe';
}

export class PtyManager {
    private sessions: Map<string, PtySession> = new Map();
    private dataCallbacks: DataCallback[] = [];
    private exitCallbacks: ExitCallback[] = [];
    private createdCallbacks: CreatedCallback[] = [];
    private closedCallbacks: ClosedCallback[] = [];
    private sessionCounter = 0;

    constructor(private toolManager: ToolManager) { }

    onData(callback: DataCallback): void {
        this.dataCallbacks.push(callback);
    }

    onExit(callback: ExitCallback): void {
        this.exitCallbacks.push(callback);
    }

    onCreated(callback: CreatedCallback): void {
        this.createdCallbacks.push(callback);
    }

    /** Fired when a session is explicitly destroyed by a client (tab closed),
     *  as opposed to the process exiting on its own. Lets every client drop the
     *  mirrored tab instead of leaving a dead one behind. */
    onClosed(callback: ClosedCallback): void {
        this.closedCallbacks.push(callback);
    }

    /** All live sessions, for clients to reconcile their tab list against. */
    listSessions(): SessionInfo[] {
        return Array.from(this.sessions.values()).map(s => ({
            sessionId: s.id,
            toolId: s.toolId,
            cwd: s.cwd,
        }));
    }

    /** Current scrollback for a session plus the offset at its end, so a client
     *  can write it and then resume the live stream without gaps or dupes. */
    getBuffer(sessionId: string): { data: string; endOffset: number } {
        const session = this.sessions.get(sessionId);
        if (!session) return { data: '', endOffset: 0 };
        return { data: session.buffer, endOffset: session.totalChars };
    }

    createSession(toolId: string, cwd?: string): string {
        const sessionId = `session-${++this.sessionCounter}-${Date.now()}`;
        const defaultCwd = path.join(os.homedir(), 'Documents', '4RouterAi');
        if (!cwd) {
            fs.mkdirSync(defaultCwd, { recursive: true });
        }
        const workingDir = cwd || defaultCwd;

        const isWin = os.platform() === 'win32';
        const shellEnv: { [key: string]: string } = {
            ...process.env as { [key: string]: string },
            TERM: 'xterm-256color',
            COLORTERM: 'truecolor',
        };
        const toolBaseEnv = buildSanitizedEnv({
            TERM: 'xterm-256color',
            COLORTERM: 'truecolor',
        });

        let pty: IPty;

        if (toolId === 'terminal') {
            // Plain shell — no CLI tool
            console.log(`[PtyManager] Launching shell in ${workingDir}`);
            if (isWin) {
                pty = spawnPty(windowsShellPath(), ['-NoLogo'], {
                    cwd: workingDir,
                    env: shellEnv,
                });
            } else {
                pty = spawnPty(process.env.SHELL || '/bin/bash', [], {
                    cwd: workingDir,
                    env: shellEnv,
                });
            }
        } else {
            // CLI tool launch
            const launchConfig = this.toolManager.getLaunchConfig(toolId);
            if (!launchConfig) {
                throw new Error(`Tool "${toolId}" not found or not available`);
            }

            console.log(`[PtyManager] Launching ${toolId}:`);
            console.log(`  bin: ${launchConfig.bin}`);
            console.log(`  args: ${JSON.stringify(launchConfig.args)}`);
            console.log(`  cwd: ${workingDir}`);

            const env = { ...toolBaseEnv, ...launchConfig.env };

            if (isWin) {
                const cmdParts = [`& "${launchConfig.bin}"`];
                for (const arg of launchConfig.args) {
                    const escaped = arg.replace(/'/g, "''");
                    cmdParts.push(`'${escaped}'`);
                }
                const fullCommand = cmdParts.join(' ');
                console.log(`  powershell cmd: ${fullCommand}`);

                pty = spawnPty(windowsShellPath(), [
                    '-NoProfile',
                    '-NoLogo',
                    '-Command',
                    fullCommand,
                ], {
                    cwd: workingDir,
                    env,
                });
            } else {
                pty = spawnPty(launchConfig.bin, launchConfig.args, {
                    cwd: workingDir,
                    env,
                });
            }
        }

        const session: PtySession = {
            id: sessionId, toolId, pty, cwd: workingDir, buffer: '', totalChars: 0,
        };

        pty.onData((data: string) => {
            session.totalChars += data.length;
            session.buffer += data;
            if (session.buffer.length > MAX_BUFFER_CHARS) {
                session.buffer = session.buffer.slice(session.buffer.length - MAX_BUFFER_CHARS);
            }
            this.dataCallbacks.forEach(cb => cb(sessionId, data, session.totalChars));
        });

        pty.onExit(({ exitCode }) => {
            this.exitCallbacks.forEach(cb => cb(sessionId, exitCode));
            this.sessions.delete(sessionId);
        });

        this.sessions.set(sessionId, session);
        this.createdCallbacks.forEach(cb => cb({ sessionId, toolId, cwd: workingDir }));
        return sessionId;
    }

    write(sessionId: string, data: string): void {
        const session = this.sessions.get(sessionId);
        if (session) {
            session.pty.write(data);
        }
    }

    resize(sessionId: string, cols: number, rows: number): void {
        const session = this.sessions.get(sessionId);
        if (session) {
            session.pty.resize(cols, rows);
        }
    }

    destroySession(sessionId: string): void {
        const session = this.sessions.get(sessionId);
        if (session) {
            // Announce the deliberate close BEFORE killing so clients remove the
            // tab; the kill's later onExit then finds no tab and is a no-op.
            this.closedCallbacks.forEach(cb => cb(sessionId));
            session.pty.kill();
            this.sessions.delete(sessionId);
        }
    }

    destroyAll(): void {
        for (const session of this.sessions.values()) {
            try {
                this.closedCallbacks.forEach(cb => cb(session.id));
                session.pty.kill();
            } catch { /* ignore */ }
        }
        this.sessions.clear();
    }
}
