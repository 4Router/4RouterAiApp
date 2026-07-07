// Smoke test: spawn a pty with useConptyDll under Electron's runtime.
//
// Guards the Win10 scrollback regression: Codex pushes chat history into
// terminal scrollback via DECSTBM scroll regions, which Win10's inbox ConPTY
// mishandles (history vanishes, no scrollbar). The fix relies on node-pty's
// bundled conpty.dll, so this test verifies:
//   1. the N-API prebuild loads under Electron,
//   2. the bundled conpty.dll is genuinely loaded into the process
//      (not a silent fallback to the inbox ConPTY),
//   3. data flows and exit fires.
//
// Usage: npx electron scripts/smoke-conpty.js
const { app } = require('electron');
const path = require('path');
const fs = require('fs');

app.whenReady().then(() => {
    const pty = require('node-pty');
    console.log('[smoke] node-pty version:', require('node-pty/package.json').version);

    const dllPath = path.join(__dirname, '..', 'node_modules', 'node-pty',
        'prebuilds', `win32-${process.arch}`, 'conpty', 'conpty.dll');
    console.log('[smoke] bundled conpty.dll exists:', fs.existsSync(dllPath));

    let output = '';
    let p;
    try {
        p = pty.spawn('powershell.exe', ['-NoProfile', '-NoLogo', '-Command', 'echo CONPTY_DLL_OK; exit'], {
            name: 'xterm-256color',
            cols: 120,
            rows: 30,
            cwd: process.cwd(),
            env: process.env,
            useConptyDll: true,
        });
    } catch (e) {
        console.error('[smoke] FAIL: spawn threw:', e);
        app.exit(1);
        return;
    }

    p.onData(d => { output += d; });
    p.onExit(({ exitCode }) => {
        const ok = output.includes('CONPTY_DLL_OK');
        console.log('[smoke] pty exit code:', exitCode);
        console.log('[smoke] marker found in output:', ok);

        // The native module LoadLibrary()s the dll in-process, so it must
        // appear in the loaded-modules list with a node_modules path.
        const shared = process.report.getReport().sharedObjects || [];
        const loadedDll = shared.find(s => /node-pty[\\/].*conpty[\\/]conpty\.dll$/i.test(s));
        console.log('[smoke] bundled dll loaded in-process:', loadedDll || 'NOT FOUND');

        if (!ok || !loadedDll) {
            console.error('[smoke] FAIL. Raw output tail:', JSON.stringify(output.slice(-300)));
            app.exit(1);
            return;
        }
        console.log('[smoke] PASS');
        app.exit(0);
    });

    p.resize(100, 40); // exercise resize with useConptyDll signature

    setTimeout(() => {
        console.error('[smoke] FAIL: timeout. Output so far:', JSON.stringify(output.slice(-300)));
        app.exit(1);
    }, 20000);
});
