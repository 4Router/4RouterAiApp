/*
 * Guards the Codex config.toml that ToolManager regenerates on every launch.
 *
 * The provider block is the app's whole auth story for Codex: codex >=0.148
 * refuses to attach any Authorization header to a custom provider unless the
 * provider opts in (model-provider/src/auth.rs → `if !provider
 * .requires_openai_auth && provider.auth.is_none() { unauthenticated }`), and
 * the symptom is an opaque `401 Unauthorized: 未提供令牌` from the proxy.
 *
 * tool-manager.js only uses ConfigStore as a type, so it loads under plain
 * node with a stub store — no electron, no GUI.
 *
 *   node scripts/verify-codex-config.cjs
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const APPDATA = fs.mkdtempSync(path.join(os.tmpdir(), '4router-codexcfg-'));
process.env.APPDATA = APPDATA;

const { ToolManager } = require('../dist/main/tool-manager');

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

/** Minimal bundled-tools tree: only existsSync matters for path resolution. */
function makeBundledTools() {
    const root = path.join(APPDATA, 'bundled-tools');
    const files = [
        ['node-runtime', process.platform === 'win32' ? 'node.exe' : 'node'],
        ['node-runtime', 'node_modules', 'npm', 'bin', 'npm-cli.js'],
        ['codex', 'node_modules', '@openai', 'codex', 'bin', 'codex.js'],
    ];
    for (const parts of files) {
        const file = path.join(root, ...parts);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, '');
    }
    return root;
}

function makeStore(overrides = {}) {
    const values = {
        codexReasoningEffort: 'xhigh',
        codexVerbosity: 'high',
        codexBypassPermissions: true,
        ...overrides,
    };
    return {
        getApiKey: () => 'test-api-key',
        getBaseUrl: () => overrides.baseUrl || 'https://4router.net/v1',
        getModel: () => overrides.model || 'gpt-5.6-sol',
        get: (key) => values[key],
    };
}

const codexHome = path.join(APPDATA, '4RouterAi', 'codex-home');
const configFile = path.join(codexHome, 'config.toml');
const authFile = path.join(codexHome, 'auth.json');

function launch(store, codexVersion) {
    const toolsRoot = makeBundledTools();
    const pkgJson = path.join(toolsRoot, 'codex', 'node_modules', '@openai', 'codex', 'package.json');
    if (codexVersion) {
        fs.writeFileSync(pkgJson, JSON.stringify({ name: '@openai/codex', version: codexVersion }));
    } else {
        fs.rmSync(pkgJson, { force: true });
    }
    const manager = new ToolManager(toolsRoot, store);
    const launchConfig = manager.getLaunchConfig('codex');
    return { launchConfig, config: fs.readFileSync(configFile, 'utf-8') };
}

console.log('\n[1] Provider block carries an auth mechanism');
const first = launch(makeStore());
check('config.toml written', fs.existsSync(configFile));
check('provider section present', first.config.includes('[model_providers.4routerai]'));
check('base_url from config store', first.config.includes('base_url = "https://4router.net/v1"'));
// The regression this file exists for: without the flag codex sends no
// Authorization header and every request 401s.
check('requires_openai_auth = true', /^requires_openai_auth = true$/m.test(first.config),
    'codex >=0.148 would send no Authorization header');
const providerBlock = first.config.slice(first.config.indexOf('[model_providers.4routerai]'));
check('flag sits inside the provider section',
    /^requires_openai_auth = true$/m.test(providerBlock.split('\n[')[0]),
    'a root-level flag would be ignored by codex');

console.log('\n[2] Credentials land in auth.json, not the environment');
check('auth.json written', fs.existsSync(authFile));
const auth = JSON.parse(fs.readFileSync(authFile, 'utf-8'));
check('auth_mode = apikey', auth.auth_mode === 'apikey', JSON.stringify(auth.auth_mode));
check('key stored under OPENAI_API_KEY', auth.OPENAI_API_KEY === 'test-api-key');
check('key not exported into the child env', !('OPENAI_API_KEY' in first.launchConfig.env),
    'the key would be visible to every command codex runs');
check('CODEX_HOME points at the isolated dir',
    first.launchConfig.env.CODEX_HOME === codexHome, first.launchConfig.env.CODEX_HOME);

console.log('\n[3] Host keys regenerate, user preferences survive');
fs.appendFileSync(configFile, [
    '',
    "[projects.'/tmp/4router-test-repo']",
    'trust_level = "trusted"',
    '',
    '[model_providers.4routerai]',
    'stale_key = "dropped"',
    '',
].join('\n'));
const second = launch(makeStore({ codexBypassPermissions: false }));
check('user section preserved', second.config.includes('trust_level = "trusted"'));
check('stale provider key dropped', !second.config.includes('stale_key'));
check('single provider section', second.config.split('[model_providers.4routerai]').length === 2,
    'duplicate sections make codex reject the file');
