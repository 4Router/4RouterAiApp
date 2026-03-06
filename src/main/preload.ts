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
        onData: (callback: (sessionId: string, data: string) => void) => {
            const listener = (_event: any, sessionId: string, data: string) => callback(sessionId, data);
            ipcRenderer.on('pty:data', listener);
            return () => ipcRenderer.removeListener('pty:data', listener);
        },
        onExit: (callback: (sessionId: string, exitCode: number) => void) => {
            const listener = (_event: any, sessionId: string, exitCode: number) =>
                callback(sessionId, exitCode);
            ipcRenderer.on('pty:exit', listener);
            return () => ipcRenderer.removeListener('pty:exit', listener);
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
    },

    // ===== Dialog =====
    dialog: {
        selectDirectory: () => ipcRenderer.invoke('dialog:select-directory'),
    },

    // ===== File System =====
    fs: {
        readDir: (dirPath: string) => ipcRenderer.invoke('fs:read-dir', dirPath),
    },
});
