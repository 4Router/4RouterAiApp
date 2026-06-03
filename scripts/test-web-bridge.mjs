// Standalone smoke test for the WebBridge wire protocol + static serving.
// No Electron / node-pty needed: we feed it a mock handler registry.
import http from 'http';
import { WebSocket } from 'ws';
import { fileURLToPath } from 'url';
import path from 'path';
import { WebBridge } from '../dist/main/web-server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const staticDir = path.join(__dirname, '..', 'dist', 'renderer');

let bridgeRef;
// Mock registry that mimics a couple of real channels + a fake pty.
const handlers = {
    invoke: {
        'app:get-version': () => '1.1.8-test',
        'tools:list': () => [{ id: 'terminal', name: 'Terminal' }],
        'config:get': (key) => ({ echoedKey: key }),
        // Simulate creating a pty that immediately streams data back as an event.
        'pty:create': (toolId) => {
            const id = 'sess-' + toolId;
            setTimeout(() => bridgeRef.broadcast('pty:data', [id, 'hello from ' + toolId + '\r\n']), 20);
            return id;
        },
        'boom': () => { throw new Error('intentional failure'); },
    },
    send: {
        'pty:write': (sessionId, data) => {
            // Echo writes straight back as a data event.
            bridgeRef.broadcast('pty:data', [sessionId, 'echo:' + data]);
        },
    },
};

const PORT = 4179, HOST = '127.0.0.1';
const bridge = new WebBridge(handlers, { staticDir });
bridgeRef = bridge;
await bridge.start(PORT, HOST);

const results = [];
function check(name, cond) { results.push([name, !!cond]); console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name); }

// 1) Static serving of index.html
const html = await new Promise((res) => {
    http.get(`http://${HOST}:${PORT}/`, (r) => { let b = ''; r.on('data', c => b += c); r.on('end', () => res({ code: r.statusCode, b })); });
});
check('GET / returns 200', html.code === 200);
check('index.html contains web-shim', html.b.includes('web-shim.js'));

// 2) Static serving of web-shim.js
const shim = await new Promise((res) => {
    http.get(`http://${HOST}:${PORT}/web-shim.js`, (r) => { let b = ''; r.on('data', c => b += c); r.on('end', () => res({ code: r.statusCode, ct: r.headers['content-type'], b })); });
});
check('GET /web-shim.js 200', shim.code === 200);
check('web-shim.js js mime', /javascript/.test(shim.ct || ''));
check('web-shim.js defines routerAi', shim.b.includes('window.routerAi'));

// 3) WebSocket RPC
const ws = new WebSocket(`ws://${HOST}:${PORT}/ws`);
const events = [];
let idc = 1;
const pend = {};
ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.t === 'res') { const p = pend[m.id]; if (p) { delete pend[m.id]; m.ok ? p.resolve(m.data) : p.reject(new Error(m.data)); } }
    else if (m.t === 'evt') { events.push(m); }
});
function inv(ch, ...args) { return new Promise((resolve, reject) => { const id = idc++; pend[id] = { resolve, reject }; ws.send(JSON.stringify({ t: 'inv', id, ch, args })); }); }
function snd(ch, ...args) { ws.send(JSON.stringify({ t: 'snd', ch, args })); }

await new Promise((r) => ws.on('open', r));

check('invoke app:get-version', (await inv('app:get-version')) === '1.1.8-test');
const tools = await inv('tools:list');
check('invoke tools:list', Array.isArray(tools) && tools[0].id === 'terminal');
const cfg = await inv('config:get', 'theme');
check('invoke passes args', cfg && cfg.echoedKey === 'theme');

// error propagation
let errMsg = '';
try { await inv('boom'); } catch (e) { errMsg = e.message; }
check('invoke error propagates', errMsg.includes('intentional failure'));

// unknown channel
let unkErr = '';
try { await inv('does:not-exist'); } catch (e) { unkErr = e.message; }
check('unknown channel rejected', unkErr.includes('Unknown channel'));

// pty create -> server-pushed data event
const sid = await inv('pty:create', 'terminal');
check('pty:create returns id', sid === 'sess-terminal');
await new Promise(r => setTimeout(r, 60));
check('received pty:data event', events.some(e => e.ch === 'pty:data' && e.args[0] === 'sess-terminal' && e.args[1].includes('hello from terminal')));

// send (fire-and-forget) -> echoed event
snd('pty:write', sid, 'ls\n');
await new Promise(r => setTimeout(r, 40));
check('send pty:write echoed', events.some(e => e.ch === 'pty:data' && e.args[1] === 'echo:ls\n'));

ws.close();
bridge.stop();

const failed = results.filter(([, ok]) => !ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
