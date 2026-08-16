/*
 * web-shim.js — browser fallback for `window.routerAi`.
 *
 * In Electron, preload.js exposes `window.routerAi` via contextBridge before any
 * page script runs, so this shim sees it and bails out. In a plain remote
 * browser there is no preload, so we recreate the same API surface backed by a
 * single WebSocket to the app's WebBridge (see src/main/web-server.ts).
 *
 * Reaching /ws needs a device cookie, which this file obtains through one of two
 * flows before opening the socket:
 *
 *   pairing code   the user reads an 8-digit code off the desktop app and types
 *                  it here. Generating it on the host already proves consent, so
 *                  redeeming one grants access immediately.
 *   access token   the long master token, typed in by hand. This only queues a
 *                  request; the host user still has to approve it on the
 *                  desktop, and we poll until they do.
 *
 * Credentials only ever travel in a POST body and come back as an HttpOnly
 * cookie the page itself cannot read. Nothing is kept in the URL or in
 * localStorage, so a screenshot or shared link carries no access.
 *
 * Loaded as a classic <script> BEFORE the app.js module so `window.routerAi`
 * exists by the time the bundle captures it. API calls made before the socket is
 * authorised simply queue, which keeps app.js unaware of the gate.
 */
(function () {
    if (window.routerAi) return; // running inside Electron — nothing to do

    document.documentElement.classList.add('web-mode');

    // Older builds accepted ?token= and stashed it in localStorage. Both leak the
    // master token, so scrub any leftovers rather than honouring them.
    try { localStorage.removeItem('routerWebToken'); } catch (e) { /* ignore */ }
    if (/[?&]token=/.test(location.search)) {
        history.replaceState(null, '', location.pathname + location.hash);
    }

    // The bridge serves everything under a secret path segment, so all URLs are
    // built relative to wherever this page was loaded from.
    var base = location.pathname.replace(/[^/]*$/, '');
    var wsProto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    var wsUrl = wsProto + '//' + location.host + base + 'ws';

    var ws = null;
    var ready = false;
    var nextId = 1;
    var pending = {};        // id -> {resolve, reject}
    var sendQueue = [];      // raw JSON strings buffered until the socket opens
    var listeners = {};      // channel -> [callbacks]
    var pollTimer = null;

    // ===== transport =====

    function connect() {
        ws = new WebSocket(wsUrl);
        ws.onopen = function () {
            ready = true;
            hideGate();
            while (sendQueue.length) ws.send(sendQueue.shift());
        };
        ws.onmessage = function (ev) {
            var msg;
            try { msg = JSON.parse(ev.data); } catch (e) { return; }
            if (msg.t === 'res') {
                var p = pending[msg.id];
                if (!p) return;
                delete pending[msg.id];
                if (msg.ok) p.resolve(msg.data);
                else p.reject(new Error(msg.data));
            } else if (msg.t === 'evt') {
                var cbs = listeners[msg.ch];
                if (cbs) cbs.slice().forEach(function (cb) { cb.apply(null, msg.args || []); });
            }
        };
        ws.onclose = function () {
            ready = false;
            // Reject in-flight calls so the UI doesn't hang, then decide whether
            // this was a network blip or a revoked device.
            Object.keys(pending).forEach(function (id) {
                pending[id].reject(new Error('connection lost'));
                delete pending[id];
            });
            fetchSession().then(function (session) {
                if (session && session.paired) setTimeout(connect, 1000);
                else showGate('本设备的访问已被主机撤销，请重新配对。');
            }).catch(function () {
                setTimeout(connect, 2000);
            });
        };
        ws.onerror = function () { try { ws.close(); } catch (e) { } };
    }

    function rawSend(obj) {
        var str = JSON.stringify(obj);
        if (ready && ws && ws.readyState === WebSocket.OPEN) ws.send(str);
        else sendQueue.push(str);
    }

    function invoke(channel) {
        var args = Array.prototype.slice.call(arguments, 1);
        return new Promise(function (resolve, reject) {
            var id = nextId++;
            pending[id] = { resolve: resolve, reject: reject };
            rawSend({ t: 'inv', id: id, ch: channel, args: args });
        });
    }

    function emit(channel) {
        var args = Array.prototype.slice.call(arguments, 1);
        rawSend({ t: 'snd', ch: channel, args: args });
    }

    function on(channel, cb) {
        (listeners[channel] || (listeners[channel] = [])).push(cb);
        return function () {
            var arr = listeners[channel];
            if (!arr) return;
            var i = arr.indexOf(cb);
            if (i >= 0) arr.splice(i, 1);
        };
    }

    // ===== auth API =====

    function api(method, endpoint, body) {
        return fetch(base + endpoint, {
            method: method,
            credentials: 'same-origin',
            headers: body ? { 'Content-Type': 'application/json' } : undefined,
            body: body ? JSON.stringify(body) : undefined,
        }).then(function (res) {
            return res.json().catch(function () { return {}; }).then(function (data) {
                data.__status = res.status;
                return data;
            });
        });
    }

    function fetchSession() {
        return api('GET', 'api/session');
    }

    function start() {
        fetchSession().then(function (session) {
            if (session && session.paired) {
                connect();
                return;
            }
            buildGate();
            showGate(session && session.lockedDown
                ? '桌面端检测到大量失败尝试，已暂停接受新设备。'
                : '');
        }).catch(function () {
            buildGate();
            showGate('无法连接到 4RouterAi，请确认桌面端仍在运行。');
        });
    }

    function onAuthorised() {
        stopPolling();
        connect();
    }

    function submitCode(code) {
        setGateBusy(true, '正在验证配对码…');
        api('POST', 'api/pair', { code: code }).then(function (res) {
            if (res && res.ok) {
                setGateStatus('配对成功，正在连接…', 'ok');
                onAuthorised();
                return;
            }
            setGateBusy(false, '');
            setGateStatus(gateError(res, '配对码无效或已过期'), 'err');
        }).catch(function () {
            setGateBusy(false, '');
            setGateStatus('网络错误，请重试', 'err');
        });
    }

    function submitToken(token) {
        setGateBusy(true, '正在提交访问请求…');
        api('POST', 'api/access-request', { token: token }).then(function (res) {
            if (!res || !res.ok) {
                setGateBusy(false, '');
                setGateStatus(gateError(res, '访问令牌无效'), 'err');
                showGate('');
                return;
            }
            if (res.status === 'approved') {
                setGateStatus('已授权，正在连接…', 'ok');
                onAuthorised();
                return;
            }
            setGateStatus('已通知桌面端，请在主机上点「允许」…', 'wait');
            pollRequest(res.requestId, res.expiresAt);
        }).catch(function () {
            setGateBusy(false, '');
            setGateStatus('网络错误，请重试', 'err');
            showGate('');
        });
    }

    function pollRequest(requestId, expiresAt) {
        stopPolling();
        pollTimer = setInterval(function () {
            api('GET', 'api/access-request?id=' + encodeURIComponent(requestId)).then(function (res) {
                if (!res || !res.ok) {
                    stopPolling();
                    setGateBusy(false, '');
                    setGateStatus('请求已过期，请重试', 'err');
                    return;
                }
                if (res.status === 'approved') {
                    setGateStatus('主机已允许，正在连接…', 'ok');
                    onAuthorised();
                    return;
                }
                if (res.status === 'denied' || res.status === 'expired') {
                    stopPolling();
                    setGateBusy(false, '');
                    setGateStatus(res.status === 'denied' ? '主机拒绝了此次接入' : '等待超时，请重试', 'err');
                    return;
                }
                if (expiresAt) {
                    var left = Math.max(0, Math.round((expiresAt - Date.now()) / 1000));
                    setGateStatus('已通知桌面端，请在主机上点「允许」…（' + left + 's）', 'wait');
                }
            }).catch(function () { /* keep polling */ });
        }, 1500);
    }

    function stopPolling() {
        if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    }

    function gateError(res, fallback) {
        if (!res) return fallback;
        if (res.__status === 429) {
            var secs = Math.ceil((res.retryAfterMs || 0) / 1000);
            return '尝试过于频繁，请等待 ' + (secs || 60) + ' 秒后重试';
        }
        return res.error || fallback;
    }

    // ===== pairing gate UI =====
    // Self-contained inline styling: this has to render before app.js and the
    // stylesheet it pulls in are of any use.

    var gate = null;
    var gateStatusEl = null;
    var gateFormEl = null;

    function buildGate() {
        if (gate) return;
        gate = document.createElement('div');
        gate.id = 'rw-gate';
        gate.setAttribute('style', [
            'position:fixed', 'inset:0', 'z-index:99999',
            'display:none', 'align-items:center', 'justify-content:center',
            'background:#0b0d12', 'color:#e6e9f0',
            'font-family:system-ui,-apple-system,"Segoe UI",sans-serif',
            'padding:24px', 'box-sizing:border-box',
        ].join(';'));

        var card = document.createElement('div');
        card.setAttribute('style', [
            'width:100%', 'max-width:380px',
            'background:#151922', 'border:1px solid #262d3b', 'border-radius:16px',
            'padding:28px 24px', 'box-sizing:border-box',
            'box-shadow:0 24px 60px rgba(0,0,0,.45)',
        ].join(';'));

        card.innerHTML = [
            '<div style="font-size:17px;font-weight:600;margin-bottom:6px">连接到 4RouterAi</div>',
            '<div style="font-size:12.5px;color:#8d97ad;line-height:1.6;margin-bottom:20px">',
            '在桌面端打开「设置 → 远程访问」，生成配对码后输入下方。',
            '</div>',
            '<input id="rw-gate-code" inputmode="numeric" autocomplete="one-time-code" maxlength="8" placeholder="8 位配对码" ',
            'style="width:100%;box-sizing:border-box;padding:13px 14px;font-size:20px;letter-spacing:5px;text-align:center;',
            'background:#0e121a;border:1px solid #2c3445;border-radius:10px;color:#e6e9f0;outline:none;font-family:ui-monospace,monospace">',
            '<button id="rw-gate-submit" style="width:100%;margin-top:12px;padding:12px;font-size:14px;font-weight:600;',
            'background:#4c7dff;color:#fff;border:0;border-radius:10px;cursor:pointer">连接</button>',
            '<div id="rw-gate-status" style="min-height:18px;margin-top:12px;font-size:12.5px;text-align:center;color:#8d97ad"></div>',
            '<details style="margin-top:14px">',
            '<summary style="font-size:12px;color:#8d97ad;cursor:pointer;outline:none">改用访问令牌</summary>',
            '<div style="font-size:11.5px;line-height:1.6;margin:10px 0 8px;color:#6f7a91">',
            '使用令牌接入需要主机在桌面端点「允许」。',
            '</div>',
            '<input id="rw-gate-token" type="password" autocomplete="off" placeholder="粘贴访问令牌" ',
            'style="width:100%;box-sizing:border-box;padding:10px 12px;font-size:12.5px;',
            'background:#0e121a;border:1px solid #2c3445;border-radius:8px;color:#e6e9f0;outline:none;font-family:ui-monospace,monospace">',
            '<button id="rw-gate-token-submit" style="width:100%;margin-top:8px;padding:10px;font-size:13px;',
            'background:transparent;color:#a9b4cc;border:1px solid #2c3445;border-radius:8px;cursor:pointer">提交访问请求</button>',
            '</details>',
        ].join('');

        gate.appendChild(card);
        document.body.appendChild(gate);

        gateStatusEl = card.querySelector('#rw-gate-status');
        gateFormEl = card;

        var codeInput = card.querySelector('#rw-gate-code');
        var tokenInput = card.querySelector('#rw-gate-token');

        codeInput.addEventListener('input', function () {
            codeInput.value = codeInput.value.replace(/\D/g, '').slice(0, 8);
        });
        codeInput.addEventListener('keydown', function (e) {
            if (e.key === 'Enter') card.querySelector('#rw-gate-submit').click();
        });
        card.querySelector('#rw-gate-submit').addEventListener('click', function () {
            var code = codeInput.value.trim();
            if (code.length !== 8) { setGateStatus('请输入 8 位配对码', 'err'); return; }
            submitCode(code);
        });
        tokenInput.addEventListener('keydown', function (e) {
            if (e.key === 'Enter') card.querySelector('#rw-gate-token-submit').click();
        });
        card.querySelector('#rw-gate-token-submit').addEventListener('click', function () {
            var token = tokenInput.value.trim();
            if (!token) { setGateStatus('请粘贴访问令牌', 'err'); return; }
            submitToken(token);
        });
    }

    function showGate(message) {
        buildGate();
        gate.style.display = 'flex';
        setGateBusy(false, '');
        if (message) setGateStatus(message, 'err');
    }

    function hideGate() {
        if (gate) gate.style.display = 'none';
    }

    function setGateStatus(text, kind) {
        if (!gateStatusEl) return;
        gateStatusEl.textContent = text || '';
        gateStatusEl.style.color =
            kind === 'err' ? '#ff8080' :
                kind === 'ok' ? '#61d095' :
                    kind === 'wait' ? '#e0b155' : '#8d97ad';
    }

    function setGateBusy(busy, message) {
        if (!gateFormEl) return;
        var controls = gateFormEl.querySelectorAll('input,button');
        for (var i = 0; i < controls.length; i++) {
            controls[i].disabled = !!busy;
            controls[i].style.opacity = busy ? '.55' : '1';
        }
        if (message) setGateStatus(message, 'wait');
    }

    // ===== exposed API =====

    window.routerAi = {
        tools: {
            list: function () { return invoke('tools:list'); },
            getStatus: function (toolId) { return invoke('tools:get-status', toolId); },
            update: function (toolId) { return invoke('tools:update', toolId); },
            getLaunchPreview: function (toolId) { return invoke('tools:get-launch-preview', toolId); },
            checkUpdate: function (toolId) { return invoke('tools:check-update', toolId); },
        },
        pty: {
            create: function (toolId, cwd) { return invoke('pty:create', toolId, cwd); },
            write: function (sessionId, data) { emit('pty:write', sessionId, data); },
            resize: function (sessionId, cols, rows) { emit('pty:resize', sessionId, cols, rows); },
            destroy: function (sessionId) { return invoke('pty:destroy', sessionId); },
            list: function () { return invoke('pty:list'); },
            attach: function (sessionId) { return invoke('pty:attach', sessionId); },
            onData: function (cb) { return on('pty:data', cb); },
            onExit: function (cb) { return on('pty:exit', cb); },
            onCreated: function (cb) { return on('pty:created', cb); },
            onClosed: function (cb) { return on('pty:closed', cb); },
        },
        config: {
            get: function (key) { return invoke('config:get', key); },
            set: function (key, value) { return invoke('config:set', key, value); },
            getApiKey: function (provider) { return invoke('config:get-api-key', provider); },
            setApiKey: function (provider, key) { return invoke('config:set-api-key', provider, key); },
            hasApiKey: function (provider) { return invoke('config:has-api-key', provider); },
            getBaseUrl: function (provider) { return invoke('config:get-base-url', provider); },
            setBaseUrl: function (provider, url) { return invoke('config:set-base-url', provider, url); },
            getModel: function (provider) { return invoke('config:get-model', provider); },
            setModel: function (provider, model) { return invoke('config:set-model', provider, model); },
        },
        // `web` is intentionally absent: every web:* channel administers the
        // bridge and is refused for remote callers, so app.js should skip that
        // settings section entirely (it guards on `api.web`).
        session: {
            /** Unpair this browser and return to the gate. */
            logout: function () {
                return api('POST', 'api/logout').then(function () {
                    try { if (ws) ws.close(); } catch (e) { }
                    location.reload();
                });
            },
        },
        window: {
            // Window controls act on the host Electron window; meaningless from a
            // remote browser, so they're no-ops here. CSS hides the titlebar.
            minimize: function () { },
            maximize: function () { },
            close: function () { },
            setTitleBarOverlay: function () { },
        },
        app: {
            getVersion: function () { return invoke('app:get-version'); },
            isEncryptionAvailable: function () { return invoke('app:is-encryption-available'); },
            checkAppUpdate: function () { return invoke('app:check-app-update'); },
            downloadUpdate: function (url) { return invoke('app:download-update', url); },
            onUpdateProgress: function (cb) { return on('app-update:progress', cb); },
            checkRemoteConfig: function () { return invoke('app:check-remote-config'); },
            applyRemoteConfig: function (config) { return invoke('app:apply-remote-config', config); },
            resetAll: function () { return invoke('app:reset-all'); },
        },
        auth: {
            checkLoginStatus: function () { return invoke('auth:check-login-status'); },
            isLoggedIn: function () { return invoke('auth:is-logged-in'); },
            logout: function () { return invoke('auth:logout'); },
        },
        provision: {
            createKeys: function () { return invoke('provision:create-keys'); },
        },
        dialog: {
            selectDirectory: function () { return invoke('dialog:select-directory'); },
        },
        fs: {
            readDir: function (dirPath) { return invoke('fs:read-dir', dirPath); },
        },
        clipboard: {
            readImage: function () { return invoke('clipboard:read-image'); },
        },
    };

    if (document.body) start();
    else document.addEventListener('DOMContentLoaded', start);
})();
