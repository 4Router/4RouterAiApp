import * as crypto from 'crypto';
import * as http from 'http';
import * as https from 'https';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { WebSocketServer, WebSocket } from 'ws';
import { HandlerRegistry } from './ipc-handlers';
import { WebAuth, AccessRequest } from './web-auth';
import { WebAudit } from './web-audit';

/**
 * Wire protocol (JSON over a single WebSocket at <prefix>/ws):
 *
 *   client -> server
 *     { t: 'inv', id, ch, args }   request/response call
 *     { t: 'snd', ch, args }       fire-and-forget call
 *   server -> client
 *     { t: 'res', id, ok, data }   reply to an 'inv' (ok=false -> data is error string)
 *     { t: 'evt', ch, args }       pushed event (e.g. pty:data, pty:exit)
 *
 * A request has to clear four gates before any of that happens:
 *
 *   1. secret path prefix   anything outside /<prefix>/ gets a bare 404, so a
 *                           port scan can't tell this is 4RouterAi at all
 *   2. Host + Origin        DNS-rebinding and cross-site guards
 *   3. encrypted transport  plaintext remote access is refused outright
 *   4. device cookie        issued only via the /api endpoints below
 *
 *   GET  <prefix>/api/session          is this browser already paired?
 *   POST <prefix>/api/pair             redeem an 8-digit pairing code
 *   POST <prefix>/api/access-request   present the master token, queue for approval
 *   GET  <prefix>/api/access-request   poll it; device cookie arrives on approval
 *   POST <prefix>/api/logout           drop and revoke this device
 *   GET  <prefix>/api/ca               download the local CA certificate (DER)
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

const DEVICE_COOKIE = 'rw_device';
const DEVICE_COOKIE_MAX_AGE = 30 * 24 * 3600;
/** Request bodies are tiny JSON blobs; anything larger is hostile. */
const MAX_BODY_BYTES = 4 * 1024;

export interface ClientInfo {
    id: string;
    ip: string;
    userAgent: string;
    deviceId: string;
    deviceName: string;
    connectedAt: number;
}

interface ClientConnection extends ClientInfo {
    ws: WebSocket;
}

export interface WebBridgeOptions {
    /** Directory holding the built renderer (dist/renderer). */
    staticDir: string;
    auth: WebAuth;
    audit: WebAudit;
    /** Secret first path segment. Empty disables the hidden-entry check. */
    pathPrefix: string;
    /** Extra hostnames the bridge may legitimately be reached under. */
    allowedHosts: string[];
    /** When false, a valid master token alone is enough — no host approval. */
    requireApproval: boolean;
    /** CIDRs already encrypted at the network layer (WireGuard, Tailscale…). */
    trustedNetworks: string[];
    /**
     * Serve TLS ourselves with this key pair instead of plain HTTP. `cert` may
     * be a full chain; `caCert` is the issuing local CA, exposed for download
     * so other devices can install it and turn the warning into a green lock.
     */
    tls?: { key: string; cert: string; caCert?: string };
    /** Fired when a client shows up needing the host user's decision. */
    onAccessRequest?: (request: AccessRequest) => void;
    /** Fired whenever the connected-client list changes. */
    onClientsChanged?: (clients: ClientInfo[]) => void;
}

type TransportVerdict =
    | { secure: true }
    | { secure: false; reason: 'tunnel-no-tls' | 'plaintext' };

/** Strip the IPv6-mapped IPv4 prefix and brackets so IPs compare/display sanely. */
function normalizeIp(raw: string | undefined): string {
    if (!raw) return 'unknown';
    let ip = raw;
    if (ip.startsWith('::ffff:')) ip = ip.slice(7);
    if (ip.startsWith('[') && ip.endsWith(']')) ip = ip.slice(1, -1);
    return ip;
}

function isLoopback(ip: string): boolean {
    return ip === '::1' || ip.startsWith('127.');
}


function isLocalHostname(hostname: string): boolean {
    return hostname === 'localhost' || hostname === '::1' || hostname.startsWith('127.');
}

/** Hostname without the port, lowercased. Handles `[::1]:4178`. */
function hostnameOf(hostHeader: string): string {
    const host = hostHeader.trim().toLowerCase();
    if (host.startsWith('[')) {
        const end = host.indexOf(']');
        return end === -1 ? host.slice(1) : host.slice(1, end);
    }
    const colon = host.lastIndexOf(':');
    return colon === -1 ? host : host.slice(0, colon);
}

