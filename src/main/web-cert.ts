import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as x509 from '@peculiar/x509';

/**
 * TLS material for the remote bridge, issued by a per-install local CA
 * (the mkcert model).
 *
 * A bare self-signed leaf can never be trusted by a browser — no matter what
 * its SAN says, the address bar stays "not secure" because nothing in the OS
 * trust store vouches for it. So instead this store mints a long-lived root
 * CA once per install, and signs short-lived leaf certificates with it:
 *
 *   - trust the CA once (system store; see web-trust.ts) and every leaf it
 *     signs is green-locked, on this machine and on any LAN device that
 *     imports the CA;
 *   - the leaf can be re-issued freely (address set changed, expiry) without
 *     re-triggering browser warnings, because trust anchors at the CA;
 *   - the CA private key never leaves this machine and signs nothing but
 *     these leaf certificates.
 *
 * The leaf covers every address the machine currently answers on; roaming to
 * a new network changes those, so `ensure()` re-issues whenever the address
 * set no longer fits.
 */

// @peculiar/x509 performs all signing through WebCrypto.
x509.cryptoProvider.set(crypto.webcrypto as any);

const subtle = crypto.webcrypto.subtle;

/** tsconfig has no DOM lib, so name the WebCrypto pair type via node:crypto. */
type KeyPair = crypto.webcrypto.CryptoKeyPair;

const EC_ALG = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' };

export interface CaBundle {
    /** PKCS#8 PEM. Never served; only signs leaf certificates. */
    key: string;
    cert: string;
    /** SHA-256 fingerprint, colon-separated. */
    fingerprint: string;
    createdAt: number;
    expiresAt: number;
}

export interface CertBundle {
    key: string;
    /** Leaf certificate PEM. */
    cert: string;
    /** Leaf + CA PEM, in server order — what the HTTPS listener should serve. */
    chain: string;
    /** SHA-256 fingerprint of the leaf — the value browsers display. */
    fingerprint: string;
    /** Names and IPs baked into the SAN extension. */
    hosts: string[];
    createdAt: number;
    expiresAt: number;
    ca: CaBundle;
}

/** Persisted shape. Bump STORE_VERSION to invalidate older material. */
interface StoredBundle {
    version: number;
    ca: CaBundle;
    leaf: {
        key: string;
        cert: string;
        fingerprint: string;
        hosts: string[];
        createdAt: number;
        expiresAt: number;
    } | null;
}

/** v1 files held a bare self-signed leaf; they are discarded on load. */
const STORE_VERSION = 2;

/** Same ceiling mkcert uses — leaves longer than 825 days are rejected by Apple. */
const LEAF_VALIDITY_DAYS = 825;
/** Re-issue this long before expiry so a running bridge never serves a dead cert. */
const LEAF_RENEW_BEFORE_MS = 14 * 24 * 3_600_000;

const CA_VALIDITY_DAYS = 3650;
/** A dying CA means every device must re-trust; renew well ahead of that. */
const CA_RENEW_BEFORE_MS = 30 * 24 * 3_600_000;

export class WebCertStore {
    private cached: StoredBundle | null = null;

    constructor(private filePath: string) { }

    /**
     * A certificate valid for `hosts`, generating a new leaf when the stored
     * one is missing, expiring, or doesn't cover every requested address. The
     * CA is reused across leaf re-issues so installed trust survives.
     */
    async ensure(hosts: string[]): Promise<CertBundle> {
        const wanted = normalizeHosts(hosts);
        const stored = this.read();
        const ca = stored && caUsable(stored.ca) ? stored.ca : await issueCa();
        if (stored && stored.ca === ca && stored.leaf && this.covers(stored.leaf, wanted)) {
            return assemble(stored.ca, stored.leaf);
        }
        const leaf = await issueLeaf(ca, wanted);
        this.persist({ version: STORE_VERSION, ca, leaf });
        return assemble(ca, leaf);
    }

    /** The stored bundle, or null when nothing usable is on disk. */
    load(): CertBundle | null {
        const stored = this.read();
        if (!stored?.leaf) return null;
        return assemble(stored.ca, stored.leaf);
    }

    private read(): StoredBundle | null {
        if (this.cached) return this.cached;
        try {
            const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
            if (
                parsed?.version === STORE_VERSION
                && parsed?.ca?.key && parsed?.ca?.cert
            ) {
                this.cached = parsed as StoredBundle;
                return this.cached;
            }
        } catch {
            // No usable material on disk — the caller will issue fresh.
        }
        return null;
    }

    private covers(leaf: NonNullable<StoredBundle['leaf']>, wanted: string[]): boolean {
        if (leaf.expiresAt - LEAF_RENEW_BEFORE_MS <= Date.now()) return false;
        const have = new Set(leaf.hosts);
        return wanted.every(host => have.has(host));
    }

    private persist(bundle: StoredBundle): void {
        this.cached = bundle;
        try {
            fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
            // Private keys live here, so keep it owner-only where the OS honours it.
            fs.writeFileSync(this.filePath, JSON.stringify(bundle), { encoding: 'utf8', mode: 0o600 });
        } catch (err) {
            console.error('[WebCert] failed to persist certificate:', err);
        }
    }

    /**
     * Drop the leaf but keep the CA, so the next ensure() re-issues without
     * invalidating trust that devices have already installed.
     */
    clearLeaf(): void {
        const stored = this.read();
        if (!stored) return;
        this.persist({ ...stored, leaf: null });
    }