check('auth flag still present after a merge',
    /^requires_openai_auth = true$/m.test(second.config));
check('bypass keys follow the store', !second.config.includes('approval_policy'));

console.log('\n[4] Shared background daemon stays off');
// A daemon keeps the API key and proxy it started with, and on Windows a stale
// daemon.pid whose PID got reused aborts startup with os error 5.
const noDaemon = (version) => launch(makeStore(), version).launchConfig.args.includes('--no-daemon');
check('--no-daemon on 0.163.0', noDaemon('0.163.0'));
check('--no-daemon on 0.156.0 (first release with the flag)', noDaemon('0.156.0'));
check('no --no-daemon on 0.155.0 (flag would be rejected)', !noDaemon('0.155.0'));
check('no --no-daemon when the version is unknown', !noDaemon(undefined));

console.log('\n[5] User root keys stay at the root');
// Root keys that Codex or the user wrote used to be appended after [analytics]:
// one launch filed them under that table, the next dropped them with it.
// The host keys are only host-owned at the root, not inside a user profile.
fs.writeFileSync(configFile, [
    'hide_agent_reasoning = true',
    'model = "user-model-is-overridden"',
    '',
    '[profiles.fast]',
    'model = "o4-mini"',
    'approval_policy = "on-request"',
    '',
].join('\n'));
launch(makeStore());
const third = launch(makeStore()).config;
const firstHeader = third.search(/^\[/m);
const rootPart = third.slice(0, firstHeader);
check('user root key survives two launches', /^hide_agent_reasoning = true$/m.test(third));
check('user root key sits above the first section', /^hide_agent_reasoning = true$/m.test(rootPart),
    'below a header it belongs to that table');
check('host root key still overridden', !third.includes('user-model-is-overridden'));
const profile = third.slice(third.indexOf('[profiles.fast]')).split('\n[')[0];
check('profile keeps its own model', profile.includes('model = "o4-mini"'), profile);
check('profile keeps its own approval_policy', profile.includes('approval_policy = "on-request"'), profile);

// Continuation lines of multi-line values must not be mistaken for headers.
fs.writeFileSync(configFile, [
    'developer_instructions = """',
    '[not a header]',
    'model = "inside a string"',
    '"""',
    'matrix = [',
    '  [1, 2],',
    ']',
    '',
    "[projects.'C:\\work\\[old]\\repo']",
    'trust_level = "trusted"',
    '',
].join('\n'));
launch(makeStore());
const multi = launch(makeStore()).config;
const multiRoot = multi.slice(0, multi.search(/^\[(?!not a header|1, 2)/m));
check('multi-line string kept whole at the root',
    multiRoot.includes('"""\n[not a header]\nmodel = "inside a string"\n"""'), multi);
check('multi-line array kept whole at the root', multiRoot.includes('matrix = [\n  [1, 2],\n]'), multi);
check('bracketed project path still a section', multi.includes("[projects.'C:\\work\\[old]\\repo']\ntrust_level"), multi);

console.log('\n[6] Store values are escaped as TOML strings');
fs.rmSync(configFile, { force: true });
const escaped = launch(makeStore({ baseUrl: 'https://x/v1"\ninjected = true', model: 'a\\b' })).config;
check('quote and newline in base_url escaped',
    escaped.includes('base_url = "https://x/v1\\"\\ninjected = true"') && !/^injected/m.test(escaped), escaped);
check('backslash in model escaped', escaped.includes('model = "a\\\\b"'), escaped);

console.log('');
console.log('[7] Windows launch command');
// ConPTY forwards non-default console attributes to xterm.js as explicit
// palette colors, so a RawUI color prelude here paints the tools' screens with
// the theme's ANSI white (grey under the light theme). Codex learns the theme
// from xterm.js via OSC 10/11 instead; scripts/test-console-colors.js covers
// the rendered result.
const { buildWindowsToolCommand } = require('../dist/main/pty-manager');

const command = buildWindowsToolCommand('C:/tools/node.exe', ['app.js', "it's"]);
check('tool runs first', command.startsWith('& "C:/tools/node.exe"'), command);
check('single quotes in args are doubled', command.includes("'it''s'"), command);
check('console colors left alone', !/RawUI|BackgroundColor|ForegroundColor/.test(command), command);

console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'} — ${passed} passed, ${failed} failed`);
fs.rmSync(APPDATA, { recursive: true, force: true });
process.exit(failed === 0 ? 0 : 1);
