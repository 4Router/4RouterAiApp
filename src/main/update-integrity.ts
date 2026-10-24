import * as crypto from 'crypto';
import * as fs from 'fs';

/**
 * Integrity checks for the app self-updater.
 *
 * The installer is fetched through third-party GitHub proxies for speed, so
 * whatever comes back has to be checked against what GitHub itself says the
 * asset is. The release API (api.github.com, fetched directly) reports a
 * `digest` of the form "sha256:<hex>" for every asset uploaded since mid-2025;
 * that value is the trust anchor, never anything a mirror returns.
 *
 * Kept free of electron imports so it can be tested under plain node.
 */

export interface ReleaseAsset {
    /** Canonical github.com download URL. */
    url: string;
    name: string;
    /** Size in bytes as reported by the release API, 0 if unknown. */
    size: number;
    /** Lower-case hex SHA-256, or null when the release predates digests. */
    sha256: string | null;
}

/** "sha256:ABC…" → "abc…"; anything else (missing, other algorithm, malformed) → null. */
export function parseSha256Digest(digest: unknown): string | null {
    if (typeof digest !== 'string') return null;
    const match = /^sha256:([0-9a-f]{64})$/i.exec(digest.trim());
    return match ? match[1].toLowerCase() : null;
}

/** Pick the Windows installer from a GitHub release `assets` array. */
export function pickInstallerAsset(assets: unknown): ReleaseAsset | null {
    if (!Array.isArray(assets)) return null;
    const asset = assets.find((a: any) =>
        a && typeof a.name === 'string'
        && (a.name.endsWith('.exe') || a.name.endsWith('.zip'))
        && typeof a.browser_download_url === 'string'
    );
    if (!asset) return null;
    return {
        url: asset.browser_download_url,
        name: asset.name,
        size: typeof asset.size === 'number' ? asset.size : 0,
        sha256: parseSha256Digest(asset.digest),
    };
}

/**
 * Pick the release that at least `minAgree` independent sources describe
 * identically (same tag, installer URL, size and digest).
 *
 * Used when api.github.com itself is unreachable and the release JSON can
 * only be had through third-party mirrors. A single mirror could hand out a
 * forged digest together with a matching forged installer; requiring several
 * to agree means one compromised operator is not enough. Releases without a
 * digest, or whose installer isn't under `urlPrefix`, never count.
 */
export function agreeOnRelease(releases: unknown[], minAgree: number, urlPrefix: string): any | null {
    const tally = new Map<string, { release: any; count: number }>();
    for (const release of releases as any[]) {
        const asset = pickInstallerAsset(release?.assets);
        if (!asset?.sha256 || !asset.url.startsWith(urlPrefix) || typeof release.tag_name !== 'string') continue;
        const key = [release.tag_name, asset.url, asset.size, asset.sha256].join('\n');
        const entry = tally.get(key);
        if (entry) entry.count++;
        else tally.set(key, { release, count: 1 });
    }
    let best: { release: any; count: number } | null = null;
    for (const entry of tally.values()) {
        if (entry.count >= minAgree && (!best || entry.count > best.count)) best = entry;
    }
    return best?.release ?? null;
}

/** Stream a file through SHA-256 and return the lower-case hex digest. */
export function sha256File(filePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        fs.createReadStream(filePath)
            .on('data', chunk => hash.update(chunk))
            .on('error', reject)
            .on('end', () => resolve(hash.digest('hex')));
    });
}

/**
 * Throw unless the downloaded file matches the asset's published size and
 * digest. An asset without a digest only passes the size check — callers must
 * not fetch such assets through an untrusted mirror in the first place.
 */
export async function verifyDownloadedAsset(filePath: string, asset: ReleaseAsset): Promise<void> {
    const actualSize = fs.statSync(filePath).size;
    if (asset.size > 0 && actualSize !== asset.size) {
        throw new Error(`安装包大小不符（应为 ${asset.size} 字节，实际 ${actualSize} 字节）`);
    }
    if (asset.sha256) {
        const actual = await sha256File(filePath);
        if (actual !== asset.sha256) {
            throw new Error(`安装包 SHA-256 校验失败（应为 ${asset.sha256}，实际 ${actual}）`);
        }
    }
}
