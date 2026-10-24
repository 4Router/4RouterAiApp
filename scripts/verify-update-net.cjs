/*
 * Exercises the self-updater's networking against local servers that behave
 * like the mirrors and links its users actually get: connections that drop
 * mid-transfer or stall, proxies answering 200 with an HTML page, servers
 * ignoring Range, and an HTTP proxy (Clash-style) in front of HTTPS.
 *
 *   node scripts/verify-update-net.cjs
 */
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const https = require('https');
const net = require('net');
const os = require('os');
const path = require('path');
const {
    downloadResumable,
    getText,
    parseContentRange,
    probeSource,
    rankProbes,
} = require('../dist/main/update-net');
const { agreeOnRelease } = require('../dist/main/update-integrity');
const { WebCertStore } = require('../dist/main/web-cert');

let passed = 0;
let failed = 0;

function check(name, condition, detail) {
    if (condition) {
        passed++;
        console.log(`  ok   ${name}`);
    } else {
        failed++;
        console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
    }
}

async function rejects(promise) {
    try {
        await promise;
        return null;
    } catch (err) {
        return err;
    }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), '4router-updnet-'));
// A fake installer: PE magic followed by random bytes.
const PAYLOAD = Buffer.concat([Buffer.from('MZ'), crypto.randomBytes(1024 * 1024 - 2)]);
const PAYLOAD_SHA = crypto.createHash('sha256').update(PAYLOAD).digest('hex');
const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/** Bytes served per path, so tests can tell a resume from a restart. */
const served = {};

