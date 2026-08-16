import { contextBridge, ipcRenderer } from 'electron';

// Expose a safe API to the renderer process via contextBridge
contextBridge.exposeInMainWorld('routerAi', {
    // ===== Tool Management =====
    tools: {
        list: () => ipcRenderer.invoke('tools:list'),
        getStatus: (toolId: string) => ipcRenderer.invoke('tools:get-status', toolId),
        update: (toolId: string) => ipcRenderer.invoke('tools:update', toolId),
        getLaunchPreview: (toolId: string) => ipcRenderer.invoke('tools:get-launch-preview', toolId),
        checkUpdate: (toolId: string) => ipcRenderer.invoke('tools:check-update', toolId),
    },

    // ===== Terminal (PTY) =====
    pty: {
        create: (toolId: string, cwd?: string) => ipcRenderer.invoke('pty:create', toolId, cwd),
        write: (sessionId: string, data: string) => ipcRenderer.send('pty:write', sessionId, data),
        resize: (sessionId: string, cols: number, rows: number) =>
            ipcRenderer.send('pty:resize', sessionId, cols, rows),
        destroy: (sessionId: string) => ipcRenderer.invoke('pty:destroy', sessionId),
        // Shared-session sync.
        list: () => ipcRenderer.invoke('pty:list'),
        attach: (sessionId: string) => ipcRenderer.invoke('pty:attach', sessionId),
        onData: (callback: (sessionId: string, data: string, endOffset: number) => void) => {
            const listener = (_event: any, sessionId: string, data: string, endOffset: number) =>
                callback(sessionId, data, endOffset);
            ipcRenderer.on('pty:data', listener);
            return () => ipcRenderer.removeListener('pty:data', listener);
        },
        onExit: (callback: (sessionId: string, exitCode: number) => void) => {
            const listener = (_event: any, sessionId: string, exitCode: number) =>
                callback(sessionId, exitCode);
            ipcRenderer.on('pty:exit', listener);
            return () => ipcRenderer.removeListener('pty:exit', listener);
        },
        onCreated: (callback: (session: { sessionId: string; toolId: string; cwd: string }) => void) => {
            const listener = (_event: any, session: { sessionId: string; toolId: string; cwd: string }) =>
                callback(session);
            ipcRenderer.on('pty:created', listener);
            return () => ipcRenderer.removeListener('pty:created', listener);
        },
        onClosed: (callback: (sessionId: string) => void) => {
            const listener = (_event: any, sessionId: string) => callback(sessionId);
            ipcRenderer.on('pty:closed', listener);
            return () => ipcRenderer.removeListener('pty:closed', listener);
        },
    },

    // ===== Config =====
    config: {
        get: (key: string) => ipcRenderer.invoke('config:get', key),
        set: (key: string, value: any) => ipcRenderer.invoke('config:set', key, value),
        getApiKey: (provider: string) => ipcRenderer.invoke('config:get-api-key', provider),
        setApiKey: (provider: string, key: string) =>
            ipcRenderer.invoke('config:set-api-key', provider, key),
        hasApiKey: (provider: string) => ipcRenderer.invoke('config:has-api-key', provider),
        getBaseUrl: (provider: string) => ipcRenderer.invoke('config:get-base-url', provider),
        setBaseUrl: (provider: string, url: string) =>
            ipcRenderer.invoke('config:set-base-url', provider, url),
        getModel: (provider: string) => ipcRenderer.invoke('config:get-model', provider),
        setModel: (provider: string, model: string) =>
            ipcRenderer.invoke('config:set-model', provider, model),
    },

    // ===== Remote Web Access =====
    // These channels are rejected by the WebBridge, so they only ever run from
    // this desktop window (see HandlerRegistry.localOnly).
    web: {
        getStatus: () => ipcRenderer.invoke('web:get-status'),
        apply: (cfg: {
            enabled: boolean;
            port: number;
            allowedHosts: string[];
            requireApproval: boolean;
            https: boolean;
            trustedNetworks: string[];
        }) => ipcRenderer.invoke('web:apply', cfg),
        createPairingCode: () => ipcRenderer.invoke('web:create-pairing-code'),
        clearPairingCode: () => ipcRenderer.invoke('web:clear-pairing-code'),
        rotateToken: () => ipcRenderer.invoke('web:rotate-token'),
        rotatePathPrefix: () => ipcRenderer.invoke('web:rotate-path-prefix'),
        regenerateCert: () => ipcRenderer.invoke('web:regenerate-cert'),
        trustCert: () => ipcRenderer.invoke('web:trust-cert'),
        exportCa: () => ipcRenderer.invoke('web:export-ca'),
        listAudit: (limit?: number) => ipcRenderer.invoke('web:list-audit', limit),
        clearAudit: () => ipcRenderer.invoke('web:clear-audit'),
        clearLockdown: () => ipcRenderer.invoke('web:clear-lockdown'),
        listDevices: () => ipcRenderer.invoke('web:list-devices'),
        renameDevice: (id: string, name: string) => ipcRenderer.invoke('web:rename-device', id, name),
        revokeDevice: (id: string) => ipcRenderer.invoke('web:revoke-device', id),
        revokeAllDevices: () => ipcRenderer.invoke('web:revoke-all-devices'),
        listClients: () => ipcRenderer.invoke('web:list-clients'),
        disconnectClient: (id: string) => ipcRenderer.invoke('web:disconnect-client', id),
        disconnectAll: () => ipcRenderer.invoke('web:disconnect-all'),
        listRequests: () => ipcRenderer.invoke('web:list-requests'),
        resolveRequest: (id: string, approved: boolean) =>
            ipcRenderer.invoke('web:resolve-request', id, approved),
        onAccessRequest: (callback: (request: any) => void) => {
            const listener = (_event: any, request: any) => callback(request);
            ipcRenderer.on('web:access-request', listener);
            return () => ipcRenderer.removeListener('web:access-request', listener);
        },
        onClientsChanged: (callback: (clients: any[]) => void) => {
            const listener = (_event: any, clients: any[]) => callback(clients);
            ipcRenderer.on('web:clients-changed', listener);
            return () => ipcRenderer.removeListener('web:clients-changed', listener);
        },
        onAudit: (callback: (event: any) => void) => {
            const listener = (_event: any, entry: any) => callback(entry);
            ipcRenderer.on('web:audit', listener);
            return () => ipcRenderer.removeListener('web:audit', listener);
        },
        onLockdown: (callback: (state: any) => void) => {
            const listener = (_event: any, state: any) => callback(state);
            ipcRenderer.on('web:lockdown', listener);
            return () => ipcRenderer.removeListener('web:lockdown', listener);
        },
    },

    // ===== Window Controls =====
    window: {
        minimize: () => ipcRenderer.send('window:minimize'),
        maximize: () => ipcRenderer.send('window:maximize'),
        close: () => ipcRenderer.send('window:close'),
        setTitleBarOverlay: (colors: { color: string; symbolColor: string }) =>
            ipcRenderer.invoke('window:set-titlebar-overlay', colors),
    },

    // ===== App =====
    app: {
        getVersion: () => ipcRenderer.invoke('app:get-version'),
        isEncryptionAvailable: () => ipcRenderer.invoke('app:is-encryption-available'),
        checkAppUpdate: () => ipcRenderer.invoke('app:check-app-update'),
        downloadUpdate: (url: string) => ipcRenderer.invoke('app:download-update', url),
        onUpdateProgress: (callback: (percent: number, message?: string) => void) => {
            const listener = (_event: any, percent: number, message?: string) => callback(percent, message);
            ipcRenderer.on('app-update:progress', listener);
            return () => ipcRenderer.removeListener('app-update:progress', listener);
        },
        checkRemoteConfig: () => ipcRenderer.invoke('app:check-remote-config'),
        applyRemoteConfig: (config: Record<string, any>) => ipcRenderer.invoke('app:apply-remote-config', config),
        resetAll: () => ipcRenderer.invoke('app:reset-all'),
    },

    // ===== Аuth =====
    auth: {
        checkLoginStatus: () => ipcRenderer.invoke('auth:check-login-status'),
        isLoggedIn: () => ipcRenderer.invoke('auth:is-logged-in'),
        logout: () => ipcRenderer.invoke('auth:logout'),
    },

    // ===== Key Provisioning =====
    provision: {
        createKeys: () => ipcRenderer.invoke('provision:create-keys'),
    },

    // ===== Dialog =====
    dialog: {
        selectDirectory: () => ipcRenderer.invoke('dialog:select-directory'),
    },

    // ===== File System =====
    fs: {
        readDir: (dirPath: string) => ipcRenderer.invoke('fs:read-dir', dirPath),
    },

    // ===== Clipboard =====
    clipboard: {
        // Returns a temp file path for an image in the clipboard, or null.
        readImage: () => ipcRenderer.invoke('clipboard:read-image') as Promise<string | null>,
    },
});
