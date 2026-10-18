// Regression test for the "grey terminal" bug: tools launched by PtyManager
// must render on the xterm.js theme's own background.
//
// ConPTY forwards any non-default console attribute to xterm.js as an explicit
// palette color. A launch prelude that set $Host.UI.RawUI colors (meant to make
// codex pick a light composer) made ConPTY emit ESC[0;30;107m before the tool
// started; Claude Code and Codex then cleared the screen with it, leaving the
// theme's ANSI bright white -- #9aa1b2 grey under the light theme -- in every
// cell they did not paint themselves. Codex now asks the terminal for its
// colors instead (OSC 10/11, tui/src/terminal_probe/windows.rs), ConPTY passes
// the query through, and xterm.js answers with the app theme.
//
// Both bundled tools run through PtyManager -- the app's real PowerShell +
// ConPTY path -- into @xterm/headless, with OSC 10/11 answered the way the
// browser xterm.js does. Asserted for a light and a dark theme:
//   - no cell has a 16-color palette background (nothing leaked from the console);
//   - codex's composer surface sits on the same side (light/dark) as the theme.
// A control run re-adds the old prelude and must come out grey, so the first
// check cannot silently lose its teeth. Each run gets its own process because
// node-pty can hang on exit while a pseudoconsole is still open.
//
// Manual (needs bundled tools and a built dist/, ~1 min), like test-scrollback.js.
// Usage: npm run build:main && node scripts/test-console-colors.js
const os = require('os');
const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

if (os.platform() !== 'win32') {
    console.log('SKIP - ConPTY color test is Windows-only');
    process.exit(0);
}

const ROOT = path.join(__dirname, '..');
const TOOLS = path.join(ROOT, 'resources', 'bundled-tools');
const DIST = path.join(ROOT, 'dist', 'main');
/** PtyManager spawns every pty at 120x30. */
const COLS = 120;
const ROWS = 30;
/** Give up on a tool that never reaches its main screen. */
const STARTUP_TIMEOUT_MS = 40000;
/** The screen counts as settled once output pauses this long. */
const QUIET_MS = 2500;
/** Codex's app-server socket path must fit in SUN_LEN and it refuses helper
 *  binaries under %TEMP%, so the fake %APPDATA% lives in a short dir under home. */
const SCRATCH = path.join(os.homedir(), '.4rt');
const RUN_ENV = 'CONSOLE_COLORS_RUN';

/** Default colors of the xterm.js themes in src/renderer/app.js getTerminalTheme(). */
const THEMES = {
    light: { fg: '#2a3040', bg: '#ffffff' },
    dark: { fg: '#dde3ee', bg: '#0e1117' },
};
/** Text each tool shows once its main screen is up. */
const READY_TEXT = {
    'claude-code': 'bypass permissions on',
    codex: 'Ask Codex to do anything',
};
/** The launch prelude that caused the bug; only the control run uses it. */
const OLD_PRELUDE = "$Host.UI.RawUI.BackgroundColor='White'; $Host.UI.RawUI.ForegroundColor='Black';";
const POWERSHELL = path.join(process.env.SystemRoot || 'C:\\Windows',
    'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

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
    return condition;
}

/** '#rrggbb' -> the 16-bit-per-channel form xterm.js replies with. */
const xtermRgb = hex => 'rgb:' + [1, 3, 5]
    .map(i => (parseInt(hex.slice(i, i + 2), 16) * 257).toString(16).padStart(4, '0'))
    .join('/');
/** Rec. 601 luma — good enough to answer "is this light or dark?". */
const luma = ([r, g, b]) => 0.299 * r + 0.587 * g + 0.114 * b;
const show = rgbs => rgbs.map(c => `rgb(${c.join(',')})`).join(', ') || 'none';

/** Pre-accepts the first-run prompts so both tools go straight to their main screen. */
function seedFirstRunState(appData, cwd) {
    fs.mkdirSync(cwd, { recursive: true });
    const claudeHome = path.join(appData, '4RouterAi', 'claude-home');
    fs.mkdirSync(claudeHome, { recursive: true });
    const trusted = { hasTrustDialogAccepted: true };
    fs.writeFileSync(path.join(claudeHome, '.claude.json'), JSON.stringify({
        hasCompletedOnboarding: true,
        bypassPermissionsModeAccepted: true,
        projects: { [cwd]: trusted, [cwd.replace(/\\/g, '/')]: trusted },
    }));
    const codexHome = path.join(appData, '4RouterAi', 'codex-home');
    fs.mkdirSync(codexHome, { recursive: true });
    fs.writeFileSync(path.join(codexHome, 'config.toml'), `[projects.'${cwd}']\ntrust_level = "trusted"\n`);
}

