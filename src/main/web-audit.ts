import * as fs from 'fs';
import * as path from 'path';

/**
 * Append-only activity log for the remote bridge.
 *
 * Everything that grants, refuses or ends remote access lands here so the user
 * can answer "who reached my machine, and when" after the fact. Credentials
 * never do — no tokens, pairing codes or cookies, only which *kind* of check
 * passed or failed.
 *
 * Kept free of electron imports so it can be driven from tests; the owner
 * supplies the file path.
 */

export type AuditKind =
    | 'bridge-start'
    | 'bridge-stop'
    | 'port-fallback'
    | 'connect'
    | 'disconnect'
    | 'pair-ok'
    | 'pair-fail'
    | 'token-request'
    | 'approve'
    | 'deny'
    | 'revoke'
    | 'kick'
    | 'token-rotate'
    | 'prefix-rotate'
    | 'cert-regenerate'
    | 'cert-trust'
    | 'reject-insecure'
    | 'reject-origin'
    | 'reject-host'
    | 'reject-prefix'
    | 'reject-auth'
    | 'rate-limit'
    | 'lockdown'
    | 'lockdown-clear';

export interface AuditEvent {
    at: number;
    kind: AuditKind;
    ip?: string;
    device?: string;
    detail?: string;
}

/** Newest-first ring buffer size. Old entries fall off the end. */
const MAX_EVENTS = 1000;
/** Batch disk writes — a port scan can generate hundreds of rejects a second. */
const FLUSH_DELAY_MS = 800;

/** Which kinds count as "something you may want to look at". */
const NOTABLE = new Set<AuditKind>([
    'pair-fail', 'reject-insecure', 'reject-origin', 'reject-host',
    'reject-prefix', 'reject-auth', 'rate-limit', 'lockdown', 'port-fallback',
]);

export class WebAudit {
    private events: AuditEvent[] = [];
    private flushTimer: NodeJS.Timeout | null = null;
    private dirty = false;

    constructor(private filePath: string, private onChange?: (event: AuditEvent) => void) {
        this.load();
    }

    private load(): void {
        try {
            const raw = fs.readFileSync(this.filePath, 'utf8');
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) this.events = parsed.slice(0, MAX_EVENTS);
        } catch {
            this.events = [];
        }
    }

    record(kind: AuditKind, fields: { ip?: string; device?: string; detail?: string } = {}): AuditEvent {
        const event: AuditEvent = { at: Date.now(), kind, ...fields };
        this.events.unshift(event);
        if (this.events.length > MAX_EVENTS) this.events.length = MAX_EVENTS;
        this.dirty = true;
        this.scheduleFlush();
        this.onChange?.(event);
        return event;
    }

    list(limit = 200): AuditEvent[] {
        return this.events.slice(0, limit);
    }

    /** Count of attention-worthy entries since a timestamp, for the tab badge. */
    countNotableSince(since: number): number {
        let count = 0;
        for (const event of this.events) {
            if (event.at <= since) break; // newest-first, so we can stop early
            if (NOTABLE.has(event.kind)) count++;
        }
        return count;
    }

    clear(): void {
        this.events = [];
        this.dirty = true;
        this.flush();
    }

    private scheduleFlush(): void {
        if (this.flushTimer) return;
        this.flushTimer = setTimeout(() => {
            this.flushTimer = null;
            this.flush();
        }, FLUSH_DELAY_MS);
    }

    flush(): void {
        if (!this.dirty) return;
        this.dirty = false;
        try {
            fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
            fs.writeFileSync(this.filePath, JSON.stringify(this.events), 'utf8');
        } catch (err) {
            console.error('[WebAudit] failed to persist log:', err);
        }
    }
}