function parseCookies(header: string | undefined): Record<string, string> {
    const out: Record<string, string> = {};
    if (!header) return out;
    for (const part of header.split(';')) {
        const eq = part.indexOf('=');
        if (eq === -1) continue;
        const key = part.slice(0, eq).trim();
        if (!key) continue;
        out[key] = decodeURIComponent(part.slice(eq + 1).trim());
    }
    return out;
}

function escapeHtml(value: string): string {
    return value.replace(/[&<>"']/g, ch => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch] || ch
    ));
}

export class WebBridge {
    private server: http.Server | null = null;
    private wss: WebSocketServer | null = null;
    private clients = new Map<string, ClientConnection>();
    private clientSeq = 0;
    private trustedBlocks: net.BlockList;

    constructor(private handlers: HandlerRegistry, private opts: WebBridgeOptions) {
        this.trustedBlocks = this.buildTrustedBlocks();
    }

    isRunning(): boolean {
        return this.server !== null;
    }

    /** Start listening. Resolves once the server is bound (or rejects on error). */
    start(port: number, host: string): Promise<void> {
        return new Promise((resolve, reject) => {
            const handler = (req: http.IncomingMessage, res: http.ServerResponse) => {
                void this.handleHttp(req, res);
            };
            // With TLS terminated here, req.socket.encrypted is true and the
            // transport check passes without any forwarded-header inference.
            const server: http.Server = this.opts.tls
                ? https.createServer({ key: this.opts.tls.key, cert: this.opts.tls.cert }, handler)
                : http.createServer(handler);
            const wss = new WebSocketServer({ noServer: true });

            server.on('upgrade', (req, socket, head) => {
                const verdict = this.authorizeUpgrade(req);
                if (!verdict.ok) {
                    socket.write(`HTTP/1.1 ${verdict.status} ${verdict.reason}\r\nConnection: close\r\n\r\n`);
                    socket.destroy();
                    return;
                }
                wss.handleUpgrade(req, socket, head, ws =>
                    this.handleConnection(ws, verdict.ip, verdict.userAgent, verdict.deviceId, verdict.deviceName),
                );
            });

            // Release the half-built listener so the caller can retry on
            // another port without leaking it.
            server.once('error', (err) => {
                try { server.close(); } catch { /* never got listening */ }
                reject(err);
            });
            server.listen(port, host, () => {
                server.removeListener('error', reject);
                this.server = server;
                this.wss = wss;
                const scheme = this.opts.tls ? 'https' : 'http';
                console.log(`[WebBridge] listening on ${scheme}://${host}:${port} (serving ${this.opts.staticDir})`);
                resolve();
            });
        });
    }

    /** Push an event to every connected web client. */
    broadcast(channel: string, args: any[]): void {
        if (!this.clients.size) return;
        const msg = JSON.stringify({ t: 'evt', ch: channel, args });
        for (const client of this.clients.values()) {
            if (client.ws.readyState === WebSocket.OPEN) client.ws.send(msg);
        }
    }

    listClients(): ClientInfo[] {
        return [...this.clients.values()].map(({ ws, ...info }) => info);
    }

    /** Kick one live connection. The device stays paired unless also revoked. */
    disconnectClient(id: string): boolean {
        const client = this.clients.get(id);
        if (!client) return false;
        try { client.ws.close(4001, 'disconnected by host'); } catch { /* ignore */ }
        this.clients.delete(id);
        this.opts.audit.record('kick', { ip: client.ip, device: client.deviceName });
        this.opts.onClientsChanged?.(this.listClients());
        return true;
    }

    disconnectAll(): number {
        const count = this.clients.size;
        for (const client of this.clients.values()) {
            try { client.ws.close(4001, 'disconnected by host'); } catch { /* ignore */ }
        }
        this.clients.clear();
        if (count) {
            this.opts.audit.record('kick', { detail: `断开全部 ${count} 个连接` });
            this.opts.onClientsChanged?.(this.listClients());
        }
        return count;
    }

    /** Drop every live connection belonging to a device that was just revoked. */
    disconnectDevice(deviceId: string): number {
        let count = 0;
        for (const [id, client] of this.clients) {
            if (client.deviceId !== deviceId) continue;
            try { client.ws.close(4003, 'device revoked'); } catch { /* ignore */ }
            this.clients.delete(id);
            count++;
        }
        if (count) this.opts.onClientsChanged?.(this.listClients());
        return count;
    }

