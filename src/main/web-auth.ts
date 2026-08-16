import * as crypto from 'crypto';
import { ConfigStore } from './config-store';

/**
 * Credential logic for the remote web bridge.
 *
 * Three credential kinds, all funnelling into one thing — a *device token*
 * stored in an HttpOnly cookie, which is what /ws actually checks:
 *
 *   master token   long random string, always present. Used by CLI clients and
 *                  by the legacy `?token=` link. Presenting it only earns an
 *                  access *request*; the host user still has to approve.
 *   pairing code   8 digits, 5-minute TTL, single use. The host user generates
 *                  it on the desktop, so redeeming one is already proof of host
 *                  consent and needs no second approval.
 *   device token   issued after either path succeeds, persisted server-side as
 *                  a sha256 hash, revocable per device.
 *
 * The raw device token leaves the process exactly once (in the Set-Cookie that
 * issues it); everything stored on disk is a hash.
 */

export interface DeviceRecord {
    id: string;
    name: string;
    /** sha256(deviceToken), base64. The raw token is never persisted. */
    tokenHash: string;
    ip: string;
    userAgent: string;
    createdAt: number;
    lastSeenAt: number;
}

export interface PairingCode {
    code: string;
    expiresAt: number;
}

/** An access attempt holding for the host user's approve/deny decision. */
export interface AccessRequest {
    id: string;
    ip: string;
    userAgent: string;
    name: string;
    createdAt: number;
    expiresAt: number;
    status: 'pending' | 'approved' | 'denied' | 'expired';
    /** Set once approved — handed to the client as its device cookie. */
    deviceToken?: string;
}

const MASTER_TOKEN_BYTES = 32;
const DEVICE_TOKEN_BYTES = 32;
const PAIRING_CODE_TTL_MS = 5 * 60_000;
/** How long an access request waits for the host user before auto-denying. */
const APPROVAL_TTL_MS = 120_000;
/** Devices unseen for this long are dropped, so stale phones don't linger. */
const DEVICE_IDLE_TTL_MS = 30 * 24 * 3_600_000;

/** Failed attempts below this are free; past it lockout doubles each time. */
const FAILURE_GRACE = 4;
const BASE_LOCKOUT_MS = 2_000;
const MAX_LOCKOUT_MS = 15 * 60_000;
/** A quiet period this long resets an IP's failure counter. */
const FAILURE_DECAY_MS = 30 * 60_000;

/**
 * Per-IP backoff does nothing against a botnet rotating source addresses, so a
 * separate global counter watches total failures across every IP. Tripping it
 * puts the bridge in lockdown: paired devices keep working, but no new
 * credential is accepted until the window elapses or the host clears it.
 */
const GLOBAL_FAILURE_THRESHOLD = 20;
const GLOBAL_FAILURE_WINDOW_MS = 10 * 60_000;
const LOCKDOWN_MS = 30 * 60_000;

/** Length of the secret URL path segment, in random bytes before encoding. */
const PATH_PREFIX_BYTES = 9;

interface FailureState {
    count: number;
    lockedUntil: number;
    lastAt: number;
}

export interface LockdownState {
    active: boolean;
    until: number;
    /** Failures counted inside the current window. */
    failures: number;
    threshold: number;
}

/**
 * Compare two secrets without leaking their contents or lengths through
 * timing. Hashing first gives timingSafeEqual the equal-length buffers it
 * requires (it throws otherwise), so mismatched lengths take the same path as
 * mismatched bytes.
 */
function constantTimeEqual(a: string, b: string): boolean {
    const ha = crypto.createHash('sha256').update(a, 'utf8').digest();
    const hb = crypto.createHash('sha256').update(b, 'utf8').digest();
    return crypto.timingSafeEqual(ha, hb);
}

function sha256(value: string): string {
    return crypto.createHash('sha256').update(value, 'utf8').digest('base64');
}

/** A human-recognisable label so the approval prompt isn't a raw UA string. */
function deviceNameFromUserAgent(ua: string): string {
    if (!ua) return '未知设备';
    const os =
        /Android/i.test(ua) ? 'Android' :
            /iPhone|iPad|iPod/i.test(ua) ? 'iOS' :
                /Mac OS X|Macintosh/i.test(ua) ? 'macOS' :
                    /Windows/i.test(ua) ? 'Windows' :
                        /Linux/i.test(ua) ? 'Linux' : '';
    const browser =
        /Edg\//i.test(ua) ? 'Edge' :
            /OPR\//i.test(ua) ? 'Opera' :
                /Firefox\//i.test(ua) ? 'Firefox' :
                    /Chrome\//i.test(ua) ? 'Chrome' :
                        /Safari\//i.test(ua) ? 'Safari' : '';
    if (os && browser) return `${browser} · ${os}`;
    return browser || os || '未知设备';
}

