/*
 * Checks semver precedence used by both update checkers.
 *
 *   node scripts/verify-version.cjs
 */
const { compareVersions, isNewerVersion } = require('../dist/main/version-compare');

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

function expectOrder(a, b, expected, label) {
    const got = compareVersions(a, b);
    check(`${label}: ${a} vs ${b}`, got === expected, `expected ${expected}, got ${got}`);
}

console.log('\n[1] Numeric segment precedence');
// The bug that started this: string comparison puts "1.1.9" above "1.1.10".
expectOrder('1.1.10', '1.1.9', 1, '两位数修订号更大');
expectOrder('1.2.0', '1.1.10', 1, '次版本优先于修订号');
expectOrder('2.0.0', '1.99.99', 1, '主版本优先');
expectOrder('1.0.0', '1.0.0', 0, '完全相同');
expectOrder('1.0.1', '1.0.2', -1, '较小的修订号');

console.log('\n[2] Prerelease precedence');
expectOrder('1.2.0-beta.1', '1.2.0', -1, '预发布低于正式版');
expectOrder('1.2.0', '1.2.0-rc.1', 1, '正式版高于预发布');
expectOrder('1.2.0-beta.2', '1.2.0-beta.1', 1, '预发布数字段按数值');
expectOrder('1.2.0-beta', '1.2.0-beta.1', -1, '标识符更少的排在前');
expectOrder('1.2.0-alpha', '1.2.0-beta', -1, '字母序');
expectOrder('1.2.0-1', '1.2.0-alpha', -1, '数字标识符低于字母标识符');

console.log('\n[3] Tolerant parsing');
expectOrder('v1.2.0', '1.2.0', 0, '去掉 v 前缀');
expectOrder('1.2.0+build9', '1.2.0+build1', 0, '忽略 build metadata');
expectOrder('1.2', '1.2.0', 0, '缺失段视为 0');
expectOrder('garbage', '0.0.0', 0, '无法解析时退化为 0');

console.log('\n[4] Update decisions');
// The two real-world regressions this guards against.
check('本地领先于发布版时不提示更新', isNewerVersion('1.1.10', '1.2.0') === false);
check('镜像滞后时不提示降级', isNewerVersion('2.1.9', '2.1.233') === false);
check('版本相同不提示更新', isNewerVersion('1.2.0', '1.2.0') === false);
check('确有新版时提示更新', isNewerVersion('1.2.1', '1.2.0') === true);
check('正式版发布后提示升级', isNewerVersion('1.2.0', '1.2.0-beta.3') === true);
check('unknown 不提示更新', isNewerVersion('unknown', '1.2.0') === false);
check('空字符串不提示更新', isNewerVersion('', '1.2.0') === false);

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