    stop(): void {
        for (const client of this.clients.values()) {
            try { client.ws.close(); } catch { /* ignore */ }
        }
        this.clients.clear();
        this.wss?.close();
        this.server?.close();
        this.wss = null;
        this.server = null;
    }

    // ===== trusted networks =====

    /**
     * BlockList is Node's only built-in CIDR matcher; the name is about its usual
     * role, but all we want here is "does this address fall inside one of the
     * user's declared subnets".
     */
    private buildTrustedBlocks(): net.BlockList {
        const list = new net.BlockList();
        for (const entry of this.opts.trustedNetworks) {
            const [address, bits] = String(entry).trim().split('/');
            const type = net.isIPv4(address) ? 'ipv4' : net.isIPv6(address) ? 'ipv6' : null;
            if (!type) continue;
            try {
                const prefix = parseInt(bits, 10);
                if (Number.isFinite(prefix)) list.addSubnet(address, prefix, type);
                else list.addAddress(address, type);
            } catch {
                // Malformed entry — skip rather than refuse to start.
            }
        }
        return list;
    }

    private inTrustedNetwork(ip: string): boolean {
        const type = net.isIPv4(ip) ? 'ipv4' : net.isIPv6(ip) ? 'ipv6' : null;
        if (!type) return false;
        try {
            return this.trustedBlocks.check(ip, type);
        } catch {
            return false;
        }
    }

    // ===== transport security =====

    /**
     * Decide whether this request reached us over something encrypted. Anything
     * that isn't gets refused — there is no "accept plaintext" setting, because
     * the built-in HTTPS option covers the LAN case that would otherwise need
     * one, and plaintext on a shared network hands the device cookie (and with
     * it, full control of this machine) to anyone able to sniff the segment.
     *
     * The app can't see the TLS itself when a tunnel terminates it upstream, so
     * it infers: `X-Forwarded-Proto` is honoured *only* from a loopback socket.
     * That's what makes it sound — a remote peer can forge the header but cannot
     * forge its source address, and a loopback socket means the request came
     * from a tunnel client running on this machine.
     */
    private assessTransport(req: http.IncomingMessage): TransportVerdict {
        if ((req.socket as any).encrypted) return { secure: true };

        const socketIp = this.clientIp(req);
        const loopback = isLoopback(socketIp);
        const hostname = hostnameOf(req.headers.host || '');

        // The host's own browser: the bytes never touch a network.
        if (loopback && isLocalHostname(hostname)) return { secure: true };

        const proto = String(req.headers['x-forwarded-proto'] || '')
            .split(',')[0].trim().toLowerCase();
        if (loopback && proto === 'https') return { secure: true };

        // A network that is itself encrypted, as declared by the user.
        if (this.inTrustedNetwork(socketIp)) return { secure: true };

        return { secure: false, reason: loopback ? 'tunnel-no-tls' : 'plaintext' };
    }

    // ===== origin / host gating =====

    /**
     * Hostnames this bridge accepts in the Host header. Local names plus every
     * current LAN address, plus whatever tunnel domains the user declared.
     *
     * This is the DNS-rebinding guard: a page on attacker.com that resolves to
     * 127.0.0.1 sends `Host: attacker.com`, which isn't in here. LAN addresses
     * are recomputed per call because they change when the machine roams.
     */
    private allowedHostnames(): Set<string> {
        const names = new Set(['127.0.0.1', 'localhost', '::1', '0.0.0.0']);
        for (const list of Object.values(os.networkInterfaces())) {
            for (const iface of list || []) {
                if (!iface.internal) names.add(iface.address.toLowerCase());
            }
        }
        for (const extra of this.opts.allowedHosts) {
            const trimmed = extra.trim().toLowerCase();
            if (trimmed) names.add(hostnameOf(trimmed));
        }
        return names;
    }

    private hostAllowed(req: http.IncomingMessage): boolean {
        const host = req.headers.host;
        if (!host) return false;
        return this.allowedHostnames().has(hostnameOf(host));
    }

