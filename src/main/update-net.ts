import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';
import * as net from 'net';
import * as tls from 'tls';

/**
 * Networking for the self-updater, written for the connections its users
 * actually have: GitHub reachable only through third-party proxies or a local
 * HTTP proxy (Clash and friends), links that stall or drop mid-transfer, and
 * mirrors that answer 200 with an HTML page instead of the file.
 *
 * Kept free of electron imports so it can be tested under plain node.
 */

export interface NetOptions {
    /** HTTP proxy, e.g. http://127.0.0.1:7890. HTTPS targets are tunnelled with CONNECT. */
    proxy?: string;
    /** Give up when nothing arrives for this long — while connecting, waiting for headers, or mid-body. */
    idleTimeoutMs?: number;
    headers?: Record<string, string>;
}

const DEFAULT_IDLE_TIMEOUT_MS = 30000;
const MAX_REDIRECTS = 5;

function parseProxy(proxy?: string): URL | null {
    if (!proxy) return null;
    try {
        const url = new URL(proxy);
        return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
    } catch {
        return null;
    }
}

function proxyAuthHeader(proxy: URL): Record<string, string> {
    if (!proxy.username) return {};
    const credentials = `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`;
    return { 'Proxy-Authorization': `Basic ${Buffer.from(credentials).toString('base64')}` };
}

/** Open a raw TCP tunnel to host:port through an HTTP proxy. */
function connectTunnel(proxy: URL, host: string, port: number, timeoutMs: number): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
        const lib = proxy.protocol === 'https:' ? https : http;
        const req = lib.request({
            host: proxy.hostname,
            port: proxy.port || (proxy.protocol === 'https:' ? 443 : 80),
            method: 'CONNECT',
            path: `${host}:${port}`,
            headers: { Host: `${host}:${port}`, ...proxyAuthHeader(proxy) },
            timeout: timeoutMs,
        });
        req.once('connect', (res, socket) => {
            if (res.statusCode === 200) {
                resolve(socket);
            } else {
                socket.destroy();
                reject(new Error(`代理拒绝连接（HTTP ${res.statusCode}）`));
            }
        });
        req.once('timeout', () => req.destroy(new Error('连接代理超时')));
        req.on('error', reject);
        req.end();
    });
}

/** Issue one request (no redirect handling) and resolve with the response head. */
async function requestOnce(url: URL, method: string, opts: NetOptions): Promise<http.IncomingMessage> {
    const idle = opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    const isHttps = url.protocol === 'https:';
    const port = Number(url.port) || (isHttps ? 443 : 80);
    const proxy = parseProxy(opts.proxy);
    const headers: Record<string, string> = { ...opts.headers };

    let options: https.RequestOptions;
    let lib: typeof http | typeof https = isHttps ? https : http;
    let tunnel: net.Socket | null = null;
    if (proxy && isHttps) {
        const socket = tunnel = await connectTunnel(proxy, url.hostname, port, idle);
        options = {
            host: url.hostname,
            port,
            path: url.pathname + url.search,
            // SNI must be a hostname; an IP literal is rejected outright.
            createConnection: () => tls.connect({ socket, servername: net.isIP(url.hostname) ? undefined : url.hostname }),
        };
    } else if (proxy) {
        // Plain-HTTP target: the proxy takes the absolute URL as the path.
        lib = proxy.protocol === 'https:' ? https : http;
        options = {
            host: proxy.hostname,
            port: Number(proxy.port) || (proxy.protocol === 'https:' ? 443 : 80),
            path: url.href,
        };
        Object.assign(headers, { Host: url.host }, proxyAuthHeader(proxy));
    } else {
        options = { host: url.hostname, port, path: url.pathname + url.search };
    }

    return new Promise((resolve, reject) => {
        const req = lib.request({ ...options, method, headers, timeout: idle }, resolve);
        req.once('timeout', () => req.destroy(new Error('网络无响应，连接已超时')));
        req.on('error', (err) => {
            tunnel?.destroy();
            reject(err);
        });
        req.end();
    });
}

