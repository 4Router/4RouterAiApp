/*
 * Exercises the remote-access entry guards against a live WebBridge.
 *
 * web-server.js / web-auth.js / web-audit.js / web-cert.js deliberately avoid
 * importing electron, so they all load under plain node with a stub config
 * store — no GUI needed.
 *
 *   node scripts/verify-web-auth.cjs
 */
const fs = require('fs');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const os = require('os');
const path = require('path');
const WebSocketClient = require('ws');

const { WebBridge } = require('../dist/main/web-server');
const { WebAuth } = require('../dist/main/web-auth');
const { WebAudit } = require('../dist/main/web-audit');
const { WebCertStore } = require('../dist/main/web-cert');

const PORT = 41987;
const ALT_PORT = 41988;
const HOST = `127.0.0.1:${PORT}`;
const TUNNEL_HOST = 'cc.example.com';
/** Everything is served under this secret segment; see WebBridge.resolvePath. */
const PREFIX = 'testprefix';
const STATIC_DIR = path.join(__dirname, '..', 'dist', 'renderer');
const AUDIT_FILE = path.join(os.tmpdir(), `4router-audit-test-${process.pid}.json`);
const ALT_AUDIT_FILE = path.join(os.tmpdir(), `4router-audit-alt-${process.pid}.json`);
const CERT_FILE = path.join(os.tmpdir(), `4router-cert-test-${process.pid}.json`);
const V1_CERT_FILE = path.join(os.tmpdir(), `4router-cert-v1-${process.pid}.json`);

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

/** Prepend the secret prefix to an app-relative path. */
function p(suffix) {
    return `/${PREFIX}${suffix}`;
}

function makeStore(prefix = PREFIX) {
    const data = { webToken: '', webDevices: [], webPathPrefix: prefix };
    return {
        getWebToken: () => data.webToken,
        setWebToken: (t) => { data.webToken = t; },
        getWebDevices: () => data.webDevices,
        setWebDevices: (d) => { data.webDevices = d; },
        getWebPathPrefix: () => data.webPathPrefix,
        setWebPathPrefix: (v) => { data.webPathPrefix = v; },
    };
}

function makeHandlers() {
    return {
        invoke: {
            'app:get-version': () => '1.1.11-test',
            'web:apply': () => 'REMOTE SHOULD NEVER SEE THIS',
        },
        send: {},
        localOnly: new Set(['web:apply']),
    };
}

function request({ method = 'GET', path: reqPath, headers = {}, body, port = PORT, tls = false }) {
    return new Promise((resolve, reject) => {
        const payload = body === undefined ? null : JSON.stringify(body);
        const transport = tls ? https : http;
        const req = transport.request({
            host: '127.0.0.1',
            port,
            method,
            path: reqPath,
            // The chain roots at the app's local CA, which this test process
            // has (deliberately) not installed; the suite inspects the chain
            // directly instead.
            rejectUnauthorized: false,
            headers: {
                Host: `127.0.0.1:${port}`,
                ...(payload ? { 'Content-Type': 'application/json' } : {}),
                ...headers,
            },
        }, (res) => {
            let text = '';
            res.on('data', (c) => { text += c; });
            res.on('end', () => {
                let json = null;
                try { json = JSON.parse(text); } catch { /* not json */ }
                resolve({ status: res.statusCode, headers: res.headers, body: text, json });
            });
        });
        req.on('error', reject);
        req.end(payload);
    });
}

/** Pull the device token out of a Set-Cookie header. */
function cookieFrom(res) {
    const raw = res.headers['set-cookie'];
    if (!raw || !raw.length) return null;
    const match = /rw_device=([^;]+)/.exec(raw[0]);
    return match ? `rw_device=${match[1]}` : null;
}

function tryWs(headers = {}, wsPath = p('/ws')) {
    return new Promise((resolve) => {
        const ws = new WebSocketClient(`ws://127.0.0.1:${PORT}${wsPath}`, {
            headers: { Host: HOST, ...headers },
        });
        const done = (result) => {
            ws.removeAllListeners();
            resolve(result);
        };
        ws.on('open', () => done({ ok: true, ws }));
        ws.on('error', (err) => done({ ok: false, error: String(err.message || err) }));
    });
}

