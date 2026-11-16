import { execFile } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * OS trust-store integration for the local CA (the `mkcert -install` step).
 *
 * Windows: the *current-user* Root store rather than the machine store — no
 * administrator rights are needed, and crypt32 itself pops a consent dialog
 * showing the CA's thumbprint before anything is installed, so the user, not
 * this app, makes the trust decision. Chrome and Edge read that store
 * directly; Firefox keeps its own store and needs
 * `security.enterprise_roots.enabled` (or a manual import) to follow it.
 *
 * macOS: a user-domain trust setting on the login keychain via `security
 * add-trusted-cert`. macOS shows its own authorization prompt (password or
 * Touch ID) before trust settings change, mirroring the Windows consent
 * dialog. Safari and Chrome both honour it.
 *
 * On other platforms the answer is "unsupported" and the UI falls back to
 * exporting the CA for manual installation.
 */

export function trustSupported(): boolean {
    return process.platform === 'win32' || process.platform === 'darwin';
}

function runSecurity(args: string[], timeoutMs: number): Promise<{ ok: boolean; output: string }> {
    return new Promise((resolve) => {
        execFile('/usr/bin/security', args, { timeout: timeoutMs }, (err, stdout, stderr) => {
            resolve({ ok: !err, output: `${stdout || ''}\n${stderr || ''}` });
        });
    });
}

function loginKeychainPath(): string {
    return path.join(os.homedir(), 'Library', 'Keychains', 'login.keychain-db');
}

/** Write the PEM to a private temp file for the duration of `fn`. */
async function withTempCert<T>(certPem: string, fn: (file: string) => Promise<T>): Promise<T> {
    const file = path.join(os.tmpdir(), `4routerai-ca-${process.pid}-${Date.now()}.crt`);
    fs.writeFileSync(file, certPem, 'utf8');
    try {
        return await fn(file);
    } finally {
        try { fs.unlinkSync(file); } catch { /* already gone */ }
    }
}

/** certutil addresses certificates by their SHA-1 thumbprint, without colons. */
function sha1Thumbprint(certPem: string): string {
    return new crypto.X509Certificate(certPem).fingerprint.replace(/:/g, '');
}

function runCertutil(args: string[], timeoutMs: number): Promise<{ ok: boolean; output: string }> {
    return new Promise((resolve) => {
        execFile('certutil', args, { windowsHide: true, timeout: timeoutMs }, (err, stdout, stderr) => {
            resolve({ ok: !err, output: `${stdout || ''}\n${stderr || ''}` });
        });
    });
}

/**
 * Whether the CA sits in the current user's Root store. `null` when the
 * platform has no supported check (treat as unknown, offer export instead).
 */
export async function isCaTrusted(certPem: string): Promise<boolean | null> {
    if (!trustSupported()) return null;
    if (process.platform === 'darwin') {
        try {
            // Evaluates the CA as its own chain against the user's and the
            // system's trust settings; exit 0 only when it is a trusted root.
            // -L keeps it offline.
            return await withTempCert(certPem, async (file) =>
                (await runSecurity(['verify-cert', '-c', file, '-p', 'basic', '-L', '-q'], 10_000)).ok);
        } catch {
            return null;
        }
    }
    try {
        const { ok } = await runCertutil(['-store', '-user', 'Root', sha1Thumbprint(certPem)], 10_000);
        return ok;
    } catch {
        return null;
    }
}

/**
 * Ask Windows to add the CA to the current user's trusted roots. Blocks on the
 * OS consent dialog, so the timeout is generous. Resolving `{ ok: false }`
 * with a message covers both "user clicked No" and genuine failures.
 */
export async function installCaTrust(certPem: string): Promise<{ ok: boolean; message?: string }> {
    if (!trustSupported()) {
        return { ok: false, message: '当前系统暂不支持一键信任，请导出根证书后手动安装' };
    }
    if (process.platform === 'darwin') {
        return installCaTrustMac(certPem);
    }
    const file = path.join(os.tmpdir(), `4routerai-ca-${process.pid}-${Date.now()}.crt`);
    try {
        fs.writeFileSync(file, certPem, 'utf8');
        const res = await runCertutil(['-addstore', '-user', 'Root', file], 180_000);
        if (res.ok) return { ok: true };
        // 0x800704c7 / ERROR_CANCELLED is the user dismissing the consent dialog.
        const cancelled = /0x800704c7|cancell?ed|已取消/i.test(res.output);
        return {
            ok: false,
            message: cancelled
                ? '已取消：未在系统对话框中确认安装'
                : `certutil 执行失败：${res.output.trim().slice(0, 200)}`,
        };
    } catch (err: any) {
        return { ok: false, message: String(err?.message || err) };
    } finally {
        try { fs.unlinkSync(file); } catch { /* already gone */ }
    }
}

async function installCaTrustMac(certPem: string): Promise<{ ok: boolean; message?: string }> {
    try {
        return await withTempCert(certPem, async (file) => {
            // User trust domain (no -d): no admin rights, but macOS still asks
            // the user to authenticate before the trust setting is written.
            const res = await runSecurity([
                'add-trusted-cert', '-r', 'trustRoot', '-k', loginKeychainPath(), file,
            ], 180_000);
            if (res.ok) return { ok: true };
            const cancelled = /cancell?ed|-128\b|已取消/i.test(res.output);
            return {
                ok: false,
                message: cancelled
                    ? '已取消：未在系统对话框中完成授权'
                    : `security 执行失败：${res.output.trim().slice(0, 200)}`,
            };
        });
    } catch (err: any) {
        return { ok: false, message: String(err?.message || err) };
    }
}
