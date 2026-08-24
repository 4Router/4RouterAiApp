// Regression test for the "black composer band" bug: Codex's own idea of the
// terminal background must match the theme the app actually renders.
//
// Codex >=0.148 no longer asks the terminal for its colors on Windows (it never
// sends OSC 10/11 there). Instead it reads the console screen buffer --
// GetConsoleScreenBufferInfoEx -> wAttributes + ColorTable, see codex
// tui/src/terminal_probe.rs -- and derives its surfaces from that: the composer
// gets blend(white|black, bg, 0.12) and the accents get light/dark variants.
// PtyManager launches tools through PowerShell, which seeds those attributes
// with its own host colors (grey on black), so codex concluded "dark terminal"
// and painted the composer near-black. Under the light xterm.js theme that is a
// black band containing black default-foreground text: the user cannot see what
// they type. ToolManager.windowsConsoleColorPrelude fixes the console defaults
// before the tool starts.
//
// This test drives the bundled codex through the real PowerShell + ConPTY path
// for both a light and a dark app theme and asserts every background codex
// paints lands on the same side as the theme. No API calls: the TUI paints the
// composer at startup, before any request.
//
// Usage: node scripts/test-console-colors.js
const os = require('os');
const fs = require('fs');
const path = require('path');

if (os.platform() !== 'win32') {
    console.log('SKIP - console-color probing is Windows-only');
    process.exit(0);
}

const COLS = 110;
const ROWS = 24;
/** The TUI paints the composer within a couple of seconds; give it slack. */
const SETTLE_MS = 12000;

const ROOT = path.join(__dirname, '..');
const TOOLS = path.join(ROOT, 'resources', 'bundled-tools');
const NODE_EXE = path.join(TOOLS, 'node-runtime', 'node.exe');
const CODEX_JS = path.join(TOOLS, 'codex', 'node_modules', '@openai', 'codex', 'bin', 'codex.js');

for (const required of [NODE_EXE, CODEX_JS]) {
    if (!fs.existsSync(required)) {
        console.log(`SKIP - bundled tools missing (${required}). Run: npm run bundle-tools`);
        process.exit(0);
    }
}

const { spawn } = require('node-pty');
const { buildWindowsToolCommand } = require(path.join(ROOT, 'dist', 'main', 'pty-manager'));
const { ToolManager } = require(path.join(ROOT, 'dist', 'main', 'tool-manager'));
const { buildSanitizedEnv } = require(path.join(ROOT, 'dist', 'main', 'process-env'));

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

/** A CODEX_HOME whose provider needs no network and no login, so the TUI goes
 *  straight to the composer instead of the sign-in screen. */
function makeCodexHome(dir, cwd) {
    fs.mkdirSync(dir, { recursive: true });
    const config = [
        'model_provider = "offline"',
        'model = "gpt-5"',
        'check_for_update_on_startup = false',
        'approval_policy = "never"',
        'sandbox_mode = "danger-full-access"',
        '',
        '[model_providers.offline]',
        'name = "offline"',
        // Port 9 (discard) never answers; nothing is sent during startup anyway.
        'base_url = "http://127.0.0.1:9/v1"',
        'wire_api = "responses"',
        'env_key = "OFFLINE_TEST_KEY"',
        '',
        '[analytics]',
        'enabled = false',
        '',
        `[projects.'${cwd}']`,
        'trust_level = "trusted"',
        '',
    ].join('\n');
    fs.writeFileSync(path.join(dir, 'config.toml'), config, 'utf-8');
}

/** Runs the TUI the way PtyManager does and returns every background color it
 *  painted, as [r, g, b] triples. */
function collectBackgrounds(prelude, codexHome, cwd) {
    const command = buildWindowsToolCommand(NODE_EXE, [CODEX_JS], prelude);
    const shell = path.join(process.env.SystemRoot || 'C:\\Windows',
        'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const env = buildSanitizedEnv({
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
        CODEX_HOME: codexHome,
        OFFLINE_TEST_KEY: 'offline-test-key',
        PATH: path.join(TOOLS, 'node-runtime') + ';' + (process.env.PATH || ''),
    });

    return new Promise((resolve) => {
        let raw = '';
        const pty = spawn(shell, ['-NoProfile', '-NoLogo', '-Command', command], {
            name: 'xterm-256color', cols: COLS, rows: ROWS, cwd, env, useConptyDll: true,
        });
        pty.onData((data) => { raw += data; });
        setTimeout(() => {
            try { pty.kill(); } catch { /* already gone */ }
            const backgrounds = [];
            const sgr = /\x1b\[([0-9;]*)m/g;
            let match;
            while ((match = sgr.exec(raw)) !== null) {
                const rgb = /(?:^|;)48;2;(\d+);(\d+);(\d+)/.exec(match[1]);
                if (rgb) backgrounds.push([Number(rgb[1]), Number(rgb[2]), Number(rgb[3])]);
            }
            resolve({ backgrounds, sawComposer: raw.includes('Ask Codex to do anything') });
        }, SETTLE_MS);
    });
}

/** Codex leaves short-lived helpers running under CODEX_HOME; on Windows their
 *  open handles can outlive the pty, so cleanup is best-effort. */
function removeQuietly(dir) {
    try {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
        console.log(`  note: could not remove ${dir} (still locked); it is under TEMP`);
    }
}

/** Rec. 601 luma — good enough to answer "is this light or dark?". */
const luma = ([r, g, b]) => 0.299 * r + 0.587 * g + 0.114 * b;
const show = rgbs => rgbs.map(c => `rgb(${c.join(',')})`).join(', ') || 'none';

async function main() {
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), '4router-colors-cwd-'));

    for (const theme of ['light', 'dark']) {
        const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), `4router-colors-${theme}-`));
        makeCodexHome(codexHome, workdir);
        // Reuse the production prelude rather than restating it here.
        const prelude = new ToolManager(TOOLS, { get: key => (key === 'theme' ? theme : undefined) })
            .windowsConsoleColorPrelude();

        console.log(`\n[${theme} theme] ${prelude}`);
        const { backgrounds, sawComposer } = await collectBackgrounds(prelude, codexHome, workdir);
        check(`${theme}: TUI reached the composer`, sawComposer,
            'codex never drew the input prompt — check the bundled tools');
        console.log(`  backgrounds painted: ${show(backgrounds)}`);

        const wrongSide = theme === 'light'
            ? backgrounds.filter(rgb => luma(rgb) < 128)
            : backgrounds.filter(rgb => luma(rgb) > 128);
        check(`${theme}: no ${theme === 'light' ? 'dark' : 'light'} surfaces painted`,
            wrongSide.length === 0, show(wrongSide));

        removeQuietly(codexHome);
    }

    // Sanity-check the guard itself: with no prelude, PowerShell's grey-on-black
    // defaults leak through and codex paints the dark band this test exists to
    // catch. If this ever stops being dark the test above has lost its teeth.
    const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), '4router-colors-none-'));
    makeCodexHome(codexHome, workdir);
    console.log('\n[no prelude] (control)');
    const control = await collectBackgrounds('', codexHome, workdir);
    console.log(`  backgrounds painted: ${show(control.backgrounds)}`);
    check('control: bare PowerShell still reads as a dark console',
        control.backgrounds.length > 0 && control.backgrounds.every(rgb => luma(rgb) < 128),
        'codex no longer derives surfaces from the console palette — this test may be obsolete');
    removeQuietly(codexHome);
    removeQuietly(workdir);

    console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'} — ${passed} passed, ${failed} failed`);
    process.exit(failed === 0 ? 0 : 1);
}

main();