/** Re-adds a launch prelude by running the tool through a nested PowerShell on
 *  the same console; -EncodedCommand sidesteps every quoting layer. */
function withPrelude(tools, prelude) {
    const { buildWindowsToolCommand } = require(path.join(DIST, 'pty-manager'));
    return {
        getLaunchConfig(toolId) {
            const launch = tools.getLaunchConfig(toolId);
            const script = `${prelude} ${buildWindowsToolCommand(launch.bin, launch.args)}`;
            return {
                bin: POWERSHELL,
                args: ['-NoProfile', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
                env: launch.env,
            };
        },
    };
}

function screenText(term) {
    const buf = term.buffer.active;
    const lines = [];
    for (let y = 0; y < term.rows; y++) {
        lines.push(buf.getLine(buf.viewportY + y)?.translateToString(true) ?? '');
    }
    return lines.join('\n');
}

/** Where the visible cells' backgrounds come from. */
function screenColors(term) {
    const buf = term.buffer.active;
    const cell = buf.getNullCell();
    const legacyRows = [];
    const surfaces = new Set();
    let legacyCells = 0;
    for (let y = 0; y < term.rows; y++) {
        const line = buf.getLine(buf.viewportY + y);
        let rowLegacy = 0;
        for (let x = 0; x < term.cols; x++) {
            line.getCell(x, cell);
            if (cell.isBgPalette() && cell.getBgColor() < 16) {
                rowLegacy++;
            } else if (cell.isBgRGB()) {
                const c = cell.getBgColor();
                surfaces.add([(c >> 16) & 255, (c >> 8) & 255, c & 255].join(','));
            }
        }
        if (rowLegacy) legacyRows.push(y);
        legacyCells += rowLegacy;
    }
    return {
        legacyCells,
        legacyRows,
        surfaces: [...surfaces].map(key => key.split(',').map(Number)),
    };
}

/** Child mode: launch one tool, wait for its main screen, print a RESULT line.
 *  The parent kills this process tree afterwards. */
function runTool({ tool, theme, prelude, appData }) {
    // ToolManager writes each tool's config under %APPDATA%\4RouterAi.
    process.env.APPDATA = appData;
    const { Terminal } = require('@xterm/headless');
    const { PtyManager } = require(path.join(DIST, 'pty-manager'));
    const { ToolManager } = require(path.join(DIST, 'tool-manager'));

    const cwd = path.join(appData, 'workspace');
    seedFirstRunState(appData, cwd);
    const store = {
        getApiKey: () => 'offline-test-key',
        // Port 9 (discard) never answers.
        getBaseUrl: provider => (provider === 'openai' ? 'http://127.0.0.1:9/v1' : 'http://127.0.0.1:9'),
        getModel: () => undefined,
        get: key => ({ theme, ccBypassPermissions: true, codexBypassPermissions: true })[key],
    };
    const tools = new ToolManager(TOOLS, store);
    const ptys = new PtyManager(prelude ? withPrelude(tools, prelude) : tools);

    const term = new Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true });
    let sessionId = '';
    let lastOutput = Date.now();
    let colorQueries = 0;
    const reply = data => ptys.write(sessionId, data);
    // app.js forwards xterm's own replies (DA1, cursor position, ...) to the pty.
    term.onData(reply);
    // The browser xterm.js answers OSC 10/11 from its theme; the headless build
    // has no theme, so answer the same way here.
    for (const [slot, hex] of [[10, THEMES[theme].fg], [11, THEMES[theme].bg]]) {
        term.parser.registerOscHandler(slot, (data) => {
            if (data !== '?') return false;
            if (slot === 11) colorQueries++;
            reply(`\x1b]${slot};${xtermRgb(hex)}\x1b\\`);
            return true;
        });
    }
    ptys.onData((_id, data) => {
        lastOutput = Date.now();
        term.write(data);
    });
    sessionId = ptys.createSession(tool, cwd);

    const started = Date.now();
    const poll = setInterval(() => {
        const ready = screenText(term).includes(READY_TEXT[tool]);
        // Codex paints its composer surface only once the terminal has answered
        // its color query, which it sends a while after the composer appears.
        const drawn = ready && (tool !== 'codex' || screenColors(term).surfaces.length > 0);
        if (!(drawn && Date.now() - lastOutput >= QUIET_MS) && Date.now() - started < STARTUP_TIMEOUT_MS) return;
        clearInterval(poll);
        term.write('', () => {
            const result = { ready, colorQueries, text: screenText(term).trimEnd(), ...screenColors(term) };
            process.stdout.write(`RESULT ${JSON.stringify(result)}\n`);
        });
    }, 250);
}

