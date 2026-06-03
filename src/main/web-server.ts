import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { WebSocketServer, WebSocket } from 'ws';
import { HandlerRegistry } from './ipc-handlers';

/**
 * Wire protocol (JSON over a single WebSocket at /ws):
 *
 *   client -> server
 *     { t: 'inv', id, ch, args }   request/response call
 *     { t: 'snd', ch, args }       fire-and-forget call
 *   server -> client
 *     { t: 'res', id, ok, data }   reply to an 'inv' (ok=false -> data is error string)
 *     { t: 'evt', ch, args }       pushed event (e.g. pty:data, pty:exit)
 */

const MIME: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.map': 'application/json; charset=utf-8',
};

export interface WebBridgeOptions {
    /** Directory holding the built renderer (dist/renderer). */
    staticDir: string;
    /** Optional shared secret; when set, /ws requires ?token=<token>. */
    token?: string;
}

export class WebBridge {
    private server: http.Server | null = null;
    private wss: WebSocketServer | null = null;
    private clients = new Set<WebSocket>();

    constructor(private handlers: HandlerRegistry, private opts: WebBridgeOptions) { }

    isRunning(): boolean {
        return this.server !== null;
    }

    /** Start listening. Resolves once the server is bound (or rejects on error). */
    start(port: number, host: string): Promise<void> {
        return new Promise((resolve, reject) => {
            const server = http.createServer((req, res) => this.handleHttp(req, res));
            const wss = new WebSocketServer({ noServer: true });

            server.on('upgrade', (req, socket, head) => {
                const url = new URL(req.url || '/', 'http://localhost');
                if (url.pathname !== '/ws') {
                    socket.destroy();
                    return;
                }
                if (this.opts.token && url.searchParams.get('token') !== this.opts.token) {
                    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
                    socket.destroy();
                    return;
                }
                wss.handleUpgrade(req, socket, head, ws => this.handleConnection(ws));
            });

            server.once('error', reject);
            server.listen(port, host, () => {
                server.removeListener('error', reject);
                this.server = server;
                this.wss = wss;
                console.log(`[WebBridge] listening on http://${host}:${port} (serving ${this.opts.staticDir})`);
                resolve();
            });
        });
    }

    /** Push an event to every connected web client. */
    broadcast(channel: string, args: any[]): void {
        if (!this.clients.size) return;
        const msg = JSON.stringify({ t: 'evt', ch: channel, args });
        for (const ws of this.clients) {
            if (ws.readyState === WebSocket.OPEN) ws.send(msg);
        }
    }

    stop(): void {
        for (const ws of this.clients) {
            try { ws.close(); } catch { /* ignore */ }
        }
        this.clients.clear();
        this.wss?.close();
        this.server?.close();
        this.wss = null;
        this.server = null;
    }

    // ----- static file serving -----

    private handleHttp(req: http.IncomingMessage, res: http.ServerResponse): void {
        const reqUrl = new URL(req.url || '/', 'http://localhost');
        let pathname = decodeURIComponent(reqUrl.pathname);
        if (pathname === '/') pathname = '/index.html';

        // Resolve within staticDir and reject any path traversal.
        const filePath = path.join(this.opts.staticDir, pathname);
        const normalized = path.normalize(filePath);
        if (!normalized.startsWith(path.normalize(this.opts.staticDir))) {
            res.writeHead(403).end('Forbidden');
            return;
        }

        fs.readFile(normalized, (err, data) => {
            if (err) {
                // SPA-style fallback: unknown non-asset routes serve index.html.
                if (!path.extname(pathname)) {
                    fs.readFile(path.join(this.opts.staticDir, 'index.html'), (e2, html) => {
                        if (e2) { res.writeHead(404).end('Not found'); return; }
                        res.writeHead(200, { 'Content-Type': MIME['.html'] }).end(html);
                    });
                    return;
                }
                res.writeHead(404).end('Not found');
                return;
            }
            const ext = path.extname(normalized).toLowerCase();
            res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' }).end(data);
        });
    }

    // ----- websocket RPC -----

    private handleConnection(ws: WebSocket): void {
        this.clients.add(ws);
        console.log(`[WebBridge] client connected (${this.clients.size} total)`);

        ws.on('message', (raw: Buffer) => this.handleMessage(ws, raw));
        ws.on('close', () => {
            this.clients.delete(ws);
            console.log(`[WebBridge] client disconnected (${this.clients.size} total)`);
        });
        ws.on('error', () => this.clients.delete(ws));
    }

    private async handleMessage(ws: WebSocket, raw: Buffer): Promise<void> {
        let msg: any;
        try {
            msg = JSON.parse(raw.toString());
        } catch {
            return;
        }

        if (msg.t === 'snd') {
            const fn = this.handlers.send[msg.ch];
            if (fn) {
                try { fn(...(msg.args || [])); } catch (err) { console.error(`[WebBridge] send ${msg.ch} failed:`, err); }
            }
            return;
        }

        if (msg.t === 'inv') {
            const fn = this.handlers.invoke[msg.ch];
            if (!fn) {
                this.reply(ws, msg.id, false, `Unknown channel: ${msg.ch}`);
                return;
            }
            try {
                const result = await fn(...(msg.args || []));
                this.reply(ws, msg.id, true, result);
            } catch (err: any) {
                this.reply(ws, msg.id, false, String(err?.message || err));
            }
        }
    }

    private reply(ws: WebSocket, id: number, ok: boolean, data: any): void {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ t: 'res', id, ok, data }));
        }
    }
}
