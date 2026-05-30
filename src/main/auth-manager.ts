import { session } from 'electron';
import * as https from 'https';
import { ConfigStore } from './config-store';

const ROUTER_BASE_URL = 'https://4router.net';
const AUTH_PARTITION = 'auth-4router';
const ACCESS_TOKEN_KEY = '4router-access-token';

export interface LoginStatus {
    loggedIn: boolean;
    accessToken?: string;
    error?: string;
}

/**
 * Module 1: AuthManager
 * Handles 4Router login/registration via an in-page <webview> (renderer side).
 * After cookies appear in the shared `auth-4router` session, the renderer
 * polls checkLoginStatus(); we call GET /api/user/token with those cookies
 * to mint and persist an accessToken.
 *
 * Detection strategy: GET /api/user/token with the session cookies.
 * If the API returns an accessToken, login is confirmed — no need to
 * guess based on URL navigation (which is unreliable with SPAs and can
 * fire false-positives when the user simply browses to the home page).
 */
export class AuthManager {
    private configStore: ConfigStore;

    constructor(configStore: ConfigStore) {
        this.configStore = configStore;
    }

    /**
     * Called by the renderer on a polling interval while the embedded
     * <webview> is on screen. Returns { loggedIn: true, accessToken } once
     * the session has valid cookies and /api/user/token succeeds.
     */
    async checkLoginStatus(): Promise<LoginStatus> {
        try {
            const authSession = session.fromPartition(AUTH_PARTITION);
            const cookies = await authSession.cookies.get({ url: ROUTER_BASE_URL });
            if (!cookies.length) return { loggedIn: false };

            const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');
            if (!cookieHeader) return { loggedIn: false };

            const accessToken = await this.fetchAccessToken(cookieHeader);
            this.configStore.setApiKey(ACCESS_TOKEN_KEY, accessToken);
            return { loggedIn: true, accessToken };
        } catch (err: any) {
            // Not logged in yet (most common case) — quietly report false.
            return { loggedIn: false, error: err?.message };
        }
    }

    /**
     * Get the stored accessToken.
     */
    getAccessToken(): string | null {
        return this.configStore.getApiKey(ACCESS_TOKEN_KEY);
    }

    /**
     * Check if user is logged in (has a valid accessToken stored).
     */
    isLoggedIn(): boolean {
        return this.configStore.hasApiKey(ACCESS_TOKEN_KEY);
    }

    /**
     * Logout: clear the stored accessToken.
     */
    logout(): void {
        this.configStore.setApiKey(ACCESS_TOKEN_KEY, '');
    }

    /**
     * Full session reset: wipe the auth-4router Electron session (cookies,
     * localStorage, cache) so the next "一键配置" requires a fresh manual
     * login. The accessToken inside the config store is cleared separately
     * by the caller (typically via ConfigStore.resetAll()).
     */
    async clearSession(): Promise<void> {
        try {
            const authSession = session.fromPartition(AUTH_PARTITION);
            await authSession.clearStorageData();
        } catch (err) {
            console.error('[AuthManager] clearSession failed:', err);
        }
    }

    /**
     * Use session cookies to call GET /api/user/token.
     * This endpoint generates/returns the accessToken.
     * Throws on failure (not logged in, network error, etc.).
     */
    private fetchAccessToken(cookieHeader: string): Promise<string> {
        return new Promise((resolve, reject) => {
            const url = new URL(`${ROUTER_BASE_URL}/api/user/token`);
            const options: https.RequestOptions = {
                hostname: url.hostname,
                port: url.port || 443,
                path: url.pathname,
                method: 'GET',
                headers: {
                    'Cookie': cookieHeader,
                    'Accept': 'application/json',
                },
            };

            const req = https.request(options, (res) => {
                let body = '';
                res.on('data', (chunk) => { body += chunk; });
                res.on('end', () => {
                    try {
                        const data = JSON.parse(body);
                        if (data.success && data.data) {
                            resolve(data.data); // accessToken string
                        } else {
                            reject(new Error(data.message || '获取 AccessToken 失败'));
                        }
                    } catch {
                        reject(new Error('解析响应失败'));
                    }
                });
            });

            req.on('error', (err) => {
                reject(new Error(`网络请求失败: ${err.message}`));
            });

            req.setTimeout(10000, () => {
                req.destroy();
                reject(new Error('请求超时'));
            });

            req.end();
        });
    }
}
