/*
 * Checks the self-updater's integrity gate: the installer is downloaded
 * through third-party mirrors, so it must match the digest GitHub published
 * for the asset before it is ever launched.
 *
 *   node scripts/verify-update-integrity.cjs
 */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
    parseSha256Digest,
    pickInstallerAsset,
    verifyDownloadedAsset,
} = require('../dist/main/update-integrity');

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

async function rejects(promise) {
    try {
        await promise;
        return null;
    } catch (err) {
        return err;
    }
}

(async () => {
    const HEX = 'a'.repeat(64);

    console.log('\n[1] Digest parsing');
    check('sha256:<hex> 解析为小写 hex', parseSha256Digest(`sha256:${'A'.repeat(64)}`) === HEX);
    check('缺失 digest → null', parseSha256Digest(undefined) === null);
    check('其他算法 → null', parseSha256Digest(`sha512:${HEX}`) === null);
    check('长度不对 → null', parseSha256Digest('sha256:abc') === null);

    console.log('\n[2] Asset selection');
    const assets = [
        { name: 'latest.yml', browser_download_url: 'https://github.com/x/y/releases/download/v1/latest.yml' },
        {
            name: '4RouterAi.Setup.1.2.4.exe',
            browser_download_url: 'https://github.com/x/y/releases/download/v1/4RouterAi.Setup.1.2.4.exe',
            size: 123,
            digest: `sha256:${HEX}`,
        },
    ];
    const picked = pickInstallerAsset(assets);
    check('选中 .exe 资产', picked && picked.name === '4RouterAi.Setup.1.2.4.exe');
    check('带上 size 与 digest', picked && picked.size === 123 && picked.sha256 === HEX);
    check('旧 release 无 digest → sha256 为 null',
        pickInstallerAsset([{ ...assets[1], digest: undefined }]).sha256 === null);
    check('assets 不是数组 → null', pickInstallerAsset(undefined) === null);

    console.log('\n[3] Download verification');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), '4router-update-'));
    const file = path.join(dir, 'setup.exe');
    const payload = Buffer.from('genuine installer bytes');
    fs.writeFileSync(file, payload);
    const goodHash = crypto.createHash('sha256').update(payload).digest('hex');
    const asset = { url: 'u', name: 'setup.exe', size: payload.length, sha256: goodHash };

    check('内容与 digest 一致 → 通过', (await rejects(verifyDownloadedAsset(file, asset))) === null);

    const tampered = await rejects(verifyDownloadedAsset(file, { ...asset, sha256: HEX }));
    check('镜像返回被篡改的同尺寸文件 → 拒绝', tampered && /SHA-256/.test(tampered.message), tampered && tampered.message);

    const truncated = await rejects(verifyDownloadedAsset(file, { ...asset, size: payload.length + 1 }));
    check('大小不符 → 拒绝', truncated && /大小不符/.test(truncated.message), truncated && truncated.message);

    check('无 digest 时只校验大小',
        (await rejects(verifyDownloadedAsset(file, { ...asset, sha256: null }))) === null);

    fs.rmSync(dir, { recursive: true, force: true });

    console.log(`\n${passed} passed, ${failed} failed\n`);
    process.exit(failed ? 1 : 0);
})();
