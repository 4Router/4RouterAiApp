import { safeStorage } from 'electron';
import Store from 'electron-store';
import type { DeviceRecord } from './web-auth';

interface ConfigSchema {
    theme: 'dark' | 'light' | 'fruit';
    defaultCwd: string;
    workdirs: string[];
    proxy: string;
    encryptedKeys: Record<string, string>;
    baseUrls: Record<string, string>;
    models: Record<string, string>;
    codexReasoningEffort: string;
    codexVerbosity: string;
    ccEffortLevel: string;
    fontSize: number;
    fontFamily: string;
    ccBypassPermissions: boolean;
    codexBypassPermissions: boolean;
    firstLaunch: boolean;
    // Remote web access (off by default).
    webEnabled: boolean;
    webPort: number;
    webToken: string;
    /** Extra hostnames the bridge may be reached under (frp/tunnel domains). */
    webAllowedHosts: string[];
    /** Require the host user to approve each new device. */
    webRequireApproval: boolean;
    /** Serve TLS directly using a self-signed certificate. */
    webHttps: boolean;
    /** CIDRs whose traffic is already encrypted at the network layer (WireGuard). */
    webTrustedNetworks: string[];
    /** Secret URL path segment; requests outside it get a bare 404. */
    webPathPrefix: string;
    /** Paired devices; tokens are stored hashed. */
    webDevices: DeviceRecord[];
}

/**
 * Keys the generic `config:get` / `config:set` channels must never touch.
 * Both channels are reachable from a remote browser, so anything here needs a
 * dedicated accessor that the handler table can gate separately.
 */
const PROTECTED_KEYS = new Set(['encryptedKeys', 'webToken', 'webDevices', 'webPathPrefix']);

const defaults: ConfigSchema = {
    theme: 'light',
    defaultCwd: '',
    workdirs: [],
    proxy: '',
    encryptedKeys: {},
    baseUrls: {},
    models: { anthropic: 'opus', openai: 'gpt-5.3-codex' },
    codexReasoningEffort: 'xhigh',
    codexVerbosity: 'high',
    ccEffortLevel: 'high',
    fontSize: 14,
    fontFamily: 'Cascadia Code, Consolas, monospace',
    ccBypassPermissions: false,
    codexBypassPermissions: false,
    firstLaunch: true,
    webEnabled: false,
    // High enough to stay clear of the OEM background services that squat on
    // low-4000 ports (ASUS AURA's LightingService takes 4178, for one), and
    // below Windows' dynamic range so it isn't handed out to something else.
    webPort: 18470,
    webToken: '',
    webAllowedHosts: [],
    webRequireApproval: true,
    // On by default: the bridge listens on every interface, and everything
    // except the host's own loopback access requires an encrypted transport.
    webHttps: true,
    webTrustedNetworks: [],
    webPathPrefix: '',
    webDevices: [],
};

export class ConfigStore {
    private store: Store<ConfigSchema>;

    constructor() {
        this.store = new Store<ConfigSchema>({
            name: '4routerai-config',
            defaults,
        });
        this.migrateRemoteAccess();
    }

    /**
     * Bring pre-existing remote-access config in line with the current model.
     *
     * The bridge used to bind loopback-only unless `webAllowLan` was set, and
     * shipped with TLS off; it now always listens on every interface and
     * refuses unencrypted non-loopback connections. A stored config carrying
     * the old keys would therefore end up listening yet unreachable, so TLS is
     * switched on once during the upgrade and the dead keys are dropped.
     * Defaults alone can't do this — they only apply to keys never written.
     */
    private migrateRemoteAccess(): void {
        // These keys are gone from ConfigSchema, so they need the cast to be
        // looked up at all.
        const legacyKeys = ['webAllowLan', 'webSecurityLevel', 'webRequireSecure'] as unknown as Array<keyof ConfigSchema>;
        const stale = legacyKeys.filter(key => this.store.has(key));
        if (!stale.length) return;

        this.store.set('webHttps', true);
        for (const key of stale) this.store.delete(key);
        console.log(`[ConfigStore] migrated remote-access settings (dropped ${stale.join(', ')})`);
    }

