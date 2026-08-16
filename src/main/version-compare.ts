/**
 * Semver precedence, shared by the app updater and the CLI-tool updater.
 *
 * Both used to decide "is there an update?" with `latest !== current`, which
 * treats any difference as newer. That misfires two ways: 1.1.10 looks older
 * than 1.1.9 under string comparison, and a registry mirror lagging behind the
 * official one would advertise an older version as an upgrade — offering the
 * user a silent downgrade.
 */

interface ParsedVersion {
    /** major, minor, patch — non-numeric junk degrades to 0 rather than NaN. */
    parts: [number, number, number];
    prerelease: string;
}

function parseVersion(raw: string): ParsedVersion {
    // Build metadata (+abc) has no bearing on precedence, per semver.
    const clean = String(raw || '').trim().replace(/^v/i, '').split('+')[0];
    const dash = clean.indexOf('-');
    const core = dash === -1 ? clean : clean.slice(0, dash);
    const [major, minor, patch] = core.split('.').map(s => parseInt(s, 10));
    return {
        parts: [major || 0, minor || 0, patch || 0],
        prerelease: dash === -1 ? '' : clean.slice(dash + 1),
    };
}

/** Precedence for dot-separated prerelease identifiers. */
function comparePrerelease(a: string, b: string): number {
    const left = a.split('.');
    const right = b.split('.');
    for (let i = 0; i < Math.max(left.length, right.length); i++) {
        const x = left[i];
        const y = right[i];
        // A shorter identifier set ranks lower: 1.0.0-beta < 1.0.0-beta.1
        if (x === undefined) return -1;
        if (y === undefined) return 1;
        const nx = /^\d+$/.test(x) ? Number(x) : null;
        const ny = /^\d+$/.test(y) ? Number(y) : null;
        if (nx !== null && ny !== null) {
            if (nx !== ny) return nx > ny ? 1 : -1;
        } else if (nx !== null) {
            return -1; // numeric identifiers rank lower than alphanumeric ones
        } else if (ny !== null) {
            return 1;
        } else if (x !== y) {
            return x > y ? 1 : -1;
        }
    }
    return 0;
}

/** -1 if a < b, 0 if equal, 1 if a > b. */
export function compareVersions(a: string, b: string): number {
    const va = parseVersion(a);
    const vb = parseVersion(b);
    for (let i = 0; i < 3; i++) {
        if (va.parts[i] !== vb.parts[i]) return va.parts[i] > vb.parts[i] ? 1 : -1;
    }
    if (va.prerelease === vb.prerelease) return 0;
    // A prerelease ranks below the release it precedes: 1.2.0-beta.1 < 1.2.0
    if (!va.prerelease) return 1;
    if (!vb.prerelease) return -1;
    return comparePrerelease(va.prerelease, vb.prerelease);
}

/**
 * Whether `latest` is a genuine upgrade over `current`. Unknown or empty
 * values mean "we couldn't find out", which is never an upgrade.
 */
export function isNewerVersion(latest: string, current: string): boolean {
    if (!latest || latest === 'unknown') return false;
    return compareVersions(latest, current) > 0;
}
