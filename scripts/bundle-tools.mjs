/**
 * bundle-tools.mjs
 * 
 * Pre-installs Claude Code and Codex CLI into the resources/bundled-tools
 * directory so they are available when the app is packaged.
 * 
 * Usage: node scripts/bundle-tools.mjs
 *
 * macOS options (environment variables):
 *   TARGET_ARCH=arm64|x64     CPU the bundle is for (default: this machine's).
 *                             Lets an Apple-silicon Mac produce the Intel bundle.
 *   BUNDLE_NODE_VERSION=v20.x Node.js release to bundle (default: the version
 *                             running this script).
 */

import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import { chmodSync, cpSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { basename, dirname, join } from 'path';
import { platform as hostPlatform, arch as hostArch, tmpdir } from 'os';

const TOOLS_DIR = join(import.meta.dirname, '..', 'resources', 'bundled-tools');
const RUNTIME_DIR = join(TOOLS_DIR, 'node-runtime');
const MINGIT_DIR = join(TOOLS_DIR, 'mingit');

const TARGET_ARCH = process.env.TARGET_ARCH || hostArch();
const IS_CROSS_ARCH = TARGET_ARCH !== hostArch();

if (IS_CROSS_ARCH && hostPlatform() !== 'darwin') {
    throw new Error(`TARGET_ARCH=${TARGET_ARCH} is only supported when bundling on macOS`);
}

/** Platform/arch the bundle is for. Only the arch can differ from the host. */
const platform = () => hostPlatform();
const arch = () => TARGET_ARCH;

const TOOLS = [
    {
        name: 'claude-code',
        package: '@anthropic-ai/claude-code',
        dir: join(TOOLS_DIR, 'claude-code'),
    },
    {
        name: 'codex',
        package: '@openai/codex',
        // version: '0.100.0', // pinned for debug — remove to use latest
        dir: join(TOOLS_DIR, 'codex'),
    },
];

function ensureDir(dirPath) {
    if (!existsSync(dirPath)) {
        mkdirSync(dirPath, { recursive: true });
    }
}

function cleanDir(dirPath) {
    if (existsSync(dirPath)) {
        rmSync(dirPath, { recursive: true, force: true });
    }
    mkdirSync(dirPath, { recursive: true });
}

function getBundledNodeExecutable() {
    return join(RUNTIME_DIR, basename(process.execPath));
}

function getBundledNpmCli() {
    return join(RUNTIME_DIR, 'node_modules', 'npm', 'bin', 'npm-cli.js');
}

function getBundledRuntimeEnv() {
    const runtimeBinDir = RUNTIME_DIR;
    const pathSep = platform() === 'win32' ? ';' : ':';
    return {
        ...process.env,
        PATH: [runtimeBinDir, process.env.PATH || ''].filter(Boolean).join(pathSep),
    };
}

/** Download `url` into `dest` (Node ≥ 18 global fetch). */
async function download(url, dest) {
    const res = await fetch(url, { headers: { 'User-Agent': '4RouterAi-Bundler' } });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}

async function fetchText(url) {
    const res = await fetch(url, { headers: { 'User-Agent': '4RouterAi-Bundler' } });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return res.text();
}

const NODE_DIST_MIRRORS = [
    'https://nodejs.org/dist',
    'https://npmmirror.com/mirrors/node',
];

/**
 * Bundle an official Node.js build on macOS.
 *
 * Copying the Node that runs this script (as Windows does) isn't safe here:
 * Homebrew's node links against Homebrew's own dylibs and won't start on a
 * Mac without them, its npm lives under lib/ rather than next to the binary,
 * and it can't produce the other CPU's runtime. The official tarball is
 * self-contained and is verified against the release's SHASUMS256.txt.
 */
async function bundleNodeRuntimeMac() {
    const version = process.env.BUNDLE_NODE_VERSION || process.version;
    const distArch = arch() === 'x64' ? 'x64' : 'arm64';
    const name = `node-${version}-darwin-${distArch}`;
    const tarball = `${name}.tar.gz`;
    console.log(`\n📦 Bundling Node.js runtime (${name})...`);

    const cacheDir = join(tmpdir(), '4routerai-bundle-cache');
    ensureDir(cacheDir);
    const cachedTarball = join(cacheDir, tarball);

    let expectedSha = null;
    let lastError = null;
    for (const base of NODE_DIST_MIRRORS) {
        try {
            const sums = await fetchText(`${base}/${version}/SHASUMS256.txt`);
            const line = sums.split('\n').find(l => l.trim().endsWith(`  ${tarball}`));
            if (!line) throw new Error(`${tarball} not listed in SHASUMS256.txt`);
            expectedSha = line.split(/\s+/)[0];

            const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
            if (!existsSync(cachedTarball) || sha256(cachedTarball) !== expectedSha) {
                console.log(`   Downloading ${base}/${version}/${tarball}`);
                await download(`${base}/${version}/${tarball}`, cachedTarball);
            } else {
                console.log(`   Using cached ${cachedTarball}`);
            }
            const actual = sha256(cachedTarball);
            if (actual !== expectedSha) {
                rmSync(cachedTarball, { force: true });
                throw new Error(`checksum mismatch for ${tarball}: expected ${expectedSha}, got ${actual}`);
            }
            lastError = null;
            break;
        } catch (err) {
            lastError = err;
            console.warn(`   ⚠️  ${base}: ${err.message}`);
        }
    }
    if (lastError) throw lastError;

    const extractDir = join(cacheDir, `${name}-extract`);
    cleanDir(extractDir);
    execFileSync('tar', ['-xzf', cachedTarball, '-C', extractDir, '--strip-components=1'], { stdio: 'inherit' });

    cleanDir(RUNTIME_DIR);
    copyFileSync(join(extractDir, 'bin', 'node'), getBundledNodeExecutable());
    chmodSync(getBundledNodeExecutable(), 0o755);
    const npmDir = join(extractDir, 'lib', 'node_modules', 'npm');
    cpSync(npmDir, join(RUNTIME_DIR, 'node_modules', 'npm'), { recursive: true });
    rmSync(extractDir, { recursive: true, force: true });

    // npm / npx next to node, so tools that shell out to them (MCP servers via
    // npx, hooks) work on Macs without their own Node — the bundled runtime is
    // appended to PATH as a fallback there.
    for (const [shim, cli] of [['npm', 'npm-cli.js'], ['npx', 'npx-cli.js']]) {
        const shimPath = join(RUNTIME_DIR, shim);
        writeFileSync(shimPath, [
            '#!/bin/sh',
            'dir="$(cd "$(dirname "$0")" && pwd)"',
            `exec "$dir/node" "$dir/node_modules/npm/bin/${cli}" "$@"`,
            '',
        ].join('\n'));
        chmodSync(shimPath, 0o755);
    }

    const bundledNpmPkg = JSON.parse(readFileSync(join(RUNTIME_DIR, 'node_modules', 'npm', 'package.json'), 'utf-8'));
    const runtimeInfo = {
        nodeExecutable: 'node',
        nodeVersion: version,
        npmVersion: bundledNpmPkg.version,
        platform: platform(),
        arch: arch(),
        sha256: expectedSha,
    };
    writeFileSync(join(RUNTIME_DIR, 'runtime-info.json'), JSON.stringify(runtimeInfo, null, 2));

    console.log(`   Node: ${runtimeInfo.nodeVersion} (${runtimeInfo.arch})`);
    console.log(`   npm: ${runtimeInfo.npmVersion}`);
    console.log('   ✅ Node.js runtime bundled successfully');
}

function bundleNodeRuntime() {
    console.log('\n📦 Bundling Node.js runtime...');

    const nodeExecutable = process.execPath;
    const nodeDir = dirname(nodeExecutable);
    const npmDir = join(nodeDir, 'node_modules', 'npm');

    if (!existsSync(nodeExecutable)) {
        throw new Error(`Node executable not found: ${nodeExecutable}`);
    }
    if (!existsSync(npmDir)) {
        throw new Error(`Bundled npm directory not found: ${npmDir}`);
    }

    cleanDir(RUNTIME_DIR);

    copyFileSync(nodeExecutable, getBundledNodeExecutable());
    cpSync(npmDir, join(RUNTIME_DIR, 'node_modules', 'npm'), { recursive: true });

    const wrapperFiles = ['npm', 'npm.cmd', 'npm.ps1', 'npx', 'npx.cmd', 'npx.ps1'];
    for (const fileName of wrapperFiles) {
        const sourcePath = join(nodeDir, fileName);
        if (existsSync(sourcePath)) {
            copyFileSync(sourcePath, join(RUNTIME_DIR, fileName));
        }
    }

    const npmPkg = JSON.parse(readFileSync(join(npmDir, 'package.json'), 'utf-8'));
    const runtimeInfo = {
        nodeExecutable: basename(nodeExecutable),
        nodeVersion: process.version,
        npmVersion: npmPkg.version,
        platform: platform(),
        arch: arch(),
    };
    writeFileSync(join(RUNTIME_DIR, 'runtime-info.json'), JSON.stringify(runtimeInfo, null, 2));

    console.log(`   Node: ${runtimeInfo.nodeVersion}`);
    console.log(`   npm: ${runtimeInfo.npmVersion}`);
    console.log('   ✅ Node.js runtime bundled successfully');
}

function runBundledNpm(args, cwd, extraEnv = {}) {
    const command = [getBundledNpmCli(), ...args];
    // A cross-arch runtime can't be assumed runnable here (no Rosetta on the
    // build machine), so drive the bundled npm with the host's Node and tell
    // it which CPU's optional native packages to fetch.
    if (IS_CROSS_ARCH) {
        command.push(`--cpu=${arch()}`, `--os=${platform()}`);
    }
    const nodeExec = IS_CROSS_ARCH ? process.execPath : getBundledNodeExecutable();
    console.log(`   Running: node ${command.join(' ')}`);
    execFileSync(nodeExec, command, {
        cwd,
        stdio: 'inherit',
        timeout: 600000,
        env: {
            ...getBundledRuntimeEnv(),
            ...extraEnv,
        },
    });
}

function bundleMinGit() {
    if (platform() !== 'win32') {
        return;
    }

    console.log('\n📦 Bundling MinGit...');
    cleanDir(MINGIT_DIR);

    const assetPattern = arch() === 'arm64'
        ? '^MinGit-[0-9.]+-arm64\\.zip$'
        : '^MinGit-[0-9.]+-64-bit\\.zip$';
    const zipPath = join(TOOLS_DIR, 'mingit.zip');

    const script = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$headers = @{ 'User-Agent' = '4RouterAi-Bundler' }
$release = Invoke-RestMethod -Headers $headers -Uri 'https://api.github.com/repos/git-for-windows/git/releases/latest'
$asset = $release.assets | Where-Object { $_.name -match '${assetPattern}' } | Select-Object -First 1
if (-not $asset) { throw 'MinGit asset not found for current architecture' }
try {
    Invoke-WebRequest -Headers $headers -Uri $asset.browser_download_url -OutFile '${zipPath.replace(/'/g, "''")}'
} catch {
    $mirrorUrl = "https://sourceforge.net/projects/git-for-windows.mirror/files/$($release.tag_name)/$($asset.name)/download"
    Invoke-WebRequest -Headers $headers -Uri $mirrorUrl -OutFile '${zipPath.replace(/'/g, "''")}'
}
Expand-Archive -Path '${zipPath.replace(/'/g, "''")}' -DestinationPath '${MINGIT_DIR.replace(/'/g, "''")}' -Force
Remove-Item '${zipPath.replace(/'/g, "''")}' -Force
Set-Content -Path '${join(MINGIT_DIR, 'release.json').replace(/'/g, "''")}' -Value ($release | ConvertTo-Json -Depth 4)
`;

    execFileSync('powershell.exe', [
        '-NoProfile',
        '-ExecutionPolicy', 'Bypass',
        '-Command', script,
    ], {
        stdio: 'inherit',
        timeout: 300000,
    });

    ensureMinGitBashShim();
    console.log('   ✅ MinGit bundled successfully');
}

function ensureMinGitBashShim() {
    const bashPath = join(MINGIT_DIR, 'bin', 'bash.exe');
    if (existsSync(bashPath)) {
        return;
    }

    const shCandidates = [
        join(MINGIT_DIR, 'bin', 'sh.exe'),
        join(MINGIT_DIR, 'usr', 'bin', 'sh.exe'),
        join(MINGIT_DIR, 'usr', 'bin', 'bash.exe'),
    ];

    const source = shCandidates.find(candidate => existsSync(candidate));
    if (!source) {
        throw new Error('MinGit bundled successfully, but no bash/sh executable was found');
    }

    mkdirSync(join(MINGIT_DIR, 'bin'), { recursive: true });
    copyFileSync(source, bashPath);
}

function bundleTool(tool) {
    const packageSpec = tool.version ? `${tool.package}@${tool.version}` : tool.package;
    console.log(`\n📦 Bundling ${tool.name} (${packageSpec})...`);

    cleanDir(tool.dir);

    // Create a minimal package.json so npm install works
    writeFileSync(
        join(tool.dir, 'package.json'),
        JSON.stringify({ name: `4RouterAi-${tool.name}`, version: '1.0.0', private: true }, null, 2)
    );

    // Install the package.
    // macOS: skip install scripts. Claude Code's postinstall hard-links its
    // ~350 MB native binary to bin/claude.exe, and electron-builder copies the
    // two links as two files, doubling the app. The app launches
    // cli-wrapper.cjs, which finds the platform binary on its own. Skipping
    // them also keeps a cross-arch bundle from running the host's postinstall.
    const installArgs = platform() === 'darwin' ? ['--ignore-scripts'] : [];
    console.log(`   Installing with bundled npm: ${packageSpec}`);
    try {
        runBundledNpm(['install', packageSpec, ...installArgs], tool.dir);

        // Both Claude Code (≥2.1.113) and Codex distribute platform-specific
        // native binaries via optional dependencies. Mirrors may lag,
        // so fall back to the official registry if the platform package
        // is missing after install.
        const hasPlatformPkg = tool.name === 'claude-code'
            ? hasClaudeCodePlatformPackage(tool.dir)
            : tool.name === 'codex'
                ? hasCodexPlatformPackage(tool.dir)
                : true;

        if (!hasPlatformPkg) {
            console.log(`   ⚠️  Platform package missing, retrying with official npm registry...`);
            runBundledNpm(
                ['install', packageSpec, '--registry', 'https://registry.npmjs.org/', ...installArgs],
                tool.dir
            );
        }

        console.log(`   ✅ ${tool.name} bundled successfully`);
    } catch (err) {
        console.error(`   ❌ Failed to bundle ${tool.name}:`, err.message);
        console.error(`   You can manually install it later:`);
        console.error(`   cd ${tool.dir} && npm install ${packageSpec}`);
    }
}

const CLAUDE_CODE_PLATFORM_PKG = {
    win32: { x64: 'claude-code-win32-x64', arm64: 'claude-code-win32-arm64' },
    darwin: { x64: 'claude-code-darwin-x64', arm64: 'claude-code-darwin-arm64' },
    linux: { x64: 'claude-code-linux-x64', arm64: 'claude-code-linux-arm64' },
};

function hasClaudeCodePlatformPackage(toolDir) {
    const pkgName = CLAUDE_CODE_PLATFORM_PKG[platform()]?.[arch()];
    if (!pkgName) return true;
    return existsSync(join(toolDir, 'node_modules', '@anthropic-ai', pkgName));
}

const CODEX_PLATFORM_PKG = {
    win32: { x64: 'codex-win32-x64', arm64: 'codex-win32-arm64' },
    darwin: { x64: 'codex-darwin-x64', arm64: 'codex-darwin-arm64' },
    linux: { x64: 'codex-linux-x64', arm64: 'codex-linux-arm64' },
};

function hasCodexPlatformPackage(toolDir) {
    const pkgName = CODEX_PLATFORM_PKG[platform()]?.[arch()];
    if (!pkgName) return true;
    return existsSync(join(toolDir, 'node_modules', '@openai', pkgName));
}

async function main() {
    console.log('='.repeat(50));
    console.log(`4RouterAi — Bundling CLI Tools (${platform()}-${arch()})`);
    console.log('='.repeat(50));

    ensureDir(TOOLS_DIR);
    if (platform() === 'darwin') {
        await bundleNodeRuntimeMac();
    } else {
        bundleNodeRuntime();
    }
    bundleMinGit();

    for (const tool of TOOLS) {
        bundleTool(tool);
    }

    console.log('\n' + '='.repeat(50));
    console.log('Done! Bundled tools are in: resources/bundled-tools/');
    console.log('='.repeat(50));
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