/** Request a URL, following redirects. The response body is left unread. */
export async function openUrl(
    url: string,
    opts: NetOptions & { method?: string } = {},
): Promise<{ res: http.IncomingMessage; url: string }> {
    let current = new URL(url);
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        const res = await requestOnce(current, opts.method || 'GET', opts);
        const code = res.statusCode || 0;
        if (code >= 300 && code < 400 && res.headers.location) {
            res.resume();
            current = new URL(res.headers.location, current);
            continue;
        }
        return { res, url: current.href };
    }
    throw new Error('重定向次数过多');
}

/** GET a small text resource (API JSON, config files). */
export async function getText(
    url: string,
    opts: NetOptions & { maxBytes?: number } = {},
): Promise<{ statusCode: number; body: string }> {
    const maxBytes = opts.maxBytes ?? 4 * 1024 * 1024;
    const { res } = await openUrl(url, opts);
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > maxBytes) {
                res.destroy(new Error('响应过大'));
                return;
            }
            chunks.push(chunk);
        });
        res.once('end', () => resolve({ statusCode: res.statusCode || 0, body: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', reject);
    });
}

function isHtml(res: http.IncomingMessage): boolean {
    return /text\/html/i.test(String(res.headers['content-type'] || ''));
}

/** "bytes 100-199/1000" → { start: 100, total: 1000 }; total is null for "*". */
export function parseContentRange(value: unknown): { start: number; total: number | null } | null {
    const match = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(String(value || '').trim());
    if (!match) return null;
    return { start: Number(match[1]), total: match[3] === '*' ? null : Number(match[3]) };
}

export interface ProbeResult {
    url: string;
    timeMs: number;
    /** Honours Range, so an interrupted download can continue from it. */
    resumable: boolean;
}

// Small on purpose: every mirror is probed at once, and on a slow link a
// bigger probe would mostly measure the probes competing with each other.
const PROBE_BYTES = 16 * 1024;

/**
 * Check that a source really serves the expected file, by fetching its first
 * 16 KiB — a HEAD request can't tell a proxy's HTML error page from the
 * installer, since both come back 200.
 */
export async function probeSource(
    url: string,
    expect: { size: number; magic?: Buffer },
    opts: NetOptions = {},
): Promise<ProbeResult | null> {
    const start = Date.now();
    try {
        const { res } = await openUrl(url, {
            ...opts,
            headers: { ...opts.headers, Range: `bytes=0-${PROBE_BYTES - 1}` },
        });
        const code = res.statusCode || 0;
        let resumable: boolean;
        if (code === 206) {
            const range = parseContentRange(res.headers['content-range']);
            if (!range || range.start !== 0 || (expect.size > 0 && range.total !== expect.size)) {
                res.destroy();
                return null;
            }
            resumable = true;
        } else if (code === 200) {
            const length = Number(res.headers['content-length'] || 0);
            if (expect.size > 0 && length !== expect.size) {
                res.destroy();
                return null;
            }
            resumable = false;
        } else {
            res.resume();
            return null;
        }
        if (isHtml(res)) {
            res.destroy();
            return null;
        }

        const head = await new Promise<Buffer>((resolve, reject) => {
            const chunks: Buffer[] = [];
            let size = 0;
            res.on('data', (chunk: Buffer) => {
                chunks.push(chunk);
                size += chunk.length;
                // A source ignoring Range streams the whole file; stop early.
                if (size >= PROBE_BYTES) {
                    res.destroy();
                    resolve(Buffer.concat(chunks));
                }
            });
            res.once('end', () => resolve(Buffer.concat(chunks)));
            res.on('error', reject);
        });
        if (expect.magic && !head.subarray(0, expect.magic.length).equals(expect.magic)) {
            return null;
        }
        return { url, timeMs: Date.now() - start, resumable };
    } catch {
        return null;
    }
}

/** Resumable sources first, each group fastest first. */
export function rankProbes(results: Array<ProbeResult | null>): string[] {
    return results
        .filter((r): r is ProbeResult => r !== null)
        .sort((a, b) => Number(b.resumable) - Number(a.resumable) || a.timeMs - b.timeMs)
        .map(r => r.url);
}

export interface DownloadOptions extends NetOptions {
    /** Exact size of the file; 0 when unknown. */
    expectedSize: number;
    onProgress?: (received: number, total: number) => void;
    /** Consecutive attempts per source that may each resume where the last stopped. */
    maxAttemptsPerSource?: number;
    /** Called after a failed attempt, before resuming from `offset`. */
    onRetry?: (offset: number, error: unknown) => void;
}