/** Runs one tool in a child process; resolves to its RESULT, or null. */
function runInChild(run) {
    fs.mkdirSync(SCRATCH, { recursive: true });
    const appData = fs.mkdtempSync(path.join(SCRATCH, 'r'));
    const child = spawn(process.execPath, [__filename], {
        env: { ...process.env, [RUN_ENV]: JSON.stringify({ ...run, appData }) },
        stdio: ['ignore', 'pipe', 'inherit'],
    });
    // Takes node-pty, PowerShell, the tool and its helpers down together.
    const killTree = () => {
        try {
            execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
        } catch { /* already gone */ }
    };
    return new Promise((resolve) => {
        let out = '';
        let result = null;
        const timer = setTimeout(killTree, STARTUP_TIMEOUT_MS + 20000);
        child.stdout.on('data', (chunk) => {
            out += chunk;
            const line = /^RESULT (.*)$/m.exec(out);
            if (line && !result) {
                result = JSON.parse(line[1]);
                killTree();
            }
        });
        child.on('exit', () => {
            clearTimeout(timer);
            resolve(result);
        });
    });
}

/** Killed tool processes, and on-access scanners checking the codex binary it
 *  copies into codex-home, can hold files for a while after a run. */
async function removeScratch() {
    let error;
    for (let attempt = 0; attempt < 30; attempt++) {
        try {
            fs.rmSync(SCRATCH, { recursive: true, force: true });
            return;
        } catch (e) {
            error = e;
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }
    console.log(`\n  note: could not remove ${SCRATCH} (${error.code}); the next run clears it`);
}

async function main() {
    for (const required of [
        path.join(TOOLS, 'node-runtime', 'node.exe'),
        path.join(TOOLS, 'claude-code', 'node_modules'),
        path.join(TOOLS, 'codex', 'node_modules'),
    ]) {
        if (!fs.existsSync(required)) {
            console.log(`SKIP - bundled tools missing (${required}). Run: npm run bundle-tools`);
            process.exit(0);
        }
    }
    if (!fs.existsSync(path.join(DIST, 'pty-manager.js'))) {
        console.log('FAIL - dist/main is missing. Run: npm run build:main');
        process.exit(1);
    }

    for (const theme of Object.keys(THEMES)) {
        for (const tool of Object.keys(READY_TEXT)) {
            const label = `${tool} / ${theme}`;
            console.log(`\n[${label}]`);
            const result = await runInChild({ tool, theme });
            if (!check(`${label}: reached its main screen`, result?.ready,
                result ? `screen:\n${result.text}` : 'no result — the run crashed or hung')) {
                continue;
            }
            check(`${label}: no legacy console colors on screen`, result.legacyCells === 0,
                `${result.legacyCells} cells on rows ${result.legacyRows.join(',')}`);
            if (tool === 'codex') {
                const wantDark = theme === 'dark';
                const wrongSide = result.surfaces.filter(rgb => (luma(rgb) < 128) !== wantDark);
                check(`${label}: composer surface follows the theme`,
                    result.surfaces.length > 0 && wrongSide.length === 0,
                    `painted ${show(result.surfaces)}; color queries answered: ${result.colorQueries}`);
            }
        }
    }

    console.log('\n[control: old RawUI prelude, light theme]');
    const control = await runInChild({ tool: 'claude-code', theme: 'light', prelude: OLD_PRELUDE });
    const controlDetail = !control ? 'no result — the run crashed or hung'
        : !control.ready ? `never reached its main screen:\n${control.text}`
            : 'no legacy cells — this test may have lost its teeth';
    check('control: leaked console colors are still detected', control?.ready && control.legacyCells > 0,
        controlDetail);

    await removeScratch();
    console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'} — ${passed} passed, ${failed} failed`);
    process.exit(failed === 0 ? 0 : 1);
}

if (process.env[RUN_ENV]) {
    runTool(JSON.parse(process.env[RUN_ENV]));
} else {
    main();
}
