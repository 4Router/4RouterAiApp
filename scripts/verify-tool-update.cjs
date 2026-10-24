/*
 * Guards ToolManager's npm update path for slow and filtered networks.
 *
 * The platform tarballs are big (claude-code-win32-x64 ~136 MB,
 * codex-win32-x64 ~173 MB): a 2-minute exec timeout killed every install
 * below ~1.2 MB/s, the settings-page proxy never reached npm, and the
 * official registry — reachable but crawling from mainland China — was
 * always tried first.
 *
 * npm is never spawned: ToolManager.runFile is stubbed, so this checks the
 * exact argv / options handed to npm and the registry order it walks.
 *
 *   node scripts/verify-tool-update.cjs
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const APPDATA = fs.mkdtempSync(path.join(os.tmpdir(), '4router-toolupdate-'));
process.env.APPDATA = APPDATA;

const { ToolManager } = require('../dist/main/tool-manager');
const plan = require('../dist/main/npm-install-plan');
const { OFFICIAL_REGISTRY: OFFICIAL, CHINA_MIRROR_REGISTRY: MIRROR } = plan;

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

const PROXY = 'http://127.0.0.1:7890';
const PKG = '@anthropic-ai/claude-code';
const PLATFORM_PKG = `claude-code-${os.platform()}-${os.arch()}`;

function argAfter(args, flag) {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
}

/** Minimal bundled-tools tree: only existsSync matters for path resolution. */
function makeBundledTools(name) {
    const root = path.join(APPDATA, name);
    const files = [
        ['node-runtime', os.platform() === 'win32' ? 'node.exe' : 'node'],
        ['node-runtime', 'node_modules', 'npm', 'bin', 'npm-cli.js'],
    ];
    for (const parts of files) {
        const file = path.join(root, ...parts);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, '');
    }
    return root;
}

function makeStore(values = {}) {
    return {
        getApiKey: () => '',
        getBaseUrl: () => '',
        getModel: () => '',
        get: (key) => values[key],
    };
}

/**
 * ToolManager with a fake npm.
 *   views:    { [registry]: { version, delayMs } } — version null = unreachable
 *   installs: queue of (registry, args) => error | null for each install call
 */
function makeManager({ proxy, views, installs = [] }) {
    const root = makeBundledTools(`tools-${Math.random().toString(36).slice(2)}`);
    const manager = new ToolManager(root, makeStore({ proxy }));
    const calls = [];
    manager.runFile = (file, args, options, callback) => {
        const npmArgs = args.slice(1);
        const registry = argAfter(npmArgs, '--registry');
        const call = { command: npmArgs[0], args: npmArgs, options, registry };
        calls.push(call);
        if (call.command === 'view') {
            const view = views[registry] || { version: null, delayMs: 0 };
            setTimeout(() => view.version
                ? callback(null, `${view.version}\n`, '')
                : callback(Object.assign(new Error('Command failed: npm view'), { code: 1 }), '', 'ETIMEDOUT'),
            view.delayMs);
            return;
        }
        const behaviour = installs.shift() || (() => null);
        const error = behaviour(registry, npmArgs);
        if (!error) {
            // What a real install leaves behind: the package and its platform binary.
            const scope = path.join(root, 'claude-code', 'node_modules', '@anthropic-ai');
            fs.mkdirSync(path.join(scope, PLATFORM_PKG), { recursive: true });
            fs.mkdirSync(path.join(scope, 'claude-code'), { recursive: true });
            fs.writeFileSync(path.join(scope, 'claude-code', 'cli.js'), '');
            const version = npmArgs[1].slice(PKG.length + 1);
            fs.writeFileSync(path.join(scope, 'claude-code', 'package.json'),
                JSON.stringify({ name: PKG, version }));
        }
        setImmediate(() => callback(error, '', error ? 'npm error' : ''));
    };
    const installCalls = () => calls.filter(c => c.command === 'install');
    return { manager, calls, installCalls };
}

const probe = (registry, version, elapsedMs) => ({ registry, version, elapsedMs });
const timeoutError = () => Object.assign(new Error('Command failed: node npm-cli.js install'),
    { killed: true, signal: 'SIGTERM', code: null });