/** Round-trip one RPC call over an open socket. */
function invoke(ws, channel, args = []) {
    return new Promise((resolve, reject) => {
        const id = Math.floor(Math.random() * 1e6);
        const timer = setTimeout(() => reject(new Error('rpc timeout')), 3000);
        const onMessage = (raw) => {
            const msg = JSON.parse(raw.toString());
            if (msg.t !== 'res' || msg.id !== id) return;
            clearTimeout(timer);
            ws.off('message', onMessage);
            resolve(msg);
        };
        ws.on('message', onMessage);
        ws.send(JSON.stringify({ t: 'inv', id, ch: channel, args }));
    });
}

/** Spin up a second bridge with overridden options, run `fn`, always tear down. */
async function withAltBridge(overrides, fn) {
    const altAuth = new WebAuth(makeStore('altprefix'));
    altAuth.ensureToken();
    const bridge = new WebBridge(makeHandlers(), {
        staticDir: STATIC_DIR,
        auth: altAuth,
        audit: new WebAudit(ALT_AUDIT_FILE),
        pathPrefix: 'altprefix',
        allowedHosts: [TUNNEL_HOST],
        requireApproval: true,
        trustedNetworks: [],
        onClientsChanged: () => { },
        ...overrides,
    });
    await bridge.start(ALT_PORT, '127.0.0.1');
    try {
        await fn(altAuth);
    } finally {
        bridge.stop();
        // Let the listener release the port before the next bridge binds it.
        await new Promise((r) => setTimeout(r, 60));
    }
}

