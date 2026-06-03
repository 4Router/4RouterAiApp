/*
 * web-shim.js — browser fallback for `window.routerAi`.
 *
 * In Electron, preload.js exposes `window.routerAi` via contextBridge before any
 * page script runs, so this shim sees it and bails out. In a plain remote
 * browser there is no preload, so we recreate the exact same API surface backed
 * by a single WebSocket to the app's WebBridge (see src/main/web-server.ts).
 *
 * Loaded as a classic <script> BEFORE the app.js module so `window.routerAi`
 * exists by the time the bundle captures it.
 */
(function () {
    if (window.routerAi) return; // running inside Electron — nothing to do

    document.documentElement.classList.add('web-mode');

    // Token may be supplied via ?token=... ; remember it so reconnects keep it.
    var params = new URLSearchParams(location.search);
    var token = params.get('token') || localStorage.getItem('routerWebToken') || '';
    if (token) localStorage.setItem('routerWebToken', token);

    var wsProto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    var wsUrl = wsProto + '//' + location.host + '/ws' + (token ? '?token=' + encodeURIComponent(token) : '');

    var ws = null;
    var ready = false;
    var nextId = 1;
    var pending = {};        // id -> {resolve, reject}
    var sendQueue = [];      // raw JSON strings buffered until the socket opens
    var listeners = {};      // channel -> [callbacks]

    function connect() {
        ws = new WebSocket(wsUrl);
        ws.onopen = function () {
            ready = true;
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
            // Reject in-flight calls so the UI doesn't hang, then retry.
            Object.keys(pending).forEach(function (id) {
                pending[id].reject(new Error('connection lost'));
                delete pending[id];
            });
            setTimeout(connect, 1000);
        };
        ws.onerror = function () { try { ws.close(); } catch (e) { } };
    }
    connect();

    function rawSend(obj) {
        var str = JSON.stringify(obj);
        if (ready && ws && ws.readyState === WebSocket.OPEN) ws.send(str);
        else sendQueue.push(str);
    }

    // Request/response call.
    function invoke(channel) {
        var args = Array.prototype.slice.call(arguments, 1);
        return new Promise(function (resolve, reject) {
            var id = nextId++;
            pending[id] = { resolve: resolve, reject: reject };
            rawSend({ t: 'inv', id: id, ch: channel, args: args });
        });
    }

    // Fire-and-forget call.
    function emit(channel) {
        var args = Array.prototype.slice.call(arguments, 1);
        rawSend({ t: 'snd', ch: channel, args: args });
    }

    // Register an event listener; returns an unsubscribe function (matches preload).
    function on(channel, cb) {
        (listeners[channel] || (listeners[channel] = [])).push(cb);
        return function () {
            var arr = listeners[channel];
            if (!arr) return;
            var i = arr.indexOf(cb);
            if (i >= 0) arr.splice(i, 1);
        };
    }

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
        web: {
            getStatus: function () { return invoke('web:get-status'); },
            apply: function (cfg) { return invoke('web:apply', cfg); },
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
})();
