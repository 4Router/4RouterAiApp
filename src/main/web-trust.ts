import { execFile } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * OS trust-store integration for the local CA (the `mkcert -install` step).
 *
 * Windows only, and deliberately the *current-user* Root store rather than
 * the machine store: no administrator rights are needed, and crypt32 itself
 * pops a consent dialog showing the CA's thumbprint before anything is
 * installed — the user, not this app, makes the trust decision. Chrome and
 * Edge read that store directly; Firefox keeps its own store and needs
 * `security.enterprise_roots.enabled` (or a manual import) to follow it.
 *
 * On other platforms the answer is "unsupported" and the UI falls back to
 * exporting the CA for manual installation.
 */

export function trustSupported(): boolean {
    return process.platform === 'win32';
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