function fileSize(filePath: string): number {
    try {
        return fs.statSync(filePath).size;
    } catch {
        return 0;
    }
}

/**
 * Fetch one source into `destPath`, appending from `offset` when the server
 * honours Range. Resolves with the bytes written; rejects with `received`
 * attached so the caller can tell a drop after progress from a dead source.
 */
async function fetchInto(source: string, destPath: string, offset: number, opts: DownloadOptions): Promise<number> {
    const headers = { ...opts.headers };
    if (offset > 0) headers['Range'] = `bytes=${offset}-`;
    const { res } = await openUrl(source, { ...opts, headers });
    const code = res.statusCode || 0;
    const total = opts.expectedSize;

    let flags: 'a' | 'w';
    let base: number;
    if (code === 206 && offset > 0) {
        const range = parseContentRange(res.headers['content-range']);
        if (!range || range.start !== offset || (total > 0 && range.total !== null && range.total !== total)) {
            res.destroy();
            throw new Error('续传位置或文件大小与预期不符');
        }
        flags = 'a';
        base = offset;
    } else if (code === 200) {
        const length = Number(res.headers['content-length'] || 0);
        if (isHtml(res) || (total > 0 && length > 0 && length !== total)) {
            res.destroy();
            throw new Error('下载源返回的不是安装包');
        }
        // Range ignored (or no partial yet): start over.
        flags = 'w';
        base = 0;
    } else {
        res.resume();
        throw new Error(`HTTP ${code}`);
    }

    return new Promise<number>((resolve, reject) => {
        const file = fs.createWriteStream(destPath, { flags });
        let received = 0;
        let failure: Error | null = null;
        const fail = (err: Error, keepWritten = true) => {
            if (failure) return;
            failure = err;
            res.unpipe(file);
            res.destroy();
            // Flush what already arrived so the next attempt resumes after it.
            if (keepWritten) file.end();
            else file.destroy();
        };

        res.on('data', (chunk: Buffer) => {
            received += chunk.length;
            if (total > 0 && base + received > total) {
                fail(new Error('下载内容超出预期大小'), false);
                return;
            }
            opts.onProgress?.(base + received, total);
        });
        res.on('error', err => fail(err));
        res.on('aborted', () => fail(new Error('连接中断')));
        file.on('error', err => fail(err, false));
        res.pipe(file);

        // Settle only once the handle is released, so the next attempt (or the
        // hash check) sees everything that was written.
        file.once('close', () => {
            if (!failure && total > 0 && base + received < total) {
                failure = new Error('连接中断');
            }
            if (failure) {
                if (/超出预期大小/.test(failure.message)) fs.rmSync(destPath, { force: true });
                reject(Object.assign(failure, { received }));
            } else {
                resolve(received);
            }
        });
    });
}

/** An attempt must move at least this much to earn a retry on the same source. */
const MIN_PROGRESS_BYTES = 64 * 1024;

/**
 * Download a file that may be served by any of `sources` (identical bytes
 * expected; verify the result yourself). Interrupted transfers continue from
 * where they stopped: first on the same source while it keeps making
 * progress, then on the next source. A partial `destPath` left by an earlier
 * run is resumed too.
 */
export async function downloadResumable(sources: string[], destPath: string, opts: DownloadOptions): Promise<void> {
    const maxAttempts = opts.maxAttemptsPerSource ?? 20;
    const total = opts.expectedSize;
    let lastError: unknown = new Error('没有可用的下载源');

    for (const source of sources) {
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            let offset = fileSize(destPath);
            if (total > 0 && offset > total) {
                fs.rmSync(destPath, { force: true });
                offset = 0;
            }
            if (total > 0 && offset === total) return;

            try {
                await fetchInto(source, destPath, offset, opts);
                if (total === 0 || fileSize(destPath) === total) return;
            } catch (err: any) {
                lastError = err;
                opts.onRetry?.(fileSize(destPath), err);
                // Little or nothing this time: the source is dead, refusing,
                // or trickling — move on rather than burn idle timeouts on it.
                if (!(err?.received >= MIN_PROGRESS_BYTES)) break;
            }
        }
    }
    throw lastError;
}