    get(key: string): any {
        if (PROTECTED_KEYS.has(key)) return undefined;
        return this.store.get(key as keyof ConfigSchema);
    }

    set(key: string, value: any): void {
        if (PROTECTED_KEYS.has(key)) return;
        this.store.set(key as keyof ConfigSchema, value);
    }

    // ===== Remote web access secrets =====
    // Deliberately outside get()/set() so the remote-reachable config channels
    // can't read the bridge's own credentials.

    getWebToken(): string {
        return this.store.get('webToken', '') as string;
    }

    setWebToken(token: string): void {
        this.store.set('webToken', token);
    }

    getWebDevices(): DeviceRecord[] {
        return (this.store.get('webDevices', []) as DeviceRecord[]) || [];
    }

    setWebDevices(devices: DeviceRecord[]): void {
        this.store.set('webDevices', devices);
    }

    getWebPathPrefix(): string {
        return this.store.get('webPathPrefix', '') as string;
    }

    setWebPathPrefix(prefix: string): void {
        this.store.set('webPathPrefix', prefix);
    }

    /**
     * Store API key using Electron's safeStorage for encryption.
     * Falls back to plain storage if encryption is unavailable.
     */
    setApiKey(provider: string, key: string): void {
        if (safeStorage.isEncryptionAvailable()) {
            const encrypted = safeStorage.encryptString(key);
            const encryptedKeys = this.store.get('encryptedKeys', {});
            encryptedKeys[provider] = encrypted.toString('base64');
            this.store.set('encryptedKeys', encryptedKeys);
        } else {
            const encryptedKeys = this.store.get('encryptedKeys', {});
            encryptedKeys[provider] = `plain:${key}`;
            this.store.set('encryptedKeys', encryptedKeys);
        }
    }

    /**
     * Retrieve and decrypt API key for a provider.
     */
    getApiKey(provider: string): string | null {
        const encryptedKeys = this.store.get('encryptedKeys', {});
        const stored = encryptedKeys[provider];
        if (!stored) return null;

        if (stored.startsWith('plain:')) {
            return stored.slice(6);
        }

        try {
            const buffer = Buffer.from(stored, 'base64');
            return safeStorage.decryptString(buffer);
        } catch {
            return null;
        }
    }

    hasApiKey(provider: string): boolean {
        const encryptedKeys = this.store.get('encryptedKeys', {});
        return !!encryptedKeys[provider];
    }

    /**
     * Store base URL for a provider's API endpoint.
     */
    setBaseUrl(provider: string, url: string): void {
        const baseUrls = this.store.get('baseUrls', {});
        baseUrls[provider] = url;
        this.store.set('baseUrls', baseUrls);
    }

    /**
     * Get base URL for a provider.
     */
    getBaseUrl(provider: string): string | null {
        const baseUrls = this.store.get('baseUrls', {});
        return baseUrls[provider] || null;
    }

    setModel(provider: string, model: string): void {
        const models = this.store.get('models', {});
        models[provider] = model;
        this.store.set('models', models);
    }

    getModel(provider: string): string | null {
        const models = this.store.get('models', { anthropic: 'opus', openai: 'gpt-5.3-codex' });
        return models[provider] || null;
    }

    isFirstLaunch(): boolean {
        return this.store.get('firstLaunch', true);
    }

    markLaunched(): void {
        this.store.set('firstLaunch', false);
    }

    /**
     * Wipe the entire config store (API keys, base URLs, models, theme, fonts, …).
     * Defaults supplied to the constructor are re-applied on subsequent reads,
     * so `firstLaunch` flips back to true and the welcome screen is shown again.
     */
    resetAll(): void {
        this.store.clear();
    }
}
