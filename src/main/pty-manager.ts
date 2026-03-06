import * as os from 'os';
import * as path from 'path';
import { spawn as ptySpawn, IPty } from 'node-pty';
import { ToolManager, LaunchConfig } from './tool-manager';
import { buildSanitizedEnv } from './process-env';

interface PtySession {
    id: string;
    toolId: string;
    pty: IPty;
    cwd: string;
}

type DataCallback = (sessionId: string, data: string) => void;
type ExitCallback = (sessionId: string, exitCode: number) => void;

export class PtyManager {
    private sessions: Map<string, PtySession> = new Map();
    private dataCallbacks: DataCallback[] = [];
    private exitCallbacks: ExitCallback[] = [];
    private sessionCounter = 0;

    constructor(private toolManager: ToolManager) { }

    onData(callback: DataCallback): void {
        this.dataCallbacks.push(callback);
    }

    onExit(callback: ExitCallback): void {
        this.exitCallbacks.push(callback);
    }

    createSession(toolId: string, cwd?: string): string {
        const sessionId = `session-${++this.sessionCounter}-${Date.now()}`;
        const defaultCwd = path.join(os.homedir(), 'Documents', '4RouterAi');
        if (!cwd) {
            const fs = require('fs') as typeof import('fs');
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
                pty = ptySpawn('powershell.exe', ['-NoLogo'], {
                    name: 'xterm-256color',
                    cols: 120,
                    rows: 30,
                    cwd: workingDir,
                    env: shellEnv,
                });
            } else {
                pty = ptySpawn(process.env.SHELL || '/bin/bash', [], {
                    name: 'xterm-256color',
                    cols: 120,
                    rows: 30,
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

                pty = ptySpawn('powershell.exe', [
                    '-NoProfile',
                    '-NoLogo',
                    '-Command',
                    fullCommand,
                ], {
                    name: 'xterm-256color',
                    cols: 120,
                    rows: 30,
                    cwd: workingDir,
                    env,
                });
            } else {
                pty = ptySpawn(launchConfig.bin, launchConfig.args, {
                    name: 'xterm-256color',
                    cols: 120,
                    rows: 30,
                    cwd: workingDir,
                    env,
                });
            }
        }

        pty.onData((data: string) => {
            this.dataCallbacks.forEach(cb => cb(sessionId, data));
        });

        pty.onExit(({ exitCode }) => {
            this.exitCallbacks.forEach(cb => cb(sessionId, exitCode));
            this.sessions.delete(sessionId);
        });

        const session: PtySession = { id: sessionId, toolId, pty, cwd: workingDir };
        this.sessions.set(sessionId, session);
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
            session.pty.kill();
            this.sessions.delete(sessionId);
        }
    }

    destroyAll(): void {
        for (const session of this.sessions.values()) {
            try { session.pty.kill(); } catch { /* ignore */ }
        }
        this.sessions.clear();
    }
}