async function main() {
    const store = makeStore();
    const auth = new WebAuth(store);
    const audit = new WebAudit(AUDIT_FILE);
    const masterToken = auth.ensureToken();

    let lastRequest = null;
    const bridge = new WebBridge(makeHandlers(), {
        staticDir: STATIC_DIR,
        auth,
        audit,
        pathPrefix: PREFIX,
        allowedHosts: [TUNNEL_HOST],
        requireApproval: true,
        trustedNetworks: [],
        onAccessRequest: (req) => { lastRequest = req; },
        onClientsChanged: () => { },
    });
    await bridge.start(PORT, '127.0.0.1');

    try {
        console.log('\n[1] Hidden entry (secret path prefix)');
        check('根路径返回 404', (await request({ path: '/' })).status === 404);
        check('猜错前缀返回 404', (await request({ path: '/admin/api/session' })).status === 404);
        check('无前缀的 API 返回 404', (await request({ path: '/api/session' })).status === 404);
        const bare404 = await request({ path: '/' });
        check('404 不泄露应用特征',
            !bare404.headers['content-security-policy'] && !/4Router/i.test(bare404.body));
        check('正确前缀可用', (await request({ path: p('/api/session') })).status === 200);
        const redirect = await request({ path: `/${PREFIX}` });
        check('缺尾斜杠时 301 到带斜杠地址',
            redirect.status === 301 && redirect.headers.location === `/${PREFIX}/`,
            `${redirect.status} ${redirect.headers.location}`);
        const wrongWs = await tryWs({}, '/ws');
        check('无前缀的 WebSocket 被拒', !wrongWs.ok && /404/.test(wrongWs.error), wrongWs.error);

        console.log('\n[2] Host header allow-list (DNS-rebinding guard)');
        check('本机 Host 放行', (await request({ path: p('/api/session') })).status === 200);
        check('未声明的域名被拒 (400)',
            (await request({ path: p('/api/session'), headers: { Host: 'attacker.com' } })).status === 400);
        check('已声明的隧道域名放行（带 TLS 标记）', (await request({
            path: p('/api/session'),
            headers: { Host: TUNNEL_HOST, 'X-Forwarded-Proto': 'https' },
        })).status === 200);

        console.log('\n[3] Origin same-origin check (cross-site guard)');
        check('同源 Origin 放行',
            (await request({ path: p('/api/session'), headers: { Origin: `http://${HOST}` } })).status === 200);
        check('第三方页面的 Origin 被拒 (403)',
            (await request({ path: p('/api/session'), headers: { Origin: 'http://evil.com' } })).status === 403);
        check('无 Origin（CLI 客户端）放行',
            (await request({ path: p('/api/session') })).status === 200);
        const evilWs = await tryWs({ Origin: 'http://evil.com' });
        check('恶意网页的 WebSocket 被拒', !evilWs.ok && /403/.test(evilWs.error), evilWs.error);

        console.log('\n[4] Encrypted-transport requirement');
        check('本机回环访问放行（不过网络）',
            (await request({ path: p('/api/session') })).status === 200);
        const plainTunnel = await request({ path: p('/api/session'), headers: { Host: TUNNEL_HOST } });
        check('隧道未加密时拒绝 (403)', plainTunnel.status === 403, `got ${plainTunnel.status}`);
        check('拒绝页说明原因并给出解决办法',
            /连接未加密/.test(plainTunnel.body) && /内置 HTTPS/.test(plainTunnel.body));
        check('隧道声明 https 后放行', (await request({
            path: p('/api/session'),
            headers: { Host: TUNNEL_HOST, 'X-Forwarded-Proto': 'https' },
        })).status === 200);
        const forgedWs = await tryWs({ Host: TUNNEL_HOST });
        check('未加密隧道的 WebSocket 被拒', !forgedWs.ok && /403/.test(forgedWs.error), forgedWs.error);

        console.log('\n[5] /ws requires a credential');
        const bare = await tryWs();
        check('无凭证连接被拒 (401)', !bare.ok && /401/.test(bare.error), bare.error);
        const bearer = await tryWs({ Authorization: `Bearer ${masterToken}` });
        check('仅凭主令牌也需批准 (403)', !bearer.ok && /403/.test(bearer.error), bearer.error);

        console.log('\n[6] Pairing-code flow');
        const { code } = auth.createPairingCode();
        check('错误配对码被拒 (401)',
            (await request({ method: 'POST', path: p('/api/pair'), body: { code: '00000000' } })).status === 401);
        const goodPair = await request({ method: 'POST', path: p('/api/pair'), body: { code } });
        const deviceCookie = cookieFrom(goodPair);
        check('正确配对码换到设备 cookie', goodPair.status === 200 && !!deviceCookie);
        const setCookie = goodPair.headers['set-cookie'][0];
        check('cookie 为 HttpOnly + SameSite=Strict + 限定前缀路径',
            /HttpOnly/i.test(setCookie) && /SameSite=Strict/i.test(setCookie)
            && new RegExp(`Path=/${PREFIX}`).test(setCookie), setCookie);
        check('明文下 cookie 不带 Secure（否则浏览器不会保存）', !/Secure/i.test(setCookie));
        check('配对码一次性（重放被拒）',
            (await request({ method: 'POST', path: p('/api/pair'), body: { code } })).status === 401);
        const paired = await tryWs({ Cookie: deviceCookie });
        check('持 cookie 可连接 /ws', paired.ok, paired.error);

        console.log('\n[7] localOnly channels are refused remotely');
        if (paired.ok) {
            const allowed = await invoke(paired.ws, 'app:get-version');
            check('普通通道可用', allowed.ok === true && allowed.data === '1.1.11-test');
            const blocked = await invoke(paired.ws, 'web:apply', [{ enabled: true, allowLan: true }]);
            check('web:apply 被拒绝', blocked.ok === false && /not available remotely/.test(blocked.data));
            paired.ws.close();
        }

        console.log('\n[8] Master-token flow needs host approval');
        const reqRes = await request({
            method: 'POST', path: p('/api/access-request'), body: { token: masterToken },
        });
        check('提交令牌返回 pending', reqRes.status === 200 && reqRes.json.status === 'pending');
        check('主机收到接入请求事件', !!lastRequest && lastRequest.id === reqRes.json.requestId);
        auth.resolveRequest(reqRes.json.requestId, true);
        const approved = await request({ path: p(`/api/access-request?id=${reqRes.json.requestId}`) });
        const approvedCookie = cookieFrom(approved);
        check('批准后轮询下发 cookie', approved.json.status === 'approved' && !!approvedCookie);
        const approvedWs = await tryWs({ Cookie: approvedCookie });
        check('批准后的设备可连接', approvedWs.ok, approvedWs.error);
        if (approvedWs.ok) approvedWs.ws.close();

        const denyRes = await request({
            method: 'POST', path: p('/api/access-request'), body: { token: masterToken },
        });
        auth.resolveRequest(denyRes.json.requestId, false);
        check('被拒请求状态为 denied',
            (await request({ path: p(`/api/access-request?id=${denyRes.json.requestId}`) })).json.status === 'denied');

        console.log('\n[9] Device revocation drops the live connection');
        auth.revokeAllDevices();
        bridge.disconnectAll();
        const { code: code2 } = auth.createPairingCode();
        const pair2 = await request({ method: 'POST', path: p('/api/pair'), body: { code: code2 } });
        const cookie2 = cookieFrom(pair2);
        const live = await tryWs({ Cookie: cookie2 });
        check('新设备已连接', live.ok, live.error);
        if (live.ok) {
            const closed = new Promise((resolve) => live.ws.on('close', () => resolve(true)));
            const [device] = auth.listDevices();
            auth.revokeDevice(device.id);
            bridge.disconnectDevice(device.id);
            check('撤销后连接被踢下线', await Promise.race([
                closed, new Promise((r) => setTimeout(() => r(false), 1500)),
            ]));
            check('撤销后 cookie 失效', !(await tryWs({ Cookie: cookie2 })).ok);
        }

        console.log('\n[10] Per-IP backoff');
        auth.clearLockdown();
        auth.revokeAllDevices();
        let lockedStatus = 0;
        for (let i = 0; i < 8; i++) {
            const res = await request({ method: 'POST', path: p('/api/pair'), body: { code: '11111111' } });
            if (res.status === 429) { lockedStatus = 429; break; }
        }
        check('连续失败后触发 429 限速', lockedStatus === 429);
        check('限速期间 WS 同样被拒 (429)', /429/.test((await tryWs()).error || ''));

        console.log('\n[11] Global lockdown (distributed brute force)');
        auth.clearLockdown();
        // Per-IP backoff never trips here because every attempt looks like a new
        // source; only the global counter can catch this.
        for (let i = 0; i < 25; i++) auth.recordFailure(`10.0.0.${i}`);
        check('大量分散失败触发闭锁', auth.isLockedDown());
        check('闭锁期间拒绝新配对 (423)',
            (await request({ method: 'POST', path: p('/api/pair'), body: { code: '22222222' } })).status === 423);
        check('闭锁期间拒绝令牌接入 (423)', (await request({
            method: 'POST', path: p('/api/access-request'), body: { token: masterToken },
        })).status === 423);
        check('session 端点报告闭锁状态',
            (await request({ path: p('/api/session') })).json.lockedDown === true);
        auth.clearLockdown();
        check('手动解除后恢复', !auth.isLockedDown());

        console.log('\n[12] Static serving');
        const page = await request({ path: p('/') });
        check('首页可加载', page.status === 200 && /<html/i.test(page.body));
        const csp = String(page.headers['content-security-policy']);
        check('带 CSP frame-ancestors none', /frame-ancestors 'none'/.test(csp));
        check('CSP 兼容页面 meta 声明的字体来源',
            /fonts\.googleapis\.com/.test(csp) && /fonts\.gstatic\.com/.test(csp), csp);
        check('带 nosniff', page.headers['x-content-type-options'] === 'nosniff');
        check('带 no-referrer', page.headers['referrer-policy'] === 'no-referrer');
        check('路径遍历不返回 200', (await request({ path: p('/../package.json') })).status !== 200);
        check('编码后的路径遍历不返回 200',
            (await request({ path: p('/..%2f..%2fpackage.json') })).status !== 200);

        console.log('\n[13] Audit log');
        const events = audit.list();
        const kinds = new Set(events.map((e) => e.kind));
        check('记录了配对成功', kinds.has('pair-ok'));
        check('记录了配对失败', kinds.has('pair-fail'));
        check('记录了明文拒绝', kinds.has('reject-insecure'));
        check('记录了跨站拒绝', kinds.has('reject-origin'));
        check('记录了路径探测', kinds.has('reject-prefix'));
        check('记录了设备接入', kinds.has('connect'));
        const serialized = JSON.stringify(events);
        check('日志不含主令牌', !serialized.includes(masterToken));
        check('日志不含设备 cookie',
            !serialized.includes(String(cookie2 || 'nope').split('=')[1] || 'nope'));

        console.log('\n[14] Trusted network exemption');
        await withAltBridge({ trustedNetworks: ['127.0.0.0/8'] }, async () => {
            check('受信任网段内的明文连接放行', (await request({
                port: ALT_PORT, path: '/altprefix/api/session', headers: { Host: TUNNEL_HOST },
            })).status === 200);
            check('受信任网段不影响 Host 校验', (await request({
                port: ALT_PORT, path: '/altprefix/api/session', headers: { Host: 'attacker.com' },
            })).status === 400);
        });

        console.log('\n[15] No plaintext escape hatch');
        // There is deliberately no setting that accepts plaintext from the
        // network — the built-in HTTPS option covers the LAN case instead.
        await withAltBridge({}, async () => {
            check('本机访问放行（不过网络）',
                (await request({ port: ALT_PORT, path: '/altprefix/api/session' })).status === 200);
            check('局域网 IP 冒充的明文请求被拒', (await request({
                port: ALT_PORT, path: '/altprefix/api/session',
                headers: { Host: TUNNEL_HOST, 'X-Forwarded-For': '192.168.1.20' },
            })).status === 403);
            check('伪造 X-Forwarded-Proto 无法从非回环绕过（回环仍受 Host 约束）', (await request({
                port: ALT_PORT, path: '/altprefix/api/session',
                headers: { Host: 'attacker.com', 'X-Forwarded-Proto': 'https' },
            })).status === 400);
        });

        console.log('\n[16] Built-in HTTPS (local CA)');
        const certStore = new WebCertStore(CERT_FILE);
        const bundle = await certStore.ensure(['192.168.1.50', TUNNEL_HOST]);
        check('签发出证书与私钥',
            /BEGIN CERTIFICATE/.test(bundle.cert) && /BEGIN PRIVATE KEY/.test(bundle.key));
        check('指纹为 SHA-256 格式',
            /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/.test(bundle.fingerprint), bundle.fingerprint);
        const parsed = new crypto.X509Certificate(bundle.cert);
        check('SAN 覆盖局域网 IP', parsed.subjectAltName.includes('192.168.1.50'), parsed.subjectAltName);
        check('SAN 覆盖隧道域名', parsed.subjectAltName.includes(TUNNEL_HOST), parsed.subjectAltName);
        check('SAN 始终含回环', parsed.subjectAltName.includes('127.0.0.1'), parsed.subjectAltName);

        // mkcert 模式:叶子证书由本地根 CA 签发,信任锚定在 CA 上。
        const caParsed = new crypto.X509Certificate(bundle.ca.cert);
        check('根证书是 CA', caParsed.ca === true, bundle.ca.cert.slice(0, 60));
        check('叶子证书不是 CA', parsed.ca === false);
        check('叶子证书由本地 CA 签发',
            parsed.verify(caParsed.publicKey) && parsed.issuer === caParsed.subject);
        check('服务端证书链含叶子与 CA',
            (bundle.chain.match(/BEGIN CERTIFICATE/g) || []).length === 2);
        check('CA 指纹为 SHA-256 格式',
            /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/.test(bundle.ca.fingerprint), bundle.ca.fingerprint);

        check('复用已覆盖的证书', (await certStore.ensure([TUNNEL_HOST])).fingerprint === bundle.fingerprint);
        const reissued = await certStore.ensure(['10.1.2.3']);
        check('地址集变化时重新签发', reissued.fingerprint !== bundle.fingerprint);
        check('重新签发沿用同一根证书', reissued.ca.fingerprint === bundle.ca.fingerprint);

        certStore.clearLeaf();
        check('清除叶子后暂无可用证书', certStore.load() === null);
        const afterClear = await certStore.ensure(['10.1.2.3']);
        check('仅重签叶子:换新证书但根证书不变',
            afterClear.fingerprint !== reissued.fingerprint
            && afterClear.ca.fingerprint === bundle.ca.fingerprint);

        // 旧版(v1,裸自签叶子)文件不再被接受,自动升级为 CA 模式。
        fs.writeFileSync(V1_CERT_FILE, JSON.stringify({
            key: 'k', cert: 'c', fingerprint: 'f', hosts: ['localhost'],
            createdAt: 1, expiresAt: Date.now() + 1e10,
        }));
        const migStore = new WebCertStore(V1_CERT_FILE);
        check('旧版证书文件被弃用', migStore.load() === null);
        const migBundle = await migStore.ensure([]);
        check('旧文件自动升级为 CA 模式',
            !!migBundle.ca && new crypto.X509Certificate(migBundle.ca.cert).ca === true);

        // 未启用内置 HTTPS 的桥没有 CA 可供下载。
        check('明文桥上无根证书可下载', (await request({ path: p('/api/ca') })).status === 404);

        const tlsBundle = certStore.load();
        await withAltBridge(
            { tls: { key: tlsBundle.key, cert: tlsBundle.chain, caCert: tlsBundle.ca.cert } },
            async (altAuth) => {
                // 根证书是公开材料,设备要先拿到它才能建立信任,所以无需凭证即可下载。
                const caDl = await request({
                    port: ALT_PORT, tls: true, path: '/altprefix/api/ca',
                    headers: { Host: TUNNEL_HOST },
                });
                check('可下载根证书 (DER)',
                    caDl.status === 200
                    && /x-x509-ca-cert/.test(String(caDl.headers['content-type']))
                    && caDl.body.charCodeAt(0) === 0x30,
                    `${caDl.status} ${caDl.headers['content-type']}`);
                check('根证书以附件形式下发',
                    /attachment/.test(String(caDl.headers['content-disposition'])));
                const res = await request({
                    port: ALT_PORT, tls: true, path: '/altprefix/api/session',
                    headers: { Host: TUNNEL_HOST },
                });
                check('HTTPS 下远程访问放行（无需任何降级）', res.status === 200, `got ${res.status}`);

                const { code: altCode } = altAuth.createPairingCode();
                const pair = await request({
                    port: ALT_PORT, tls: true, method: 'POST', path: '/altprefix/api/pair',
                    headers: { Host: TUNNEL_HOST }, body: { code: altCode },
                });
                check('HTTPS 下配对成功', pair.status === 200);
                check('HTTPS 下 cookie 带 Secure',
                    /Secure/i.test(String(pair.headers['set-cookie']?.[0] || '')),
                    String(pair.headers['set-cookie']?.[0]));

                const plainHit = await request({
                    port: ALT_PORT, path: '/altprefix/api/session', headers: { Host: TUNNEL_HOST },
                }).catch(() => ({ status: 0 }));
                check('明文请求打到 TLS 端口取不到内容', plainHit.status !== 200, `got ${plainHit.status}`);
            },
        );
        console.log('\n[17] Port conflict handling');
        // An unrelated service squatting on the configured port is common
        // (OEM background services, other dev servers), so start() must fail
        // cleanly and leave the instance reusable on another port.
        const squatter = http.createServer(() => { });
        await new Promise((r) => squatter.listen(ALT_PORT, '0.0.0.0', r));
        const retryBridge = new WebBridge(makeHandlers(), {
            staticDir: STATIC_DIR,
            auth: new WebAuth(makeStore('retry')),
            audit,
            pathPrefix: 'retry',
            allowedHosts: [],
            requireApproval: true,
            trustedNetworks: [],
            onClientsChanged: () => { },
        });
        let conflictCode = null;
        try {
            await retryBridge.start(ALT_PORT, '0.0.0.0');
        } catch (err) {
            conflictCode = err.code;
        }
        check('端口被占用时以 EADDRINUSE 失败', conflictCode === 'EADDRINUSE', String(conflictCode));
        check('失败后未进入运行状态', retryBridge.isRunning() === false);
        await retryBridge.start(ALT_PORT + 1, '0.0.0.0');
        check('同一实例可改用下一个端口', retryBridge.isRunning() === true);
        retryBridge.stop();
        await new Promise((r) => squatter.close(r));
    } finally {
        bridge.stop();
        audit.flush();
        for (const file of [AUDIT_FILE, ALT_AUDIT_FILE, CERT_FILE, V1_CERT_FILE]) {
            try { fs.unlinkSync(file); } catch { /* ignore */ }
        }
    }

    console.log(`\n${passed} passed, ${failed} failed\n`);
    process.exit(failed ? 1 : 0);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
