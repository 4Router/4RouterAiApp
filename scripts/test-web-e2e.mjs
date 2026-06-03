// End-to-end probe against a RUNNING 4RouterAi app (npm start must be up).
// Talks to the live WebBridge exactly like the browser shim would.
import http from 'http';
import { WebSocket } from 'ws';

const HOST = process.env.ROUTER_WEB_HOST || '127.0.0.1';
const PORT = process.env.ROUTER_WEB_PORT || '4178';
const results = [];
const check = (n, c) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' - ' + n); };

const html = await new Promise((res, rej) => {
    const req = http.get(`http://${HOST}:${PORT}/`, (r) => { let b = ''; r.on('data', c => b += c); r.on('end', () => res({ code: r.statusCode, b })); });
    req.on('error', rej);
});
check('GET / 200', html.code === 200);
check('serves renderer', html.b.includes('4RouterAi'));

const ws = new WebSocket(`ws://${HOST}:${PORT}/ws`);
let idc = 1; const pend = {}; const buf = {};
ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.t === 'res') { const p = pend[m.id]; if (p) { delete pend[m.id]; m.ok ? p.resolve(m.data) : p.reject(new Error(m.data)); } }
    else if (m.t === 'evt' && m.ch === 'pty:data') { buf[m.args[0]] = (buf[m.args[0]] || '') + m.args[1]; }
});
const inv = (ch, ...args) => new Promise((resolve, reject) => { const id = idc++; pend[id] = { resolve, reject }; ws.send(JSON.stringify({ t: 'inv', id, ch, args })); });
const snd = (ch, ...args) => ws.send(JSON.stringify({ t: 'snd', ch, args }));

await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });
check('ws connected', true);

const ver = await inv('app:get-version');
check('app:get-version -> ' + ver, typeof ver === 'string' && ver.length > 0);

const tools = await inv('tools:list');
check('tools:list returns array', Array.isArray(tools));

// Real PTY: launch a plain terminal, run a command, expect its output back.
const sid = await inv('pty:create', 'terminal');
check('pty:create -> ' + sid, typeof sid === 'string');
await new Promise(r => setTimeout(r, 1500)); // let the shell boot
const marker = 'REMOTE_OK_' + Date.now();
snd('pty:write', sid, `echo ${marker}\r`);
await new Promise(r => setTimeout(r, 2500));
const out = buf[sid] || '';
check('terminal echoed marker', out.includes(marker));
if (!out.includes(marker)) console.log('--- captured output ---\n' + out.slice(-400));
await inv('pty:destroy', sid);

ws.close();
const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} checks passed`);
process.exit(passed === results.length ? 0 : 1);
