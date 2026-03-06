/**
 * bundle-tools.mjs
 * 
 * Pre-installs Claude Code and Codex CLI into the resources/bundled-tools
 * directory so they are available when the app is packaged.
 * 
 * Usage: node scripts/bundle-tools.mjs
 */

import { execFileSync } from 'child_process';
import { cpSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { basename, dirname, join } from 'path';
import { platform, arch } from 'os';

const TOOLS_DIR = join(import.meta.dirname, '..', 'resources', 'bundled-tools');
const RUNTIME_DIR = join(TOOLS_DIR, 'node-runtime');
const MINGIT_DIR = join(TOOLS_DIR, 'mingit');

const TOOLS = [
    {
        name: 'claude-code',
        package: '@anthropic-ai/claude-code',
        dir: join(TOOLS_DIR, 'claude-code'),
    },
    {
        name: 'codex',
        package: '@openai/codex',
        version: '0.100.0',
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
    console.log(`   Running: node ${command.join(' ')}`);
    execFileSync(getBundledNodeExecutable(), command, {
        cwd,
        stdio: 'inherit',
        timeout: 120000,
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

    // Install the package
    console.log(`   Installing with bundled npm: ${packageSpec}`);
    try {
        runBundledNpm(['install', packageSpec], tool.dir);

        // @openai/codex uses dist-tag versions for platform binaries
        // (e.g. npm:@openai/codex@x.y.z-win32-x64). Mirrors may lag,
        // so fall back to the official registry if the platform package
        // is missing after install.
        if (tool.name === 'codex' && !hasCodexPlatformPackage(tool.dir)) {
            console.log(`   ⚠️  Platform package missing, retrying with official npm registry...`);
            runBundledNpm(
                ['install', packageSpec, '--registry', 'https://registry.npmjs.org/'],
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

function main() {
    console.log('='.repeat(50));
    console.log('4RouterAi — Bundling CLI Tools');
    console.log('='.repeat(50));

    ensureDir(TOOLS_DIR);
    bundleNodeRuntime();
    bundleMinGit();

    for (const tool of TOOLS) {
        bundleTool(tool);
    }

    console.log('\n' + '='.repeat(50));
    console.log('Done! Bundled tools are in: resources/bundled-tools/');
    console.log('='.repeat(50));
}

main();