async function main() {
    console.log('\n[1] Install timeout covers a ~150 MB tarball on a slow link');
    check('timeout >= 30 minutes', plan.NPM_INSTALL_TIMEOUT_MS >= 30 * 60 * 1000,
        String(plan.NPM_INSTALL_TIMEOUT_MS));
    // 173 MB (codex-win32-x64) inside the cap needs at most ~100 KB/s.
    const neededKBps = 173 * 1024 / (plan.NPM_INSTALL_TIMEOUT_MS / 1000);
    check('173 MB finishes at <= 100 KB/s', neededKBps <= 100, `${neededKBps.toFixed(0)} KB/s`);
    check('timeout kill recognised', plan.isTimeoutKill(timeoutError()));
    check('maxBuffer kill is not a timeout', !plan.isTimeoutKill(Object.assign(new Error('x'),
        { killed: true, code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' })));
    check('ordinary failure is not a timeout', !plan.isTimeoutKill(Object.assign(new Error('x'), { code: 1 })));
    check('timeout message is in Chinese and names the cap',
        /下载超时（30 分钟内未完成）/.test(plan.describeInstallTimeout()), plan.describeInstallTimeout());

    console.log('\n[2] npm argv');
    const bare = plan.buildNpmInstallArgs(`${PKG}@2.1.200`, OFFICIAL);
    check('installs the pinned spec', bare[0] === 'install' && bare[1] === `${PKG}@2.1.200`, bare.join(' '));
    check('--registry set', argAfter(bare, '--registry') === OFFICIAL);
    check('no proxy flags without a proxy', !bare.includes('--proxy') && !bare.includes('--https-proxy'));
    check('--fetch-retries raised above the default 2', Number(argAfter(bare, '--fetch-retries')) > 2);
    check('audit/fund round-trips skipped', bare.includes('--no-audit') && bare.includes('--no-fund'));
    const proxied = plan.buildNpmInstallArgs(`${PKG}@2.1.200`, MIRROR, ` ${PROXY} `);
    check('--proxy passed (trimmed)', argAfter(proxied, '--proxy') === PROXY, proxied.join(' '));
    check('--https-proxy passed', argAfter(proxied, '--https-proxy') === PROXY);
    check('blank proxy ignored', !plan.buildNpmNetworkArgs(OFFICIAL, '  ').includes('--proxy'));

    console.log('\n[3] Registry order (planInstall)');
    let p = plan.planInstall(probe(OFFICIAL, '2.1.200', 900), probe(MIRROR, '2.1.200', 120));
    check('same version, mirror faster → mirror first, pinned',
        p.registries[0] === MIRROR && p.registries[1] === OFFICIAL && p.spec === '2.1.200', JSON.stringify(p));
    p = plan.planInstall(probe(OFFICIAL, '2.1.200', 100), probe(MIRROR, '2.1.200', 400));
    check('same version, official faster → official first', p.registries[0] === OFFICIAL, JSON.stringify(p));
    p = plan.planInstall(probe(OFFICIAL, '2.1.200', 900), probe(MIRROR, '2.1.199', 50));
    check('mirror lagging → official first, official version',
        p.registries[0] === OFFICIAL && p.spec === '2.1.200', JSON.stringify(p));
    p = plan.planInstall(probe(OFFICIAL, null, 15000), probe(MIRROR, '2.1.199', 300));
    check('official unreachable → mirror first, mirror version',
        p.registries[0] === MIRROR && p.spec === '2.1.199', JSON.stringify(p));
    p = plan.planInstall(probe(OFFICIAL, null, 15000), probe(MIRROR, null, 15000));
    check('both unreachable → latest, mirror first, official as fallback',
        p.spec === 'latest' && p.registries[0] === MIRROR && p.registries[1] === OFFICIAL, JSON.stringify(p));
    check('target version prefers official',
        plan.pickTargetVersion(probe(OFFICIAL, '2.1.200', 0), probe(MIRROR, '2.1.199', 0)) === '2.1.200');

    console.log('\n[4] updateTool: proxy, timeout and order reach npm');
    {
        const { manager, calls, installCalls } = makeManager({
            proxy: PROXY,
            views: {
                [OFFICIAL]: { version: '2.1.200', delayMs: 80 },
                [MIRROR]: { version: '2.1.200', delayMs: 5 },
            },
        });
        const result = await manager.updateTool('claude-code');
        const views = calls.filter(c => c.command === 'view');
        const installs = installCalls();
        check('update succeeds', result.success, result.error);
        check('reports the installed version', result.version === '2.1.200', result.version);
        check('both registries probed', views.length === 2
            && views.some(v => v.registry === OFFICIAL) && views.some(v => v.registry === MIRROR));
        check('probes go through the proxy', views.every(v => argAfter(v.args, '--proxy') === PROXY
            && argAfter(v.args, '--https-proxy') === PROXY));
        check('single install', installs.length === 1, String(installs.length));
        check('faster mirror used first', installs[0]?.registry === MIRROR, installs[0]?.registry);
        check('pinned to the probed version', installs[0]?.args[1] === `${PKG}@2.1.200`, installs[0]?.args[1]);
        check('install goes through the proxy', argAfter(installs[0]?.args || [], '--proxy') === PROXY
            && argAfter(installs[0]?.args || [], '--https-proxy') === PROXY);
        check('install timeout is the named constant',
            installs[0]?.options.timeout === plan.NPM_INSTALL_TIMEOUT_MS, String(installs[0]?.options.timeout));
    }
    {
        const { manager, calls } = makeManager({
            views: { [OFFICIAL]: { version: '2.1.200', delayMs: 0 }, [MIRROR]: { version: '2.1.200', delayMs: 0 } },
        });
        await manager.updateTool('claude-code');
        check('no proxy flags when no proxy is configured', calls.every(c => !c.args.includes('--proxy')));
    }

    console.log('\n[5] updateTool: fallback rules');
    {
        // Mirror leads but hasn't synced the version yet → official.
        const { manager, installCalls } = makeManager({
            views: { [OFFICIAL]: { version: '2.1.200', delayMs: 60 }, [MIRROR]: { version: '2.1.200', delayMs: 0 } },
            installs: [() => Object.assign(new Error('Command failed'), { code: 1, message: 'ETARGET No matching version' })],
        });
        const result = await manager.updateTool('claude-code');
        const installs = installCalls();
        check('ETARGET on mirror falls back to official', result.success
            && installs.length === 2 && installs[1].registry === OFFICIAL, JSON.stringify(installs.map(i => i.registry)));
        check('fallback keeps the pinned version', installs[1]?.args[1] === `${PKG}@2.1.200`);
    }
    {
        const { manager, installCalls } = makeManager({
            proxy: PROXY,
            views: { [OFFICIAL]: { version: '2.1.200', delayMs: 0 }, [MIRROR]: { version: '2.1.200', delayMs: 30 } },
            installs: [timeoutError],
        });
        const result = await manager.updateTool('claude-code');
        check('timeout is not retried on the other registry', installCalls().length === 1,
            String(installCalls().length));
        check('timeout error is readable', !result.success && /下载超时/.test(result.error || ''), result.error);
        check('timeout error mentions the proxy setting', /代理/.test(result.error || ''));
        check('no raw "Command failed" in the timeout error', !/Command failed/.test(result.error || ''));
    }
    {
        const { manager, installCalls } = makeManager({
            views: { [OFFICIAL]: { version: '2.1.200', delayMs: 0 }, [MIRROR]: { version: '2.1.200', delayMs: 30 } },
            installs: [() => Object.assign(new Error('Command failed'), { code: 1, message: 'EPERM: operation not permitted' })],
        });
        const result = await manager.updateTool('claude-code');
        check('permission error is not retried', !result.success && installCalls().length === 1,
            String(installCalls().length));
    }
    {
        // Like execFile's real error: the message echoes the full command line.
        const failure = (registry, args) => Object.assign(
            new Error(`Command failed: node npm-cli.js ${args.join(' ')}\nnpm error ECONNRESET`), { code: 1 });
        const { manager, installCalls } = makeManager({
            proxy: 'http://user:secret@127.0.0.1:7890',
            views: { [OFFICIAL]: { version: null, delayMs: 0 }, [MIRROR]: { version: null, delayMs: 0 } },
            installs: [failure, failure],
        });
        const result = await manager.updateTool('claude-code');
        const installs = installCalls();
        check('both registries tried when nothing pinned', installs.length === 2
            && installs[0].registry === MIRROR && installs[1].registry === OFFICIAL,
            JSON.stringify(installs.map(i => i.registry)));
        check('unpinned install uses @latest', installs[0]?.args[1] === `${PKG}@latest`);
        check('combined error names both registries', /npmmirror/.test(result.error || '')
            && /official registry/.test(result.error || ''), result.error);
        check('proxy credentials redacted from the error', !/secret/.test(result.error || '')
            && /<proxy>/.test(result.error || ''), result.error);
    }

    console.log('\n[6] checkUpdate agrees with updateTool on the version');
    {
        const { manager, calls } = makeManager({
            proxy: PROXY,
            views: { [OFFICIAL]: { version: '2.1.200', delayMs: 50 }, [MIRROR]: { version: '2.1.199', delayMs: 0 } },
        });
        manager.getToolStatus('claude-code').version = '2.1.100';
        const info = await manager.checkUpdate('claude-code');
        check('official latest wins over a lagging mirror', info.latestVersion === '2.1.200', info.latestVersion);
        check('update offered', info.hasUpdate === true);
        check('check probes go through the proxy', calls.every(c => argAfter(c.args, '--proxy') === PROXY));
    }
}

main().catch((e) => {
    failed++;
    console.error(e);
}).finally(() => {
    console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'} — ${passed} passed, ${failed} failed`);
    fs.rmSync(APPDATA, { recursive: true, force: true });
    process.exit(failed === 0 ? 0 : 1);
});