function sendRange(req, res, route, { dropAfter, stallAfter } = {}) {
    let start = 0;
    let status = 200;
    const range = /^bytes=(\d+)-$/.exec(req.headers.range || '') || /^bytes=(\d+)-(\d+)$/.exec(req.headers.range || '');
    let end = PAYLOAD.length - 1;
    if (range) {
        start = Number(range[1]);
        if (range[2]) end = Math.min(Number(range[2]), end);
        if (start >= PAYLOAD.length) {
            res.writeHead(416, { 'Content-Range': `bytes */${PAYLOAD.length}` });
            res.end();
            return;
        }
        status = 206;
    }
    const body = PAYLOAD.subarray(start, end + 1);
    const headers = { 'Content-Type': 'application/octet-stream', 'Content-Length': body.length };
    if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${PAYLOAD.length}`;
    res.writeHead(status, headers);
    const limit = dropAfter ?? stallAfter;
    if (limit !== undefined && body.length > limit) {
        res.write(body.subarray(0, limit));
        served[route] = (served[route] || 0) + limit;
        if (dropAfter !== undefined) setTimeout(() => res.destroy(), 20);
        return; // stall: keep the socket open, send nothing more
    }
    served[route] = (served[route] || 0) + body.length;
    res.end(body);
}

function handler(req, res) {
    const route = req.url.split('?')[0];
    switch (route) {
        case '/file': return sendRange(req, res, route);
        case '/flaky': return sendRange(req, res, route, { dropAfter: 200 * 1024 });
        case '/stall': return sendRange(req, res, route, { stallAfter: 100 * 1024 });
        case '/trickle': return sendRange(req, res, route, { dropAfter: 1024 });
        case '/redirect':
            res.writeHead(302, { Location: '/file' });
            return res.end();
        case '/html':
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            return res.end('<!DOCTYPE html><title>GitHub Proxy</title>');
        case '/norange': {
            // Ignores Range entirely, like some proxies do.
            served[route] = (served[route] || 0) + PAYLOAD.length;
            res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': PAYLOAD.length });
            return res.end(PAYLOAD);
        }
        case '/tampered': {
            const evil = Buffer.from(PAYLOAD);
            evil[evil.length - 1] ^= 0xff;
            res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': evil.length });
            return res.end(evil);
        }
        case '/api':
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ tag_name: 'v9.9.9' }));
        default:
            res.writeHead(404);
            return res.end();
    }
}

function listen(server) {
    return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

/** Minimal CONNECT proxy, optionally demanding credentials. */
function makeProxy(requireAuth) {
    const stats = { tunnels: 0, rejected: 0 };
    const server = http.createServer((req, res) => {
        res.writeHead(405);
        res.end();
    });
    server.on('connect', (req, clientSocket, head) => {
        const expected = 'Basic ' + Buffer.from('user:p@ss').toString('base64');
        if (requireAuth && req.headers['proxy-authorization'] !== expected) {
            stats.rejected++;
            clientSocket.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n');
            return;
        }
        stats.tunnels++;
        const [host, port] = req.url.split(':');
        const upstream = net.connect(Number(port), host, () => {
            clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
            upstream.write(head);
            upstream.pipe(clientSocket);
            clientSocket.pipe(upstream);
        });
        upstream.on('error', () => clientSocket.destroy());
        clientSocket.on('error', () => upstream.destroy());
    });
    return { server, stats };
}

(async () => {
    const origin = http.createServer(handler);
    const base = `http://127.0.0.1:${await listen(origin)}`;
    const dl = (name) => path.join(TMP, name);

    console.log('\n[1] Content-Range parsing');
    check('bytes 0-99/1000', JSON.stringify(parseContentRange('bytes 0-99/1000')) === '{"start":0,"total":1000}');
    check('unknown total', parseContentRange('bytes 5-9/*').total === null);
    check('garbage → null', parseContentRange('nope') === null);

    console.log('\n[2] Probing sources');
    const expect = { size: PAYLOAD.length, magic: Buffer.from('MZ') };
    const good = await probeSource(`${base}/file`, expect);
    check('真实文件 → 可用且支持续传', good && good.resumable === true, JSON.stringify(good));
    check('跟随重定向', (await probeSource(`${base}/redirect`, expect))?.resumable === true);
    check('返回 HTML 页的镜像 → 剔除', (await probeSource(`${base}/html`, expect)) === null);
    const noRange = await probeSource(`${base}/norange`, expect);
    check('不支持 Range → 可用但标记不可续传', noRange && noRange.resumable === false, JSON.stringify(noRange));
    check('文件头不是 MZ → 剔除', (await probeSource(`${base}/file`, { ...expect, magic: Buffer.from('PK') })) === null);
    check('大小不符 → 剔除', (await probeSource(`${base}/file`, { ...expect, size: 123 })) === null);
    check('404 → 剔除', (await probeSource(`${base}/missing`, expect)) === null);
    check('连不上 → 剔除', (await probeSource('http://127.0.0.1:1/file', expect)) === null);
    const order = rankProbes([
        { url: 'slow-resumable', timeMs: 900, resumable: true },
        null,
        { url: 'fast-plain', timeMs: 10, resumable: false },
        { url: 'fast-resumable', timeMs: 50, resumable: true },
    ]);
    check('可续传优先，其次按速度', order.join(',') === 'fast-resumable,slow-resumable,fast-plain', order.join(','));

    console.log('\n[3] Resumable download');
    const opts = { expectedSize: PAYLOAD.length, idleTimeoutMs: 2000 };

    served['/flaky'] = 0;
    await downloadResumable([`${base}/flaky`], dl('flaky.part'), opts);
    check('每 200KB 断一次的连接 → 续传完成且内容正确', sha(dl('flaky.part')) === PAYLOAD_SHA);
    check('续传而非重下（总流量 ≈ 文件大小）', served['/flaky'] === PAYLOAD.length, `served ${served['/flaky']}`);

    let retries = 0;
    await downloadResumable(
        ['http://127.0.0.1:1/dead', `${base}/html`, `${base}/flaky`],
        dl('mixed.part'),
        { ...opts, onRetry: () => retries++ },
    );
    check('跳过死链和 HTML 页，换源后完成', sha(dl('mixed.part')) === PAYLOAD_SHA);
    check('每次中断都通知界面', retries >= 5, `onRetry ×${retries}`);

    // A partial file from an earlier run is continued, not restarted.
    fs.writeFileSync(dl('resume.part'), PAYLOAD.subarray(0, 700 * 1024));
    served['/file'] = 0;
    await downloadResumable([`${base}/file`], dl('resume.part'), opts);
    check('上次残留的 .part 接着下', sha(dl('resume.part')) === PAYLOAD_SHA);
    check('只补下剩余部分', served['/file'] === PAYLOAD.length - 700 * 1024, `served ${served['/file']}`);

    // Interrupted on a resumable source, finished on one that ignores Range.
    fs.writeFileSync(dl('restart.part'), PAYLOAD.subarray(0, 300 * 1024));
    await downloadResumable([`${base}/norange`], dl('restart.part'), opts);
    check('源不支持 Range 时从头覆盖，内容仍正确', sha(dl('restart.part')) === PAYLOAD_SHA);

    // Stalled connection: headers and some bytes arrive, then nothing.
    const t0 = Date.now();
    const stalled = await rejects(downloadResumable([`${base}/stall`], dl('stall.part'), {
        ...opts, idleTimeoutMs: 500, maxAttemptsPerSource: 2,
    }));
    const elapsed = Date.now() - t0;
    check('卡住的连接按空闲超时放弃', stalled !== null && elapsed < 5000, `${elapsed}ms ${stalled && stalled.message}`);
    check('放弃前已收到的数据保留下来', fs.statSync(dl('stall.part')).size >= 100 * 1024,
        `${fs.existsSync(dl('stall.part')) && fs.statSync(dl('stall.part')).size}`);
    await downloadResumable([`${base}/file`], dl('stall.part'), opts);
    check('换个源把卡住的那份续完', sha(dl('stall.part')) === PAYLOAD_SHA);

    served['/trickle'] = 0;
    await downloadResumable([`${base}/trickle`, `${base}/file`], dl('trickle.part'), opts);
    check('只挤出一点就断的源只试一次就换', served['/trickle'] === 1024 && sha(dl('trickle.part')) === PAYLOAD_SHA,
        `trickle served ${served['/trickle']}`);

    const allDead = await rejects(downloadResumable(['http://127.0.0.1:1/a', `${base}/html`], dl('dead.part'), opts));
    check('所有源都不可用 → 报错', allDead !== null);

    const tampered = await rejects(downloadResumable([`${base}/tampered`], dl('tampered.part'), opts));
    check('篡改的文件照样下完（交给哈希校验拦截）',
        tampered === null && sha(dl('tampered.part')) !== PAYLOAD_SHA);

    console.log('\n[4] HTTP proxy in front of HTTPS (Clash-style)');
    const certStore = new WebCertStore(path.join(TMP, 'cert.json'));
    const bundle = await certStore.ensure(['127.0.0.1']);
    const tlsOrigin = https.createServer({ key: bundle.key, cert: bundle.cert }, handler);
    const tlsBase = `https://127.0.0.1:${await listen(tlsOrigin)}`;
    // The test CA isn't in the trust store; the tunnel, not TLS trust, is under test.
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    process.emitWarning = () => { };

    const proxy = makeProxy(false);
    const proxyUrl = `http://127.0.0.1:${await listen(proxy.server)}`;
    const viaProxy = await getText(`${tlsBase}/api`, { proxy: proxyUrl });
    check('经代理 CONNECT 访问 HTTPS', viaProxy.statusCode === 200 && viaProxy.body.includes('v9.9.9'), viaProxy.body);
    check('请求确实走了代理', proxy.stats.tunnels === 1, `tunnels=${proxy.stats.tunnels}`);
    await downloadResumable([`${tlsBase}/flaky`], dl('proxied.part'), { ...opts, proxy: proxyUrl });
    check('经代理续传下载', sha(dl('proxied.part')) === PAYLOAD_SHA);

    const authProxy = makeProxy(true);
    const authPort = await listen(authProxy.server);
    const denied = await rejects(getText(`${tlsBase}/api`, { proxy: `http://127.0.0.1:${authPort}` }));
    check('代理要求认证时报出原因', denied && /407/.test(denied.message), denied && denied.message);
    const allowed = await getText(`${tlsBase}/api`, { proxy: `http://user:p%40ss@127.0.0.1:${authPort}` });
    check('代理地址里的账号密码被使用', allowed.statusCode === 200);

    const viaHttpProxy = await rejects(getText(`${tlsBase}/api`, { proxy: 'http://127.0.0.1:1' }));
    check('代理连不上 → 报错而不是挂住', viaHttpProxy !== null);

    console.log('\n[5] Release info from mirrors needs a quorum');
    const PREFIX = 'https://github.com/4Router/4RouterAiApp/releases/download/';
    const rel = (tag, digest, url = `${PREFIX}${tag}/setup.exe`) => ({
        tag_name: tag,
        assets: [{ name: 'setup.exe', browser_download_url: url, size: 10, digest: `sha256:${digest}` }],
    });
    const A = 'a'.repeat(64);
    const B = 'b'.repeat(64);
    check('两个镜像一致 → 采信', agreeOnRelease([rel('v2', A), rel('v2', A)], 2, PREFIX)?.tag_name === 'v2');
    check('只有一个镜像 → 不采信', agreeOnRelease([rel('v2', A)], 2, PREFIX) === null);
    check('digest 不一致 → 不采信', agreeOnRelease([rel('v2', A), rel('v2', B)], 2, PREFIX) === null);
    check('多数一致胜出', agreeOnRelease([rel('v2', B), rel('v2', A), rel('v2', A)], 2, PREFIX)?.assets[0].digest === `sha256:${A}`);
    check('安装包不在本仓库 release 下 → 不计票',
        agreeOnRelease([rel('v2', A, 'https://evil.example/x.exe'), rel('v2', A, 'https://evil.example/x.exe')], 2, PREFIX) === null);
    check('HTML/垃圾回复不计票', agreeOnRelease([null, 'x', {}, rel('v2', A), rel('v2', A)], 2, PREFIX) !== null);

    for (const s of [origin, tlsOrigin, proxy.server, authProxy.server]) s.close();
    fs.rmSync(TMP, { recursive: true, force: true });
    console.log(`\n${passed} passed, ${failed} failed\n`);
    process.exit(failed ? 1 : 0);
})().catch(err => {
    console.error(err);
    process.exit(1);
});