    /**
     * Same-origin check rather than a fixed allow-list, so the bridge keeps
     * working behind any reverse proxy or tunnel (they forward Host untouched
     * and therefore stay consistent with the browser's Origin) while still
     * refusing WebSockets opened by a third-party page.
     *
     * A missing Origin means a non-browser client (curl, CLI). Those aren't
     * subject to the cross-site vector this guards against — an attacker who can
     * craft raw requests can forge any header — so they fall through to the
     * credential check instead.
     */
    private originAllowed(req: http.IncomingMessage): boolean {
        const origin = req.headers.origin;
        if (!origin) return true;
        const host = req.headers.host;
        if (!host) return false;
        try {
            return new URL(origin).host.toLowerCase() === host.trim().toLowerCase();
        } catch {
            return false;
        }
    }

    private clientIp(req: http.IncomingMessage): string {
        return normalizeIp(req.socket.remoteAddress || undefined);
    }

    /**
     * Address to *show* the host user. X-Forwarded-For is attacker-controllable
     * so it never feeds rate limiting, but behind a tunnel the socket address is
     * always 127.0.0.1 and the forwarded value is the only useful hint.
     */
    private displayIp(req: http.IncomingMessage): string {
        const socketIp = this.clientIp(req);
        const forwarded = req.headers['x-forwarded-for'];
        const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded || '')
            .split(',')[0]
            .trim();
        if (!first) return socketIp;
        return `${normalizeIp(first)} (经 ${socketIp})`;
    }

    // ===== secret path prefix =====

    /**
     * Strip the secret segment, yielding the effective path. `null` means the
     * request doesn't belong to us and must be answered with a plain 404;
     * `redirect` means the prefix matched but the trailing slash is missing,
     * which relative asset URLs need.
     */
    private resolvePath(pathname: string): { path: string } | { redirect: true } | null {
        const prefix = this.opts.pathPrefix;
        if (!prefix) return { path: pathname };
        if (pathname === `/${prefix}`) return { redirect: true };
        if (pathname.startsWith(`/${prefix}/`)) return { path: pathname.slice(prefix.length + 1) };
        return null;
    }

    /**
     * Indistinguishable from any ordinary web server's 404 — no app headers, no
     * branding. A scanner that guesses the wrong prefix learns nothing.
     */
    private notFound(res: http.ServerResponse): void {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not Found');
    }

    // ===== websocket authorization =====

    private authorizeUpgrade(req: http.IncomingMessage):
        | { ok: true; ip: string; userAgent: string; deviceId: string; deviceName: string }
        | { ok: false; status: number; reason: string } {
        const url = new URL(req.url || '/', 'http://localhost');
        const resolved = this.resolvePath(url.pathname);
        if (!resolved || 'redirect' in resolved || resolved.path !== '/ws') {
            if (!resolved) {
                this.opts.audit.record('reject-prefix', {
                    ip: this.clientIp(req), detail: 'WebSocket 路径不匹配',
                });
            }
            return { ok: false, status: 404, reason: 'Not Found' };
        }

        const ip = this.clientIp(req);
        if (!this.hostAllowed(req)) {
            this.opts.audit.record('reject-host', { ip, detail: String(req.headers.host || '') });
            return { ok: false, status: 400, reason: 'Bad Host' };
        }
        if (!this.originAllowed(req)) {
            this.opts.audit.record('reject-origin', { ip, detail: String(req.headers.origin || '') });
            return { ok: false, status: 403, reason: 'Forbidden Origin' };
        }

        const transport = this.assessTransport(req);
        if (!transport.secure) {
            this.opts.audit.record('reject-insecure', { ip, detail: transport.reason });
            return { ok: false, status: 403, reason: 'Insecure Transport' };
        }

        if (this.opts.auth.lockoutRemaining(ip) > 0) {
            return { ok: false, status: 429, reason: 'Too Many Requests' };
        }

        const userAgent = String(req.headers['user-agent'] || '');
        const cookies = parseCookies(req.headers.cookie);
        const device = this.opts.auth.verifyDevice(cookies[DEVICE_COOKIE] || '');
        if (device) {
            this.opts.auth.recordSuccess(ip);
            this.opts.auth.touchDevice(device.id, this.displayIp(req));
            return { ok: true, ip: this.displayIp(req), userAgent, deviceId: device.id, deviceName: device.name };
        }

        // No device cookie. A bare master token is only sufficient when the host
        // user has turned approval off; otherwise the client must go through
        // /api/access-request and wait to be let in.
        const bearer = String(req.headers.authorization || '');
        const presented = bearer.toLowerCase().startsWith('bearer ') ? bearer.slice(7).trim() : '';
        if (presented && this.opts.auth.verifyToken(presented)) {
            if (!this.opts.requireApproval) {
                this.opts.auth.recordSuccess(ip);
                return { ok: true, ip: this.displayIp(req), userAgent, deviceId: '', deviceName: 'CLI 客户端' };
            }
            return { ok: false, status: 403, reason: 'Approval Required' };
        }

        if (presented) this.opts.auth.recordFailure(ip);
        this.opts.audit.record('reject-auth', { ip, detail: 'WebSocket 无有效凭证' });
        return { ok: false, status: 401, reason: 'Unauthorized' };
    }

    // ===== http =====

    /**
     * CSP has to stay compatible with the meta CSP inside index.html — browsers
     * intersect the two, so a directive that's stricter here silently blocks
     * what the page declares (the Google Fonts stylesheet and its font files).
     */
    private securityHeaders(): Record<string, string> {
        return {
            'X-Content-Type-Options': 'nosniff',
            'Referrer-Policy': 'no-referrer',
            'Content-Security-Policy': [
                "default-src 'self'",
                "script-src 'self'",
                "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
                "font-src 'self' data: https://fonts.gstatic.com",
                "img-src 'self' data: blob:",
                "connect-src 'self' ws: wss:",
                "frame-ancestors 'none'",
                "base-uri 'none'",
                "form-action 'none'",
            ].join('; '),
        };
    }

    private sendJson(res: http.ServerResponse, status: number, body: any, extra?: Record<string, string>): void {
        res.writeHead(status, {
            'Content-Type': MIME['.json'],
            'Cache-Control': 'no-store',
            ...this.securityHeaders(),
            ...extra,
        }).end(JSON.stringify(body));
    }

    private deviceCookie(req: http.IncomingMessage, token: string): string {
        const secure = (req.socket as any).encrypted
            || String(req.headers['x-forwarded-proto'] || '').toLowerCase().includes('https');
        const prefix = this.opts.pathPrefix ? `/${this.opts.pathPrefix}` : '/';
        const parts = [
            `${DEVICE_COOKIE}=${encodeURIComponent(token)}`,
            `Path=${prefix}`,
            'HttpOnly',
            // Strict also means a cross-site page can't attach this cookie to a
            // WebSocket handshake, which backs up the Origin check above.
            'SameSite=Strict',
            `Max-Age=${DEVICE_COOKIE_MAX_AGE}`,
        ];
        if (secure) parts.push('Secure');
        return parts.join('; ');
    }

    private clearedCookie(): string {
        const prefix = this.opts.pathPrefix ? `/${this.opts.pathPrefix}` : '/';
        return `${DEVICE_COOKIE}=; Path=${prefix}; HttpOnly; SameSite=Strict; Max-Age=0`;
    }

    private readJsonBody(req: http.IncomingMessage): Promise<any> {
        return new Promise((resolve, reject) => {
            let size = 0;
            const chunks: Buffer[] = [];
            req.on('data', (chunk: Buffer) => {
                size += chunk.length;
                if (size > MAX_BODY_BYTES) {
                    reject(new Error('body too large'));
                    req.destroy();
                    return;
                }
                chunks.push(chunk);
            });
            req.on('end', () => {
                if (!chunks.length) return resolve({});
                try {
                    resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
                } catch {
                    reject(new Error('invalid json'));
                }
            });
            req.on('error', reject);
        });
    }

    private async handleHttp(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        const reqUrl = new URL(req.url || '/', 'http://localhost');

        // Gate 1: the secret prefix. Everything else about this server stays
        // invisible until it matches.
        const resolved = this.resolvePath(reqUrl.pathname);
        if (!resolved) {
            this.opts.audit.record('reject-prefix', {
                ip: this.clientIp(req), detail: reqUrl.pathname.slice(0, 80),
            });
            this.notFound(res);
            return;
        }
        if ('redirect' in resolved) {
            res.writeHead(301, { Location: `/${this.opts.pathPrefix}/` }).end();
            return;
        }

        // Gate 2: Host allow-list.
        if (!this.hostAllowed(req)) {
            this.opts.audit.record('reject-host', {
                ip: this.clientIp(req), detail: String(req.headers.host || ''),
            });
            res.writeHead(400, this.securityHeaders()).end('Bad Host');
            return;
        }

        // Gate 3: encrypted transport. Reaching here means the caller knows the
        // prefix, so an explanatory page is safe and far more useful than a 403.
        const transport = this.assessTransport(req);
        if (!transport.secure) {
            this.opts.audit.record('reject-insecure', {
                ip: this.clientIp(req), detail: transport.reason,
            });
            this.sendInsecurePage(res, transport.reason);
            return;
        }

        if (resolved.path.startsWith('/api/')) {
            await this.handleApi(req, res, resolved.path, reqUrl.searchParams);
            return;
        }
        this.serveStatic(res, resolved.path);
    }

    /** Tell the user, in the browser, why the connection was refused. */
    private sendInsecurePage(res: http.ServerResponse, reason: 'tunnel-no-tls' | 'plaintext'): void {
        const cause = reason === 'tunnel-no-tls'
            ? '请求经隧道转发进来，但隧道对外是 HTTP，没有启用 TLS。'
            : '请求以明文 HTTP 直接抵达本机，链路上没有任何加密。';
        const body = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>连接未加密</title>
<style>
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
    background:#0b0d12;color:#e6e9f0;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;padding:24px}
  .card{max-width:460px;background:#151922;border:1px solid #262d3b;border-radius:16px;padding:28px 24px}
  h1{margin:0 0 10px;font-size:18px}
  p{margin:0 0 14px;font-size:13px;line-height:1.75;color:#a9b4cc}
  ul{margin:0;padding-left:20px;font-size:12.5px;line-height:1.9;color:#8d97ad}
  code{background:#0e121a;border:1px solid #2c3445;border-radius:5px;padding:1px 6px;
    font-family:ui-monospace,monospace;font-size:11.5px;color:#c8d2e6}
  .why{color:#e0b155}
</style></head>
<body><div class="card">
  <h1>已拒绝：连接未加密</h1>
  <p class="why">${escapeHtml(cause)}</p>
  <p>远程访问会把终端和 Agent 的完整控制权交给对端，明文传输意味着凭证和终端内容可被链路上的任何人读取或篡改，因此本机默认拒绝。请在桌面端「远程访问」中任选一种方式：</p>
  <ul>
    <li>开启「内置 HTTPS」，然后改用 <code>https://</code> 访问（首次会提示证书不受信任，核对指纹后继续即可）</li>
    <li>让隧道 / 反向代理以 <code>HTTPS</code> 对外提供服务</li>
    <li>若接入的是加密专网（Tailscale、WireGuard 等），把该网段登记为「受信任网段」</li>
  </ul>
</div></body></html>`;
        res.writeHead(403, { 'Content-Type': MIME['.html'], ...this.securityHeaders() }).end(body);
    }

    private async handleApi(
        req: http.IncomingMessage,
        res: http.ServerResponse,
        apiPath: string,
        query: URLSearchParams,
    ): Promise<void> {
        // Every API call is state-changing or credential-bearing, so unlike the
        // static assets these all get the cross-site check.
        if (!this.originAllowed(req)) {
            this.opts.audit.record('reject-origin', {
                ip: this.clientIp(req), detail: String(req.headers.origin || ''),
            });
            this.sendJson(res, 403, { ok: false, error: 'forbidden origin' });
            return;
        }

        const ip = this.clientIp(req);
        const lockout = this.opts.auth.lockoutRemaining(ip);
        if (lockout > 0) {
            this.sendJson(res, 429, { ok: false, error: 'too many attempts', retryAfterMs: lockout }, {
                'Retry-After': String(Math.ceil(lockout / 1000)),
            });
            return;
        }

        const userAgent = String(req.headers['user-agent'] || '');
        const cookies = parseCookies(req.headers.cookie);
        /** Global lockdown freezes new credentials but not established devices. */
        const lockedDown = this.opts.auth.isLockedDown();

        try {
            switch (`${req.method} ${apiPath}`) {
                // The CA certificate is public material and the very thing a
                // device needs *before* it can trust this server, so it is
                // served without a credential — but still behind the secret
                // prefix and the encrypted-transport gate like everything else.
                case 'GET /api/ca': {
                    const caPem = this.opts.tls?.caCert;
                    if (!caPem) {
                        this.sendJson(res, 404, { ok: false, error: 'built-in https is not active' });
                        return;
                    }
                    let der: Buffer;
                    try {
                        der = new crypto.X509Certificate(caPem).raw;
                    } catch {
                        this.sendJson(res, 500, { ok: false, error: 'ca certificate unreadable' });
                        return;
                    }
                    // DER + .crt: the combination every OS certificate installer
                    // (Windows, macOS, iOS profiles, Android) recognises.
                    res.writeHead(200, {
                        'Content-Type': 'application/x-x509-ca-cert',
                        'Content-Disposition': 'attachment; filename="4RouterAi-Local-CA.crt"',
                        'Cache-Control': 'no-store',
                        ...this.securityHeaders(),
                    }).end(der);
                    return;
                }

                case 'GET /api/session': {
                    const device = this.opts.auth.verifyDevice(cookies[DEVICE_COOKIE] || '');
                    this.sendJson(res, 200, {
                        ok: true,
                        paired: !!device,
                        deviceName: device?.name || null,
                        requireApproval: this.opts.requireApproval,
                        lockedDown,
                    });
                    return;
                }

                case 'POST /api/pair': {
                    if (lockedDown) {
                        this.sendJson(res, 423, {
                            ok: false,
                            error: '检测到大量失败尝试，已暂时停止接受新设备。请在桌面端解除。',
                        });
                        return;
                    }
                    const body = await this.readJsonBody(req);
                    const code = String(body?.code || '').replace(/\D/g, '');
                    if (!code || !this.opts.auth.consumePairingCode(code)) {
                        const wait = this.opts.auth.recordFailure(ip);
                        this.opts.audit.record('pair-fail', { ip, detail: wait ? `退避 ${Math.round(wait / 1000)}s` : undefined });
                        this.sendJson(res, 401, { ok: false, error: '配对码无效或已过期', retryAfterMs: wait });
                        return;
                    }
                    // Redeeming a code the host just generated on the desktop is
                    // itself proof of consent, so this path skips approval.
                    this.opts.auth.recordSuccess(ip);
                    const { token, record } = this.opts.auth.issueDevice(this.displayIp(req), userAgent);
                    this.opts.audit.record('pair-ok', { ip: this.displayIp(req), device: record.name });
                    this.sendJson(res, 200, { ok: true, deviceName: record.name }, {
                        'Set-Cookie': this.deviceCookie(req, token),
                    });
                    return;
                }

                case 'POST /api/access-request': {
                    if (lockedDown) {
                        this.sendJson(res, 423, {
                            ok: false,
                            error: '检测到大量失败尝试，已暂时停止接受新设备。请在桌面端解除。',
                        });
                        return;
                    }
                    const body = await this.readJsonBody(req);
                    const token = String(body?.token || '');
                    if (!token || !this.opts.auth.verifyToken(token)) {
                        const wait = this.opts.auth.recordFailure(ip);
                        this.opts.audit.record('reject-auth', { ip, detail: '访问令牌错误' });
                        this.sendJson(res, 401, { ok: false, error: '访问令牌无效', retryAfterMs: wait });
                        return;
                    }
                    this.opts.auth.recordSuccess(ip);

                    if (!this.opts.requireApproval) {
                        const { token: deviceToken, record } = this.opts.auth.issueDevice(this.displayIp(req), userAgent);
                        this.opts.audit.record('approve', { ip: this.displayIp(req), device: record.name, detail: '未开启批准，自动放行' });
                        this.sendJson(res, 200, { ok: true, status: 'approved', deviceName: record.name }, {
                            'Set-Cookie': this.deviceCookie(req, deviceToken),
                        });
                        return;
                    }

                    const request = this.opts.auth.createRequest(this.displayIp(req), userAgent);
                    this.opts.audit.record('token-request', { ip: request.ip, device: request.name });
                    this.opts.onAccessRequest?.(request);
                    this.sendJson(res, 200, {
                        ok: true,
                        status: 'pending',
                        requestId: request.id,
                        expiresAt: request.expiresAt,
                    });
                    return;
                }

                case 'GET /api/access-request': {
                    const id = query.get('id') || '';
                    const request = this.opts.auth.getRequest(id);
                    if (!request) {
                        this.sendJson(res, 404, { ok: false, error: '请求不存在或已过期' });
                        return;
                    }
                    if (request.status !== 'approved') {
                        this.sendJson(res, 200, { ok: true, status: request.status });
                        return;
                    }
                    const deviceToken = this.opts.auth.claimRequestToken(id);
                    if (!deviceToken) {
                        this.sendJson(res, 200, { ok: true, status: 'approved' });
                        return;
                    }
                    this.sendJson(res, 200, { ok: true, status: 'approved' }, {
                        'Set-Cookie': this.deviceCookie(req, deviceToken),
                    });
                    return;
                }

                case 'POST /api/logout': {
                    const device = this.opts.auth.verifyDevice(cookies[DEVICE_COOKIE] || '');
                    if (device) {
                        this.opts.auth.revokeDevice(device.id);
                        this.disconnectDevice(device.id);
                        this.opts.audit.record('revoke', { ip, device: device.name, detail: '远端自行解除配对' });
                    }
                    this.sendJson(res, 200, { ok: true }, { 'Set-Cookie': this.clearedCookie() });
                    return;
                }

                default:
                    this.sendJson(res, 404, { ok: false, error: 'unknown endpoint' });
            }
        } catch (err: any) {
            this.sendJson(res, 400, { ok: false, error: String(err?.message || err) });
        }
    }

    // ===== static file serving =====

    private serveStatic(res: http.ServerResponse, requestPath: string): void {
        let pathname: string;
        try {
            pathname = decodeURIComponent(requestPath);
        } catch {
            res.writeHead(400, this.securityHeaders()).end('Bad Request');
            return;
        }
        if (pathname === '/') pathname = '/index.html';

        // Resolve within staticDir and reject any path traversal. The separator
        // suffix keeps a sibling directory sharing the prefix (…/renderer-x)
        // from passing the check.
        const root = path.resolve(this.opts.staticDir);
        const normalized = path.resolve(root, '.' + path.sep + pathname);
        if (normalized !== root && !normalized.startsWith(root + path.sep)) {
            res.writeHead(403, this.securityHeaders()).end('Forbidden');
            return;
        }

        fs.readFile(normalized, (err, data) => {
            if (err) {
                // SPA-style fallback: unknown non-asset routes serve index.html.
                if (!path.extname(pathname)) {
                    fs.readFile(path.join(root, 'index.html'), (e2, html) => {
                        if (e2) { this.notFound(res); return; }
                        res.writeHead(200, { 'Content-Type': MIME['.html'], ...this.securityHeaders() }).end(html);
                    });
                    return;
                }
                this.notFound(res);
                return;
            }
            const ext = path.extname(normalized).toLowerCase();
            res.writeHead(200, {
                'Content-Type': MIME[ext] || 'application/octet-stream',
                ...this.securityHeaders(),
            }).end(data);
        });
    }

    // ===== websocket RPC =====

    private handleConnection(
        ws: WebSocket,
        ip: string,
        userAgent: string,
        deviceId: string,
        deviceName: string,
    ): void {
        const id = `client-${++this.clientSeq}`;
        const client: ClientConnection = {
            id, ws, ip, userAgent, deviceId, deviceName, connectedAt: Date.now(),
        };
        this.clients.set(id, client);
        console.log(`[WebBridge] client connected: ${deviceName} @ ${ip} (${this.clients.size} total)`);
        this.opts.audit.record('connect', { ip, device: deviceName });
        this.opts.onClientsChanged?.(this.listClients());

        ws.on('message', (raw: Buffer) => this.handleMessage(ws, raw));
        ws.on('close', () => {
            if (this.clients.delete(id)) {
                console.log(`[WebBridge] client disconnected: ${deviceName} (${this.clients.size} total)`);
                this.opts.audit.record('disconnect', { ip, device: deviceName });
                this.opts.onClientsChanged?.(this.listClients());
            }
        });
        ws.on('error', () => {
            if (this.clients.delete(id)) this.opts.onClientsChanged?.(this.listClients());
        });
    }

    private async handleMessage(ws: WebSocket, raw: Buffer): Promise<void> {
        let msg: any;
        try {
            msg = JSON.parse(raw.toString());
        } catch {
            return;
        }

        // Channels that administer the bridge itself (rotating its credentials,
        // approving devices, kicking clients) stay on the desktop window, so a
        // remote client can never widen its own access.
        if (typeof msg.ch === 'string' && this.handlers.localOnly.has(msg.ch)) {
            if (msg.t === 'inv') this.reply(ws, msg.id, false, `Channel not available remotely: ${msg.ch}`);
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
