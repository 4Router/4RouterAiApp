// Regression test for the Win10 "Codex can't scroll up" bug.
//
// Codex's TUI pushes chat history into terminal scrollback with DECSTBM
// scroll regions anchored at screen row 1 (insert_history.rs, Standard
// mode): it restricts scrolling to [1..viewport_top], parks the cursor at
// the region bottom, and emits \r\n per history line. xterm.js moves rows
// evicted off a top-anchored region into scrollback — IF those sequences
// survive the ConPTY layer. Win10's inbox ConPTY re-renders region scrolls
// as in-place repaints, so the host terminal's scrollback never grows and
// no scrollbar appears. The bundled conpty.dll (node-pty prebuilds, same
// build VS Code ships) handles it correctly.
//
// This test drives a real pty with useConptyDll:true, runs a child that
// emits the exact Codex sequence pattern, feeds the pty output into
// @xterm/headless with the renderer's dimensions, and asserts history
// lines landed in scrollback. On Win10 + inbox ConPTY this fails; with
// the bundled dll it must pass everywhere.
//
// Usage: node scripts/test-scrollback.js
const os = require('os');
const fs = require('fs');
const path = require('path');

if (os.platform() !== 'win32') {
    console.log('SKIP - ConPTY scrollback test is Windows-only');
    process.exit(0);
}

const COLS = 120;
const ROWS = 30;
const HISTORY_LINES = 120;
const REGION_BOTTOM = 9; // history region rows 1..9, "viewport" below

const emitter = `
const ESC = String.fromCharCode(27);
const out = (s) => process.stdout.write(s);
out(ESC + '[2J' + ESC + '[H');
for (let r = ${REGION_BOTTOM + 1}; r <= ${ROWS}; r++) {
    out(ESC + '[' + r + ';1H' + 'VIEWPORT row ' + r);
}
out(ESC + '[1;${REGION_BOTTOM}r');          // DECSTBM: scroll region rows 1..${REGION_BOTTOM}
out(ESC + '[${REGION_BOTTOM};1H');          // cursor to region bottom
for (let i = 0; i < ${HISTORY_LINES}; i++) {
    out('\\r\\nHIST-' + String(i).padStart(3, '0') + ' history line payload');
}
out(ESC + '[r');                            // reset scroll region
out(ESC + '[${ROWS};1H');
out('EMIT_DONE');
setTimeout(() => process.exit(0), 300);     // let conpty drain
`;

async function runLeg(useConptyDll) {
    const pty = require('node-pty');
    const { Terminal } = require('@xterm/headless');

    const scriptFile = path.join(os.tmpdir(), `emit-history-${Date.now()}-${useConptyDll}.js`);
    fs.writeFileSync(scriptFile, emitter, 'utf-8');

    const term = new Terminal({ cols: COLS, rows: ROWS, scrollback: 10000, allowProposedApi: true });
    const p = pty.spawn(process.execPath, [scriptFile], {
        name: 'xterm-256color',
        cols: COLS,
        rows: ROWS,
        cwd: os.tmpdir(),
        env: process.env,
        useConptyDll,
    });

    let raw = '';
    p.onData(d => { raw += d; term.write(d); });
    await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('pty timeout')), 20000);
        p.onExit(() => { clearTimeout(t); resolve(); });
    });
    await new Promise(r => term.write('', r)); // flush parser
    fs.unlinkSync(scriptFile);

    const buf = term.buffer.active;
    const scrollbackRows = buf.length - ROWS;
    const seen = new Set();
    const seenInScrollback = new Set();
    for (let i = 0; i < buf.length; i++) {
        const text = buf.getLine(i)?.translateToString(true) ?? '';
        const m = text.match(/HIST-(\d{3})/);
        if (m) {
            seen.add(m[1]);
            if (i < scrollbackRows) seenInScrollback.add(m[1]);
        }
    }
    term.dispose();
    return {
        emitDone: raw.includes('EMIT_DONE'),
        scrollbackRows,
        distinct: seen.size,
        distinctInScrollback: seenInScrollback.size,
    };
}

(async () => {
    const fixed = await runLeg(true);
    console.log(`useConptyDll=true : scrollbackRows=${fixed.scrollbackRows} ` +
        `distinctHist=${fixed.distinct}/${HISTORY_LINES} inScrollback=${fixed.distinctInScrollback} ` +
        `emitDone=${fixed.emitDone}`);

    // Informational only: documents the inbox ConPTY behavior on this machine
    // (broken on Win10's frozen conhost, working on Win11's rewrite).
    try {
        const inbox = await runLeg(false);
        console.log(`useConptyDll=false: scrollbackRows=${inbox.scrollbackRows} ` +
            `distinctHist=${inbox.distinct}/${HISTORY_LINES} inScrollback=${inbox.distinctInScrollback} ` +
            `(informational, inbox ConPTY)`);
    } catch (e) {
        console.log(`useConptyDll=false: errored (${e.message}) (informational)`);
    }

    // The region holds the last few lines; everything else must have been
    // evicted into scrollback for the user to scroll up to.
    const expectEvicted = HISTORY_LINES - REGION_BOTTOM;
    const pass = fixed.emitDone
        && fixed.scrollbackRows >= expectEvicted - 5
        && fixed.distinct === HISTORY_LINES
        && fixed.distinctInScrollback >= expectEvicted - 5;
    console.log(pass ? 'PASS' : 'FAIL');
    process.exit(pass ? 0 : 1);
})().catch(e => { console.error('FAIL -', e); process.exit(1); });