export class WebAuth {
    private pairing: PairingCode | null = null;
    private requests = new Map<string, AccessRequest>();
    private failures = new Map<string, FailureState>();
    /** Timestamps of recent failures from any source, for the global counter. */
    private globalFailures: number[] = [];
    private lockdownUntil = 0;
    /** Fired when lockdown engages, so the caller can log and notify. */
    onLockdown?: (state: LockdownState) => void;

    constructor(private configStore: ConfigStore) { }

    // ===== secret URL prefix =====

    /** The secret path segment, generating one on first use. */
    ensurePathPrefix(): string {
        const existing = this.configStore.getWebPathPrefix();
        if (existing && existing.length >= 8) return existing;
        return this.rotatePathPrefix();
    }

    rotatePathPrefix(): string {
        const prefix = crypto.randomBytes(PATH_PREFIX_BYTES).toString('base64url');
        this.configStore.setWebPathPrefix(prefix);
        return prefix;
    }

    // ===== master token =====

    /** The master token, minting and persisting one when none exists. */
    ensureToken(): string {
        const existing = this.configStore.getWebToken();
        if (existing && existing.length >= 32) return existing;
        return this.rotateToken();
    }

    rotateToken(): string {
        const token = crypto.randomBytes(MASTER_TOKEN_BYTES).toString('base64url');
        this.configStore.setWebToken(token);
        return token;
    }

    verifyToken(candidate: string): boolean {
        if (!candidate) return false;
        const token = this.configStore.getWebToken();
        if (!token) return false;
        return constantTimeEqual(candidate, token);
    }

    // ===== pairing code =====

    createPairingCode(): PairingCode {
        // randomInt is rejection-sampled, so digits stay uniform.
        const code = String(crypto.randomInt(0, 100_000_000)).padStart(8, '0');
        this.pairing = { code, expiresAt: Date.now() + PAIRING_CODE_TTL_MS };
        return this.pairing;
    }

    /** The live pairing code, or null once it has expired or been used. */
    getPairingCode(): PairingCode | null {
        if (this.pairing && this.pairing.expiresAt <= Date.now()) this.pairing = null;
        return this.pairing;
    }

    clearPairingCode(): void {
        this.pairing = null;
    }

    /** Single-use redemption: a correct code is consumed whether or not it wins. */
    consumePairingCode(candidate: string): boolean {
        const active = this.getPairingCode();
        if (!active) return false;
        if (!constantTimeEqual(candidate, active.code)) return false;
        this.pairing = null;
        return true;
    }

    // ===== devices =====

    /** Approved devices, with idle-expired entries pruned first. */
    listDevices(): DeviceRecord[] {
        const cutoff = Date.now() - DEVICE_IDLE_TTL_MS;
        const all = this.configStore.getWebDevices();
        const live = all.filter(d => d.lastSeenAt >= cutoff);
        if (live.length !== all.length) this.configStore.setWebDevices(live);
        return live;
    }

    /** Mint a device token for a freshly approved client. */
    issueDevice(ip: string, userAgent: string): { token: string; record: DeviceRecord } {
        const token = crypto.randomBytes(DEVICE_TOKEN_BYTES).toString('base64url');
        const now = Date.now();
        const record: DeviceRecord = {
            id: crypto.randomUUID(),
            name: deviceNameFromUserAgent(userAgent),
            tokenHash: sha256(token),
            ip,
            userAgent: userAgent.slice(0, 300),
            createdAt: now,
            lastSeenAt: now,
        };
        this.configStore.setWebDevices([...this.listDevices(), record]);
        return { token, record };
    }

    /**
     * Resolve a device cookie to its record. Compares hashes rather than raw
     * tokens so a config-store leak can't be replayed.
     */
    verifyDevice(token: string): DeviceRecord | null {
        if (!token) return null;
        const hash = sha256(token);
        const target = Buffer.from(hash, 'base64');
        for (const device of this.listDevices()) {
            const candidate = Buffer.from(device.tokenHash, 'base64');
            if (candidate.length !== target.length) continue;
            if (crypto.timingSafeEqual(candidate, target)) return device;
        }
        return null;
    }

    /** Refresh lastSeenAt so an in-use device never idles out. */
    touchDevice(id: string, ip?: string): void {
        const devices = this.listDevices();
        const device = devices.find(d => d.id === id);
        if (!device) return;
        device.lastSeenAt = Date.now();
        if (ip) device.ip = ip;
        this.configStore.setWebDevices(devices);
    }

    renameDevice(id: string, name: string): boolean {
        const devices = this.listDevices();
        const device = devices.find(d => d.id === id);
        if (!device) return false;
        device.name = name.slice(0, 60) || device.name;
        this.configStore.setWebDevices(devices);
        return true;
    }

    revokeDevice(id: string): boolean {
        const devices = this.listDevices();
        const remaining = devices.filter(d => d.id !== id);
        if (remaining.length === devices.length) return false;
        this.configStore.setWebDevices(remaining);
        return true;
    }

    revokeAllDevices(): void {
        this.configStore.setWebDevices([]);
    }

    // ===== approval queue =====

