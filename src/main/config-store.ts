import { safeStorage } from 'electron';
import Store from 'electron-store';

interface ConfigSchema {
    theme: 'dark' | 'light' | 'fruit';
    defaultCwd: string;
    proxy: string;
    encryptedKeys: Record<string, string>;
    baseUrls: Record<string, string>;
    models: Record<string, string>;
    codexReasoningEffort: string;
    codexVerbosity: string;
    fontSize: number;
    fontFamily: string;
    firstLaunch: boolean;
}

const defaults: ConfigSchema = {
    theme: 'dark',
    defaultCwd: '',
    proxy: '',
    encryptedKeys: {},
    baseUrls: {},
    models: { anthropic: 'opus', openai: 'gpt-5.3-codex' },
    codexReasoningEffort: 'xhigh',
    codexVerbosity: 'high',
    fontSize: 14,
    fontFamily: 'Cascadia Code, Consolas, monospace',
    firstLaunch: true,
};

export class ConfigStore {
    private store: Store<ConfigSchema>;

    constructor() {
        this.store = new Store<ConfigSchema>({
            name: '4routerai-config',
            defaults,
        });
    }

    get(key: string): any {
        if (key === 'encryptedKeys') return undefined; // Don't expose raw encrypted data
        return this.store.get(key as keyof ConfigSchema);
    }

    set(key: string, value: any): void {
        if (key === 'encryptedKeys') return; // Protect encrypted keys
        this.store.set(key as keyof ConfigSchema, value);
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
}
