/*
 * Guards the startup "new recommended config" prompt (remote-config.json).
 *
 * It used to be all-or-nothing and forgetful: taking a new model meant also
 * taking every other recommendation (remote-config.json pushes Claude Code
 * effort "MAX"), and turning it down only lasted until the next launch.
 *
 *   node scripts/verify-remote-config.cjs
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const APPDATA = fs.mkdtempSync(path.join(os.tmpdir(), '4router-remotecfg-'));
process.env.APPDATA = APPDATA;

const {
    normalizeEffortLevel, diffRemoteConfig, pendingChanges, resolveChanges,
} = require('../dist/main/remote-config');
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

const keys = (changes) => changes.map(c => c.configKey).sort().join(',');

// The app's own defaults (config-store.ts) and what remote-config.json says.
const defaults = {
    models: { anthropic: 'opus', openai: 'gpt-5.3-codex' },
    codexReasoningEffort: 'xhigh',
    codexVerbosity: 'high',
    ccEffortLevel: 'high',
};
const remote = {
    models: { anthropic: 'opus[1m]', openai: 'gpt-6.1-sol' },
    codexReasoningEffort: 'xhigh',
    codexVerbosity: 'high',
    ccEffortLevel: 'MAX',
};

console.log('\n[1] Effort levels are compared the way Claude Code spells them');
check('"MAX" → max', normalizeEffortLevel('MAX') === 'max');
check('" High " → high', normalizeEffortLevel(' High ') === 'high');
check('unknown level kept as written', normalizeEffortLevel('Ultra') === 'Ultra');
check('blank → null', normalizeEffortLevel('  ') === null && normalizeEffortLevel(undefined) === null);
const sameLevel = diffRemoteConfig(remote, { ...defaults, ccEffortLevel: 'max' });
check('local "max" vs remote "MAX" is not a change', !keys(sameLevel).includes('ccEffortLevel'), keys(sameLevel));

console.log('\n[2] Diff against the defaults');
const all = diffRemoteConfig(remote, defaults);
check('models and effort differ', keys(all) === 'ccEffortLevel,models.anthropic,models.openai', keys(all));
const effort = all.find(c => c.configKey === 'ccEffortLevel');
check('effort offered as lower-case max', effort && effort.oldValue === 'high' && effort.newValue === 'max',
    JSON.stringify(effort));
check('garbage in remote config ignored',
    diffRemoteConfig({ models: { x: 42 }, ccEffortLevel: 7, codexVerbosity: null }, defaults).length === 0);

console.log('\n[3] Take the models, turn down max');
const first = resolveChanges(defaults, all, ['models.anthropic', 'models.openai'], {});
check('models taken', first.settings.models.anthropic === 'opus[1m]' && first.settings.models.openai === 'gpt-6.1-sol');
check('effort stays high', first.settings.ccEffortLevel === 'high');
check('max remembered as declined', first.declined.ccEffortLevel === 'max', JSON.stringify(first.declined));
check('input settings not mutated', defaults.models.anthropic === 'opus');

console.log('\n[4] Next launch');
const again = pendingChanges(diffRemoteConfig(remote, first.settings), first.declined);
check('nothing to ask', again.length === 0, keys(again));
const raised = pendingChanges(diffRemoteConfig({ ...remote, ccEffortLevel: 'xhigh' }, first.settings), first.declined);
check('asks again once the recommendation changes', keys(raised) === 'ccEffortLevel', keys(raised));
const newModel = pendingChanges(
    diffRemoteConfig({ ...remote, models: { ...remote.models, openai: 'gpt-6.2-sol' } }, first.settings), first.declined);
check('a new model is still offered', keys(newModel) === 'models.openai', keys(newModel));

console.log('\n[5] "Take none" and changing one\'s mind');
const none = resolveChanges(defaults, all, [], {});
check('nothing changes', JSON.stringify(none.settings) === JSON.stringify(defaults));
check('every offer declined', Object.keys(none.declined).length === all.length, JSON.stringify(none.declined));
const later = resolveChanges(first.settings, diffRemoteConfig(remote, first.settings), ['ccEffortLevel'], first.declined);
check('accepting later applies it', later.settings.ccEffortLevel === 'max');
check('and clears the refusal', !('ccEffortLevel' in later.declined), JSON.stringify(later.declined));

console.log('\n[6] Claude Code gets the effort level in lower case');
function launchClaude(effortSetting) {
    const root = path.join(APPDATA, 'bundled-tools');
    for (const parts of [
        ['node-runtime', process.platform === 'win32' ? 'node.exe' : 'node'],
        ['node-runtime', 'node_modules', 'npm', 'bin', 'npm-cli.js'],
        ['claude-code', 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js'],
    ]) {
        const file = path.join(root, ...parts);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, '');
    }
    const store = {
        getApiKey: () => 'test-api-key',
        getBaseUrl: () => 'https://4router.net',
        getModel: () => 'opus',
        get: (key) => (key === 'ccEffortLevel' ? effortSetting : undefined),
    };
    new ToolManager(root, store).getLaunchConfig('claude-code');
    const settings = JSON.parse(fs.readFileSync(path.join(APPDATA, '4RouterAi', 'claude-home', 'settings.json'), 'utf-8'));
    return settings.env.CLAUDE_CODE_EFFORT_LEVEL;
}
check('stored "MAX" → max', launchClaude('MAX') === 'max');
check('high stays high', launchClaude('high') === 'high');
check('blank → env var unset', launchClaude('') === undefined);

console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'} — ${passed} passed, ${failed} failed`);
fs.rmSync(APPDATA, { recursive: true, force: true });
process.exit(failed === 0 ? 0 : 1);