    /** Park an authenticated-but-unapproved client for the host to judge. */
    createRequest(ip: string, userAgent: string): AccessRequest {
        this.pruneRequests();
        const now = Date.now();
        const request: AccessRequest = {
            id: crypto.randomUUID(),
            ip,
            userAgent: userAgent.slice(0, 300),
            name: deviceNameFromUserAgent(userAgent),
            createdAt: now,
            expiresAt: now + APPROVAL_TTL_MS,
            status: 'pending',
        };
        this.requests.set(request.id, request);
        return request;
    }

    getRequest(id: string): AccessRequest | null {
        this.pruneRequests();
        return this.requests.get(id) || null;
    }

    listPendingRequests(): AccessRequest[] {
        this.pruneRequests();
        return [...this.requests.values()].filter(r => r.status === 'pending');
    }

    /**
     * Apply the host user's decision. Approving issues the device token here so
     * the polling client can pick it up on its next check.
     */
    resolveRequest(id: string, approved: boolean): AccessRequest | null {
        const request = this.getRequest(id);
        if (!request || request.status !== 'pending') return null;
        if (approved) {
            const { token } = this.issueDevice(request.ip, request.userAgent);
            request.deviceToken = token;
            request.status = 'approved';
        } else {
            request.status = 'denied';
        }
        return request;
    }

    /** Hand the token to the client exactly once, then forget it. */
    claimRequestToken(id: string): string | null {
        const request = this.requests.get(id);
        if (!request || request.status !== 'approved' || !request.deviceToken) return null;
        const token = request.deviceToken;
        delete request.deviceToken;
        return token;
    }

    private pruneRequests(): void {
        const now = Date.now();
        for (const [id, request] of this.requests) {
            if (request.status === 'pending' && request.expiresAt <= now) {
                request.status = 'expired';
            }
            // Keep resolved requests briefly so the client's poll can observe
            // the outcome, then drop them.
            if (request.status !== 'pending' && now - request.expiresAt > APPROVAL_TTL_MS) {
                this.requests.delete(id);
            }
        }
    }

    // ===== per-IP rate limiting =====

    /** Milliseconds this IP must wait before its next attempt is considered. */
    lockoutRemaining(ip: string): number {
        const state = this.failures.get(ip);
        if (!state) return 0;
        if (Date.now() - state.lastAt > FAILURE_DECAY_MS) {
            this.failures.delete(ip);
            return 0;
        }
        return Math.max(0, state.lockedUntil - Date.now());
    }

    /** Record a bad credential and return the resulting lockout in ms. */
    recordFailure(ip: string): number {
        const now = Date.now();
        const previous = this.failures.get(ip);
        const decayed = previous && now - previous.lastAt > FAILURE_DECAY_MS;
        const count = (decayed || !previous ? 0 : previous.count) + 1;

        const over = count - FAILURE_GRACE;
        const lockout = over <= 0
            ? 0
            : Math.min(BASE_LOCKOUT_MS * 2 ** (over - 1), MAX_LOCKOUT_MS);

        this.failures.set(ip, { count, lockedUntil: now + lockout, lastAt: now });
        this.recordGlobalFailure(now);
        return lockout;
    }

    recordSuccess(ip: string): void {
        this.failures.delete(ip);
    }

    // ===== global lockdown =====

    private recordGlobalFailure(now: number): void {
        const cutoff = now - GLOBAL_FAILURE_WINDOW_MS;
        this.globalFailures = this.globalFailures.filter(at => at > cutoff);
        this.globalFailures.push(now);
        if (this.globalFailures.length >= GLOBAL_FAILURE_THRESHOLD && !this.isLockedDown()) {
            this.lockdownUntil = now + LOCKDOWN_MS;
            this.onLockdown?.(this.lockdownState());
        }
    }

    isLockedDown(): boolean {
        if (this.lockdownUntil && this.lockdownUntil <= Date.now()) {
            this.lockdownUntil = 0;
            this.globalFailures = [];
        }
        return this.lockdownUntil > 0;
    }

    lockdownState(): LockdownState {
        const active = this.isLockedDown();
        const cutoff = Date.now() - GLOBAL_FAILURE_WINDOW_MS;
        return {
            active,
            until: active ? this.lockdownUntil : 0,
            failures: this.globalFailures.filter(at => at > cutoff).length,
            threshold: GLOBAL_FAILURE_THRESHOLD,
        };
    }

    /** Host user override — clears lockdown and every per-IP backoff. */
    clearLockdown(): void {
        this.lockdownUntil = 0;
        this.globalFailures = [];
        this.failures.clear();
    }

    /** Snapshot for the settings panel: which IPs are currently locked out. */
    listLockouts(): { ip: string; failures: number; remainingMs: number }[] {
        const out: { ip: string; failures: number; remainingMs: number }[] = [];
        for (const [ip, state] of this.failures) {
            const remainingMs = Math.max(0, state.lockedUntil - Date.now());
            if (remainingMs > 0) out.push({ ip, failures: state.count, remainingMs });
        }
        return out;
    }
}
