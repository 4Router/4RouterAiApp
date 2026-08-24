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
        ['node-runtime', 'node.exe'],
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
        getBaseUrl: () => 'https://4router.net/v1',
        getModel: () => 'gpt-5.6-sol',
        get: (key) => values[key],
    };
}

const codexHome = path.join(APPDATA, '4RouterAi', 'codex-home');
const configFile = path.join(codexHome, 'config.toml');
const authFile = path.join(codexHome, 'auth.json');

function launch(store) {
    const manager = new ToolManager(makeBundledTools(), store);
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

console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'} — ${passed} passed, ${failed} failed`);
fs.rmSync(APPDATA, { recursive: true, force: true });
process.exit(failed === 0 ? 0 : 1);
