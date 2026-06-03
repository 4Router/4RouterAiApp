// Verifies shared-session mirroring against a RUNNING app: two independent WS
// clients (simulating the desktop window + a remote browser) must see the same
// sessions, live output, and scrollback replay.
import { WebSocket } from 'ws';

const HOST = process.env.ROUTER_WEB_HOST || '127.0.0.1';
const PORT = process.env.ROUTER_WEB_PORT || '4178';
const results = [];
const check = (n, c) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' - ' + n); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function makeClient(name) {
    const ws = new WebSocket(`ws://${HOST}:${PORT}/ws`);
    let idc = 1; const pend = {};
    const buffers = {};   // sessionId -> concatenated live data
    const created = [];   // sessions announced via pty:created
    const closed = [];    // sessionIds announced via pty:closed
    ws.on('message', (raw) => {
        const m = JSON.parse(raw.toString());
        if (m.t === 'res') { const p = pend[m.id]; if (p) { delete pend[m.id]; m.ok ? p.resolve(m.data) : p.reject(new Error(m.data)); } }
        else if (m.t === 'evt') {
            if (m.ch === 'pty:data') buffers[m.args[0]] = (buffers[m.args[0]] || '') + m.args[1];
            else if (m.ch === 'pty:created') created.push(m.args[0]);
            else if (m.ch === 'pty:closed') closed.push(m.args[0]);
        }
    });
    const ready = new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
    return {
        name, ws, buffers, created, closed,
        inv: (ch, ...args) => new Promise((resolve, reject) => { const id = idc++; pend[id] = { resolve, reject }; ws.send(JSON.stringify({ t: 'inv', id, ch, args })); }),
        snd: (ch, ...args) => ws.send(JSON.stringify({ t: 'snd', ch, args })),
        ready,
    };
}

const A = makeClient('A');   // "desktop"
await A.ready;

// A creates a terminal and runs a command that produces lasting output.
const sid = await A.inv('pty:create', 'terminal');
check('A created session', typeof sid === 'string');
await sleep(1200);
const marker1 = 'SYNC_HISTORY_' + Date.now();
A.snd('pty:write', sid, `echo ${marker1}\r`);
await sleep(1500);
check('A sees its own output', (A.buffers[sid] || '').includes(marker1));

// B connects AFTER the history was produced — simulates remote browser joining.
const B = makeClient('B');
await B.ready;
const list = await B.inv('pty:list');
check('B lists the shared session', Array.isArray(list) && list.some(s => s.sessionId === sid));

// B replays scrollback via attach and must see the earlier marker.
const buf = await B.inv('pty:attach', sid);
check('B replay buffer has history', buf && typeof buf.data === 'string' && buf.data.includes(marker1));
check('B attach has endOffset', buf && typeof buf.endOffset === 'number' && buf.endOffset > 0);

// Live sync both directions: B types, A must receive it (shared PTY).
const marker2 = 'SYNC_LIVE_' + Date.now();
B.snd('pty:write', sid, `echo ${marker2}\r`);
await sleep(1500);
check('A receives B\'s live input output', (A.buffers[sid] || '').includes(marker2));
check('B receives the live output too', (B.buffers[sid] || '').includes(marker2));

// A creating a NEW session must be announced to B via pty:created.
const sid2 = await A.inv('pty:create', 'terminal');
await sleep(400);
check('B notified of new session (pty:created)', B.created.some(s => s.sessionId === sid2));

// A closing a tab must tell B to drop the mirrored tab (pty:closed).
await A.inv('pty:destroy', sid);
await sleep(400);
check('B notified of close (pty:closed)', B.closed.includes(sid));
check('closed session gone from pty:list', !(await B.inv('pty:list')).some(s => s.sessionId === sid));

await A.inv('pty:destroy', sid2);
A.ws.close(); B.ws.close();

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} checks passed`);
process.exit(passed === results.length ? 0 : 1);