    /** Drop everything — CA included — so the next ensure() mints a fresh identity. */
    clear(): void {
        this.cached = null;
        try { fs.unlinkSync(this.filePath); } catch { /* nothing to remove */ }
    }
}

function caUsable(ca: CaBundle): boolean {
    return ca.expiresAt - CA_RENEW_BEFORE_MS > Date.now();
}

function assemble(ca: CaBundle, leaf: NonNullable<StoredBundle['leaf']>): CertBundle {
    return {
        key: leaf.key,
        cert: leaf.cert,
        chain: `${leaf.cert.trim()}\n${ca.cert.trim()}\n`,
        fingerprint: leaf.fingerprint,
        hosts: leaf.hosts,
        createdAt: leaf.createdAt,
        expiresAt: leaf.expiresAt,
        ca,
    };
}

async function issueCa(): Promise<CaBundle> {
    const notBefore = new Date();
    const notAfter = new Date(notBefore.getTime() + CA_VALIDITY_DAYS * 24 * 3_600_000);

    const keys = (await subtle.generateKey(EC_ALG, true, ['sign', 'verify'])) as KeyPair;

    // Unique per install: two machines (or a re-issue) must never present the
    // same CA identity, and the suffix keeps entries tellable-apart in the OS
    // certificate manager.
    const hostname = os.hostname().replace(/[^A-Za-z0-9._-]/g, '').slice(0, 24) || 'host';
    const suffix = crypto.randomBytes(2).toString('hex').toUpperCase();
    const name = `CN=4RouterAi Local CA ${hostname}-${suffix}, O=4RouterAi`;

    const cert = await x509.X509CertificateGenerator.createSelfSigned({
        serialNumber: randomSerial(),
        name,
        notBefore,
        notAfter,
        signingAlgorithm: EC_ALG,
        keys: keys as any,
        extensions: [
            // pathLength 0: this CA can sign leaves, never intermediate CAs.
            new x509.BasicConstraintsExtension(true, 0, true),
            new x509.KeyUsagesExtension(x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign, true),
            await x509.SubjectKeyIdentifierExtension.create(keys.publicKey as any),
        ],
    });

    const certPem = cert.toString('pem');
    return {
        key: x509.PemConverter.encode(await subtle.exportKey('pkcs8', keys.privateKey), 'PRIVATE KEY'),
        cert: certPem,
        fingerprint: fingerprintOf(certPem),
        createdAt: notBefore.getTime(),
        expiresAt: notAfter.getTime(),
    };
}

async function issueLeaf(ca: CaBundle, hosts: string[]): Promise<NonNullable<StoredBundle['leaf']>> {
    const notBefore = new Date();
    const notAfter = new Date(notBefore.getTime() + LEAF_VALIDITY_DAYS * 24 * 3_600_000);

    const caCert = new x509.X509Certificate(ca.cert);
    const caKey = await subtle.importKey(
        'pkcs8',
        x509.PemConverter.decodeFirst(ca.key),
        { name: EC_ALG.name, namedCurve: EC_ALG.namedCurve },
        false,
        ['sign'],
    );
    const keys = (await subtle.generateKey(EC_ALG, true, ['sign', 'verify'])) as KeyPair;

    // Browsers ignore the legacy commonName entirely and match against SAN.
    const altNames: x509.JsonGeneralName[] = hosts.map(host => (
        isIpLiteral(host) ? { type: 'ip', value: host } : { type: 'dns', value: host }
    ));

    const cert = await x509.X509CertificateGenerator.create({
        serialNumber: randomSerial(),
        subject: `CN=${hosts[0] || 'localhost'}`,
        // The Name object, not its string form — string round-trips can change
        // the DER encoding and break issuer/subject chaining.
        issuer: caCert.subjectName,
        notBefore,
        notAfter,
        signingAlgorithm: EC_ALG,
        publicKey: keys.publicKey as any,
        signingKey: caKey as any,
        extensions: [
            new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true),
            new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.serverAuth]),
            new x509.SubjectAlternativeNameExtension(altNames),
            await x509.SubjectKeyIdentifierExtension.create(keys.publicKey as any),
            await x509.AuthorityKeyIdentifierExtension.create(caCert),
        ],
    });

    const certPem = cert.toString('pem');
    return {
        key: x509.PemConverter.encode(await subtle.exportKey('pkcs8', keys.privateKey), 'PRIVATE KEY'),
        cert: certPem,
        fingerprint: fingerprintOf(certPem),
        hosts,
        createdAt: notBefore.getTime(),
        expiresAt: notAfter.getTime(),
    };
}

/** Positive, unique, 16-byte serial as hex — required by RFC 5280. */
function randomSerial(): string {
    const bytes = crypto.randomBytes(16);
    bytes[0] &= 0x7f;
    bytes[0] |= 0x01;
    return bytes.toString('hex');
}

function isIpLiteral(host: string): boolean {
    return /^[0-9.]+$/.test(host) || host.includes(':');
}

/** Dedupe, lowercase, and make sure loopback is always present. */
function normalizeHosts(hosts: string[]): string[] {
    const out = new Set(['localhost', '127.0.0.1', '::1']);
    for (const raw of hosts) {
        const host = String(raw || '').trim().toLowerCase();
        if (host && host !== '0.0.0.0') out.add(host);
    }
    return [...out];
}

function fingerprintOf(certPem: string): string {
    try {
        return new crypto.X509Certificate(certPem).fingerprint256;
    } catch {
        return '';
    }
}
