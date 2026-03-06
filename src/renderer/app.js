import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';

// ============================================================
// 4RouterAi — Main Renderer Application
// ============================================================

/** @type {typeof window.routerAi} */
const api = /** @type {any} */ (window).routerAi;

// ===== State =====
const state = {
    tabs: /** @type {TabState[]} */ ([]),
    activeTabId: /** @type {string|null} */ (null),
    currentCwd: '',
    tabCounter: 0,
};

/**
 * @typedef {Object} TabState
 * @property {string} id
 * @property {string} toolId
 * @property {string} toolName
 * @property {string} toolIcon
 * @property {string} sessionId
 * @property {Terminal} terminal
 * @property {FitAddon} fitAddon
 * @property {HTMLElement} wrapper
 * @property {HTMLElement} tabElement
 * @property {string} cwd
 */

// ===== DOM References =====
const $ = (/** @type {string} */ sel) => document.querySelector(sel);
const welcomeScreen = /** @type {HTMLElement} */ ($('#welcome-screen'));
const appScreen = /** @type {HTMLElement} */ ($('#app-screen'));
const tabBar = /** @type {HTMLElement} */ ($('#tab-bar'));
const tabBarEmpty = /** @type {HTMLElement} */ ($('#tab-bar-empty'));
const terminalContainer = /** @type {HTMLElement} */ ($('#terminal-container'));
const emptyState = /** @type {HTMLElement} */ ($('#empty-state'));
const settingsModal = /** @type {HTMLElement} */ ($('#settings-modal'));
const cwdDisplay = /** @type {HTMLElement} */ ($('#cwd-display'));
const fileExplorer = /** @type {HTMLElement} */ ($('#file-explorer'));
const fileTree = /** @type {HTMLElement} */ ($('#file-tree'));
const explorerPath = /** @type {HTMLElement} */ ($('#explorer-path'));

function refitTerminal(/** @type {TabState} */ tab, /** @type {{ focus?: boolean }} */ options = {}) {
    const runFit = () => {
        if (!state.tabs.includes(tab) || tab.wrapper.classList.contains('hidden')) return;
        tab.fitAddon.fit();
        api.pty.resize(tab.sessionId, tab.terminal.cols, tab.terminal.rows);
        if (options.focus) tab.terminal.focus();
    };

    requestAnimationFrame(() => {
        runFit();
        requestAnimationFrame(runFit);
        setTimeout(runFit, 120);
    });

    if (document.fonts?.ready) {
        document.fonts.ready.then(() => {
            runFit();
        }).catch(() => { /* ignore */ });
    }
}

// ===== Initialization =====
async function init() {
    setupWindowControls();
    setupToggleVisibility();
    await checkFirstLaunch();
    await applyTheme();
    setupWelcomeScreen();
    setupSidebar();
    setupSettings();
    setupPtyListeners();
    setupResize();
    setupFileExplorer();
}

async function applyTheme(/** @type {string} */ themeOverride) {
    const theme = themeOverride || (await api.config.get('theme')) || 'fruit';
    document.documentElement.setAttribute('data-theme', theme);

    // Update native Windows titlebar button colors
    try {
        if (theme === 'light') {
            api.window.setTitleBarOverlay({ color: '#d0d7de', symbolColor: '#24292f' });
        } else if (theme === 'fruit') {
            api.window.setTitleBarOverlay({ color: '#f8dfbd', symbolColor: '#6d4624' });
        } else {
            api.window.setTitleBarOverlay({ color: '#0d1117', symbolColor: '#c9d1d9' });
        }
    } catch { /* ignore if not supported */ }

    const terminalTheme = getTerminalTheme(theme);
    for (const tab of state.tabs) {
        tab.terminal.options.theme = terminalTheme;
    }
}

function getTerminalTheme(/** @type {string} */ theme) {
    const darkTheme = {
        background: '#0d1117',
        foreground: '#e6edf3',
        cursor: '#58a6ff',
        cursorAccent: '#0d1117',
        selectionBackground: 'rgba(88,166,255,0.3)',
        black: '#484f58', red: '#ff7b72', green: '#3fb950', yellow: '#d29922',
        blue: '#58a6ff', magenta: '#bc8cff', cyan: '#39d2c0', white: '#e6edf3',
        brightBlack: '#6e7681', brightRed: '#ffa198', brightGreen: '#56d364', brightYellow: '#e3b341',
        brightBlue: '#79c0ff', brightMagenta: '#d2a8ff', brightCyan: '#56d4dd', brightWhite: '#f0f6fc',
    };
    const lightTheme = {
        background: '#f6f8fa',
        foreground: '#1f2328',
        cursor: '#0969da',
        cursorAccent: '#f6f8fa',
        selectionBackground: 'rgba(9,105,218,0.2)',
        black: '#24292f', red: '#cf222e', green: '#1a7f37', yellow: '#9a6700',
        blue: '#0969da', magenta: '#8250df', cyan: '#0a8a7a', white: '#6e7781',
        brightBlack: '#57606a', brightRed: '#a40e26', brightGreen: '#116329', brightYellow: '#7d5e00',
        brightBlue: '#0550ae', brightMagenta: '#6639ba', brightCyan: '#076c5e', brightWhite: '#8c959f',
    };
    const fruitTheme = {
        background: '#fff8ef',
        foreground: '#5f3d1f',
        cursor: '#f0902d',
        cursorAccent: '#fff8ef',
        selectionBackground: 'rgba(240,144,45,0.18)',
        black: '#6d4624', red: '#d96238', green: '#6a9d49', yellow: '#c98b2d',
        blue: '#d48b38', magenta: '#d97b58', cyan: '#83b96b', white: '#d6b28c',
        brightBlack: '#9b714b', brightRed: '#ee8963', brightGreen: '#89c36d', brightYellow: '#e6ad4c',
        brightBlue: '#efaa58', brightMagenta: '#efa07f', brightCyan: '#a4d58d', brightWhite: '#fff3e3',
    };

    if (theme === 'light') return lightTheme;
    if (theme === 'fruit') return fruitTheme;
    return darkTheme;
}

// ===== Window Controls =====
function setupWindowControls() {
    $('#btn-minimize')?.addEventListener('click', () => api.window.minimize());
    $('#btn-maximize')?.addEventListener('click', () => api.window.maximize());
    $('#btn-close')?.addEventListener('click', () => api.window.close());
}

// ===== Toggle Password Visibility =====
function setupToggleVisibility() {
    document.addEventListener('click', (e) => {
        const btn = /** @type {HTMLElement} */ (e.target)?.closest('.btn-toggle-visibility');
        if (!btn) return;
        const targetId = btn.getAttribute('data-target');
        if (!targetId) return;
        const input = /** @type {HTMLInputElement} */ (document.getElementById(targetId));
        if (input) {
            input.type = input.type === 'password' ? 'text' : 'password';
        }
    });
}

// ===== First Launch Check =====
async function checkFirstLaunch() {
    const firstLaunch = await api.config.get('firstLaunch');
    const hasAnthropic = await api.config.hasApiKey('anthropic');
    const hasOpenai = await api.config.hasApiKey('openai');

    if (!firstLaunch && (hasAnthropic || hasOpenai)) {
        showAppScreen();
    } else {
        showWelcomeScreen();
    }

    // Load saved CWD
    const savedCwd = await api.config.get('defaultCwd');
    if (savedCwd) {
        state.currentCwd = savedCwd;
        cwdDisplay.textContent = shortenPath(savedCwd);
    }
}

function showWelcomeScreen() {
    welcomeScreen.classList.remove('hidden');
    appScreen.classList.add('hidden');
}

function showAppScreen() {
    welcomeScreen.classList.add('hidden');
    appScreen.classList.remove('hidden');
}

function shortenPath(/** @type {string} */ p) {
    if (p.length <= 30) return p;
    const parts = p.replace(/\\/g, '/').split('/');
    if (parts.length <= 3) return p;
    return parts[0] + '/.../' + parts.slice(-2).join('/');
}

// ===== Welcome Screen =====
function setupWelcomeScreen() {
    const btnSave = /** @type {HTMLElement} */ ($('#btn-save-keys'));
    const btnSkip = /** @type {HTMLElement} */ ($('#btn-skip-setup'));

    btnSave?.addEventListener('click', async () => {
        const anthropicKey = /** @type {HTMLInputElement} */ ($('#key-anthropic'))?.value?.trim();
        const openaiKey = /** @type {HTMLInputElement} */ ($('#key-openai'))?.value?.trim();
        const anthropicBaseUrl = /** @type {HTMLInputElement} */ ($('#baseurl-anthropic'))?.value?.trim();
        const openaiBaseUrl = /** @type {HTMLInputElement} */ ($('#baseurl-openai'))?.value?.trim();

        if (anthropicKey) {
            await api.config.setApiKey('anthropic', anthropicKey);
            updateSetupStatus('anthropic', true);
        }
        if (openaiKey) {
            await api.config.setApiKey('openai', openaiKey);
            updateSetupStatus('openai', true);
        }
        if (anthropicBaseUrl) {
            await api.config.setBaseUrl('anthropic', anthropicBaseUrl);
        }
        if (openaiBaseUrl) {
            await api.config.setBaseUrl('openai', openaiBaseUrl);
        }

        await api.config.set('firstLaunch', false);
        showAppScreen();
        await refreshToolStatus();
    });

    btnSkip?.addEventListener('click', async () => {
        await api.config.set('firstLaunch', false);
        showAppScreen();
        await refreshToolStatus();
    });
}

function updateSetupStatus(/** @type {string} */ provider, /** @type {boolean} */ configured) {
    const el = document.getElementById(`status-${provider}`);
    if (el) {
        el.textContent = configured ? '已配置 ✓' : '未配置';
        el.classList.toggle('configured', configured);
    }
}

// ===== Sidebar =====
function setupSidebar() {
    $('#btn-launch-claude')?.addEventListener('click', () => launchTool('claude-code'));
    $('#btn-launch-codex')?.addEventListener('click', () => launchTool('codex'));
    $('#btn-launch-terminal')?.addEventListener('click', () => launchTerminal());

    // Update tool buttons
    document.getElementById('badge-claude')?.addEventListener('click', (e) => {
        e.stopPropagation();
        updateTool('claude-code', 'badge-claude');
    });
    document.getElementById('badge-codex')?.addEventListener('click', (e) => {
        e.stopPropagation();
        updateTool('codex', 'badge-codex');
    });

    $('#btn-select-cwd')?.addEventListener('click', async () => {
        const dir = await api.dialog.selectDirectory();
        if (dir) {
            state.currentCwd = dir;
            cwdDisplay.textContent = shortenPath(dir);
            await api.config.set('defaultCwd', dir);
            loadFileTree(dir);
        }
    });

    $('#btn-settings')?.addEventListener('click', () => openSettings());

    setupAppUpdateButton();

    refreshToolStatus();
}

// ===== App Update (GitHub Releases) =====
function setupAppUpdateButton() {
    const btn = /** @type {HTMLElement} */ ($('#btn-check-update'));
    const statusText = /** @type {HTMLElement} */ ($('#update-status-text'));
    if (!btn || !statusText) return;

    /** @type {{ downloadUrl: string; latestVersion: string } | null} */
    let pendingUpdate = null;
    let isWorking = false;

    // Listen for download progress events
    api.app.onUpdateProgress((/** @type {number} */ percent, /** @type {string|undefined} */ message) => {
        if (message) {
            statusText.textContent = message;
        } else if (percent >= 0) {
            statusText.textContent = `下载中 ${percent}%`;
        }
    });

    btn.addEventListener('click', async () => {
        if (isWorking) return;

        // If we already know there's an update, download it
        if (pendingUpdate) {
            isWorking = true;
            statusText.textContent = '正在测速...';
            btn.classList.add('updating');

            try {
                const result = await api.app.downloadUpdate(pendingUpdate.downloadUrl);
                if (result.success) {
                    statusText.textContent = '下载完成，请安装';
                } else {
                    statusText.textContent = '下载失败';
                    console.error('Download failed:', result.error);
                    setTimeout(() => {
                        statusText.textContent = `更新 v${pendingUpdate?.latestVersion}`;
                    }, 3000);
                }
            } catch (err) {
                statusText.textContent = '下载失败';
                console.error('Download error:', err);
                setTimeout(() => {
                    statusText.textContent = `更新 v${pendingUpdate?.latestVersion}`;
                }, 3000);
            } finally {
                isWorking = false;
                btn.classList.remove('updating');
            }
            return;
        }

        // Check for update
        isWorking = true;
        statusText.textContent = '检查中...';

        try {
            const result = await api.app.checkAppUpdate();
            if (result.hasUpdate && result.downloadUrl) {
                pendingUpdate = { downloadUrl: result.downloadUrl, latestVersion: result.latestVersion };
                statusText.textContent = '点击更新';
                btn.title = `${result.currentVersion} → ${result.latestVersion}`;
                btn.classList.add('has-update');
            } else if (result.hasUpdate) {
                statusText.textContent = `新版本 v${result.latestVersion}`;
                btn.title = '未找到下载文件，请前往 GitHub 手动下载';
            } else {
                statusText.textContent = '已是最新';
                btn.title = `当前版本: v${result.currentVersion}`;
                setTimeout(() => { statusText.textContent = '检查更新'; }, 3000);
            }
        } catch (err) {
            statusText.textContent = '检查失败';
            console.error('Update check error:', err);
            setTimeout(() => { statusText.textContent = '检查更新'; }, 3000);
        } finally {
            isWorking = false;
        }
    });

    // Auto-check on startup (silent, non-blocking)
    api.app.checkAppUpdate().then((/** @type {any} */ result) => {
        if (result.hasUpdate && result.downloadUrl) {
            pendingUpdate = { downloadUrl: result.downloadUrl, latestVersion: result.latestVersion };
            statusText.textContent = '点击更新';
            btn.title = `${result.currentVersion} → ${result.latestVersion}`;
            btn.classList.add('has-update');
        }
    }).catch(() => { /* ignore startup check failures */ });
}

async function refreshToolStatus() {
    const tools = await api.tools.list();
    for (const tool of tools) {
        const badgeEl = tool.id === 'claude-code'
            ? document.getElementById('badge-claude')
            : document.getElementById('badge-codex');
        if (badgeEl) {
            if (!tool.available) {
                badgeEl.textContent = '未安装';
                badgeEl.className = 'tool-badge unavailable';
            } else {
                badgeEl.textContent = tool.version || '就绪';
                badgeEl.className = 'tool-badge';

                // Async update check — non-blocking
                const toolId = tool.id;
                api.tools.checkUpdate(toolId).then((/** @type {any} */ result) => {
                    if (result.hasUpdate && badgeEl) {
                        badgeEl.textContent = '点击更新';
                        badgeEl.className = 'tool-badge updatable';
                        badgeEl.title = `${result.currentVersion} → ${result.latestVersion}`;
                    }
                }).catch(() => { /* ignore check failures */ });
            }
        }
    }
}

// ===== Update Tool =====
async function updateTool(/** @type {string} */ toolId, /** @type {string} */ badgeId) {
    const badgeEl = document.getElementById(badgeId);
    if (!badgeEl) return;

    const origText = badgeEl.textContent;
    badgeEl.textContent = '更新中...';
    badgeEl.className = 'tool-badge updating';
    badgeEl.style.pointerEvents = 'none';

    try {
        const result = await api.tools.update(toolId);
        if (result.success) {
            badgeEl.textContent = result.version || '已更新 ✓';
            badgeEl.className = 'tool-badge';
        } else {
            badgeEl.textContent = '更新失败';
            badgeEl.className = 'tool-badge unavailable';
            console.error('Update failed:', result.error);
            alert(`更新失败:\n${result.error}`);
            setTimeout(() => { badgeEl.textContent = origText; badgeEl.className = 'tool-badge'; }, 3000);
        }
    } catch (err) {
        badgeEl.textContent = '更新失败';
        badgeEl.className = 'tool-badge unavailable';
        console.error('Update error:', err);
        setTimeout(() => { badgeEl.textContent = origText; badgeEl.className = 'tool-badge'; }, 3000);
    } finally {
        badgeEl.style.pointerEvents = '';
    }
}

// ===== Launch Tool =====
async function launchTool(/** @type {string} */ toolId) {
    const tools = await api.tools.list();
    const tool = tools.find((/** @type {any} */ t) => t.id === toolId);
    if (!tool) return;

    if (!tool.available) {
        alert(`${tool.name} 的内置运行时或工具文件缺失。\n请重新安装应用，或重新执行打包流程。`);
        return;
    }

    // Check API key
    const hasKey = await api.config.hasApiKey(tool.provider);
    if (!hasKey) {
        const keyPrompt = prompt(`请输入 ${tool.envKeyName}:`);
        if (!keyPrompt) return;
        await api.config.setApiKey(tool.provider, keyPrompt);
    }

    try {
        const sessionId = await api.pty.create(toolId, state.currentCwd || undefined);
        createTab(toolId, tool.name, tool.icon, sessionId);

        const badgeEl = toolId === 'claude-code'
            ? document.getElementById('badge-claude')
            : document.getElementById('badge-codex');
        if (badgeEl) {
            badgeEl.textContent = '运行中';
            badgeEl.className = 'tool-badge running';
        }
    } catch (err) {
        console.error('Failed to launch tool:', err);
        alert(`启动 ${tool.name} 失败: ${err}`);
    }
}

// ===== Launch Terminal =====
async function launchTerminal() {
    try {
        const sessionId = await api.pty.create('terminal', state.currentCwd || undefined);
        createTab('terminal', 'Terminal', '⬛', sessionId);
    } catch (err) {
        console.error('Failed to launch terminal:', err);
        alert(`启动终端失败: ${err}`);
    }
}

// ===== Tab Management =====
function createTab(
  /** @type {string} */ toolId,
  /** @type {string} */ toolName,
  /** @type {string} */ toolIcon,
  /** @type {string} */ sessionId
) {
    const tabId = `tab-${++state.tabCounter}`;
    const themeName = document.documentElement.getAttribute('data-theme') || 'dark';

    const terminal = new Terminal({
        theme: getTerminalTheme(themeName),
        fontSize: 14,
        fontFamily: 'JetBrains Mono, Consolas, monospace',
        cursorBlink: true,
        cursorStyle: 'bar',
        allowProposedApi: true,
        scrollback: 10000,
    });

    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.loadAddon(new WebLinksAddon());

    const wrapper = document.createElement('div');
    wrapper.className = 'terminal-wrapper';
    wrapper.id = `terminal-${tabId}`;
    terminalContainer.appendChild(wrapper);
    terminal.open(wrapper);

    // ---- Floating copy/paste toolbar ----
    const toolbar = document.createElement('div');
    toolbar.className = 'terminal-toolbar';
    toolbar.innerHTML = `
        <button class="toolbar-btn" data-action="copy" title="Copy">📋 Copy</button>
        <button class="toolbar-btn" data-action="paste" title="Paste">📥 Paste</button>
    `;
    wrapper.appendChild(toolbar);

    toolbar.addEventListener('click', async (e) => {
        const btn = /** @type {HTMLElement} */ (e.target)?.closest('[data-action]');
        if (!btn) return;
        const action = btn.getAttribute('data-action');
        if (action === 'copy') {
            const sel = terminal.getSelection();
            if (sel) {
                await navigator.clipboard.writeText(sel);
                terminal.clearSelection();
                btn.textContent = '✅ Copied';
                setTimeout(() => { btn.textContent = '📋 Copy'; }, 1000);
            }
        } else if (action === 'paste') {
            const text = await navigator.clipboard.readText();
            if (text) api.pty.write(sessionId, text);
            terminal.focus();
        }
    });

    // Show/hide toolbar on selection
    terminal.onSelectionChange(() => {
        const sel = terminal.getSelection();
        toolbar.classList.toggle('has-selection', !!sel);
    });

    // ---- Keyboard interception ----
    terminal.attachCustomKeyEventHandler((e) => {
        if (e.type !== 'keydown') return true;

        // Ctrl+C: always intercept — copy if selected, otherwise do nothing (no SIGINT)
        if (e.ctrlKey && (e.code === 'KeyC' || e.key === 'c' || e.key === 'C')) {
            const sel = terminal.getSelection();
            if (sel) {
                navigator.clipboard.writeText(sel);
                terminal.clearSelection();
            }
            return false; // never send Ctrl+C to PTY
        }
        // Ctrl+V: paste from clipboard
        if (e.ctrlKey && (e.code === 'KeyV' || e.key === 'v' || e.key === 'V')) {
            navigator.clipboard.readText().then((text) => {
                if (text) api.pty.write(sessionId, text);
            });
            return false;
        }
        return true;
    });

    // Forward input to PTY
    terminal.onData((data) => {
        api.pty.write(sessionId, data);
    });

    // Create tab element
    const tabEl = document.createElement('div');
    tabEl.className = 'tab';
    tabEl.setAttribute('data-tab-id', tabId);
    tabEl.innerHTML = `
    <span>${toolIcon}</span>
    <span>${toolName}</span>
    <span class="tab-close" title="关闭">&times;</span>
  `;
    tabEl.addEventListener('click', (e) => {
        if (/** @type {HTMLElement} */(e.target)?.closest('.tab-close')) {
            closeTab(tabId);
        } else {
            activateTab(tabId);
        }
    });
    tabBar.appendChild(tabEl);

    const tabState = {
        id: tabId,
        toolId,
        toolName,
        toolIcon,
        sessionId,
        terminal,
        fitAddon,
        wrapper,
        tabElement: tabEl,
        cwd: state.currentCwd || '',
    };
    state.tabs.push(tabState);

    activateTab(tabId);
    refitTerminal(tabState);
    tabBarEmpty.classList.add('hidden');
    emptyState.classList.add('hidden');
}

function activateTab(/** @type {string} */ tabId) {
    state.activeTabId = tabId;

    for (const tab of state.tabs) {
        const isActive = tab.id === tabId;
        tab.tabElement.classList.toggle('active', isActive);
        tab.wrapper.classList.toggle('hidden', !isActive);
        if (isActive) {
            refitTerminal(tab, { focus: true });
            // Refresh file explorer for this tab's CWD
            if (tab.cwd) {
                loadFileTree(tab.cwd);
            }
        }
    }
}

function closeTab(/** @type {string} */ tabId) {
    const idx = state.tabs.findIndex(t => t.id === tabId);
    if (idx === -1) return;

    const tab = state.tabs[idx];
    api.pty.destroy(tab.sessionId);
    tab.terminal.dispose();
    tab.wrapper.remove();
    tab.tabElement.remove();
    state.tabs.splice(idx, 1);

    if (state.tabs.length === 0) {
        state.activeTabId = null;
        tabBarEmpty.classList.remove('hidden');
        emptyState.classList.remove('hidden');
        refreshToolStatus();
    } else if (state.activeTabId === tabId) {
        const newIdx = Math.min(idx, state.tabs.length - 1);
        activateTab(state.tabs[newIdx].id);
    }
}

// ===== PTY Listeners =====
function setupPtyListeners() {
    api.pty.onData((/** @type {string} */ sessionId, /** @type {string} */ data) => {
        const tab = state.tabs.find(t => t.sessionId === sessionId);
        if (tab) {
            tab.terminal.write(data);
        }
    });

    api.pty.onExit((/** @type {string} */ sessionId, /** @type {number} */ exitCode) => {
        const tab = state.tabs.find(t => t.sessionId === sessionId);
        if (tab) {
            tab.terminal.writeln(`\r\n\x1b[90m[进程已退出，代码: ${exitCode}]\x1b[0m`);
        }
        refreshToolStatus();
    });
}

// ===== Resize Handling =====
function setupResize() {
    let resizeTimer = /** @type {any} */ (null);
    const resizeObserver = new ResizeObserver(() => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
            const activeTab = state.tabs.find(t => t.id === state.activeTabId);
            if (activeTab) {
                refitTerminal(activeTab);
            }
        }, 100);
    });
    resizeObserver.observe(terminalContainer);
}

// ===== Settings Modal =====
function setupSettings() {
    const btnClose = /** @type {HTMLElement} */ ($('#btn-close-settings'));
    const btnSave = /** @type {HTMLElement} */ ($('#btn-save-settings'));
    const btnCancel = /** @type {HTMLElement} */ ($('#btn-cancel-settings'));
    const overlay = settingsModal.querySelector('.modal-overlay');

    const closeModal = () => settingsModal.classList.add('hidden');

    btnClose?.addEventListener('click', closeModal);
    btnCancel?.addEventListener('click', closeModal);
    overlay?.addEventListener('click', closeModal);

    btnSave?.addEventListener('click', async () => {
        const anthropicKey = /** @type {HTMLInputElement} */ ($('#settings-key-anthropic'))?.value?.trim();
        const openaiKey = /** @type {HTMLInputElement} */ ($('#settings-key-openai'))?.value?.trim();
        const anthropicBaseUrl = /** @type {HTMLInputElement} */ ($('#settings-baseurl-anthropic'))?.value?.trim();
        const openaiBaseUrl = /** @type {HTMLInputElement} */ ($('#settings-baseurl-openai'))?.value?.trim();
        const proxy = /** @type {HTMLInputElement} */ ($('#settings-proxy'))?.value?.trim();
        const fontSize = parseInt(/** @type {HTMLInputElement} */($('#settings-fontsize'))?.value || '14');
        const fontFamily = /** @type {HTMLInputElement} */ ($('#settings-fontfamily'))?.value?.trim();

        const anthropicModel = /** @type {HTMLInputElement} */ ($('#settings-model-anthropic'))?.value?.trim();
        const openaiModel = /** @type {HTMLInputElement} */ ($('#settings-model-openai'))?.value?.trim();

        if (anthropicKey) await api.config.setApiKey('anthropic', anthropicKey);
        if (openaiKey) await api.config.setApiKey('openai', openaiKey);
        if (anthropicBaseUrl) await api.config.setBaseUrl('anthropic', anthropicBaseUrl);
        if (openaiBaseUrl) await api.config.setBaseUrl('openai', openaiBaseUrl);
        if (anthropicModel) await api.config.setModel('anthropic', anthropicModel);
        if (openaiModel) await api.config.setModel('openai', openaiModel);
        const reasoningEffort = /** @type {HTMLInputElement} */ ($('#settings-reasoning-effort'))?.value?.trim();
        const verbosity = /** @type {HTMLInputElement} */ ($('#settings-verbosity'))?.value?.trim();
        if (reasoningEffort) await api.config.set('codexReasoningEffort', reasoningEffort);
        if (verbosity) await api.config.set('codexVerbosity', verbosity);
        await api.config.set('proxy', proxy || '');
        await api.config.set('fontSize', fontSize);
        await api.config.set('fontFamily', fontFamily || 'JetBrains Mono, Consolas, monospace');

        // Theme
        const theme = /** @type {HTMLSelectElement} */ ($('#settings-theme'))?.value || 'dark';
        await api.config.set('theme', theme);
        applyTheme(theme);

        closeModal();
    });
}

async function openSettings() {
    // Pre-fill current config values
    const proxy = await api.config.get('proxy');
    const fontSize = await api.config.get('fontSize');
    const fontFamily = await api.config.get('fontFamily');
    const anthropicBaseUrl = await api.config.getBaseUrl('anthropic');
    const openaiBaseUrl = await api.config.getBaseUrl('openai');
    const theme = await api.config.get('theme');

    const themeSelect = /** @type {HTMLSelectElement} */ ($('#settings-theme'));
    if (themeSelect) themeSelect.value = theme || 'fruit';

    const proxyInput = /** @type {HTMLInputElement} */ ($('#settings-proxy'));
    const fontSizeInput = /** @type {HTMLInputElement} */ ($('#settings-fontsize'));
    const fontFamilyInput = /** @type {HTMLInputElement} */ ($('#settings-fontfamily'));
    const anthropicBaseUrlInput = /** @type {HTMLInputElement} */ ($('#settings-baseurl-anthropic'));
    const openaiBaseUrlInput = /** @type {HTMLInputElement} */ ($('#settings-baseurl-openai'));

    if (proxyInput) proxyInput.value = proxy || '';
    if (fontSizeInput) fontSizeInput.value = String(fontSize || 14);
    if (fontFamilyInput) fontFamilyInput.value = fontFamily || 'JetBrains Mono, Consolas, monospace';
    if (anthropicBaseUrlInput) anthropicBaseUrlInput.value = anthropicBaseUrl || '';
    if (openaiBaseUrlInput) openaiBaseUrlInput.value = openaiBaseUrl || '';

    // Load model settings
    const anthropicModel = await api.config.getModel('anthropic');
    const openaiModel = await api.config.getModel('openai');
    const anthropicModelInput = /** @type {HTMLInputElement} */ ($('#settings-model-anthropic'));
    const openaiModelInput = /** @type {HTMLInputElement} */ ($('#settings-model-openai'));
    if (anthropicModelInput) anthropicModelInput.value = anthropicModel || '';
    if (openaiModelInput) openaiModelInput.value = openaiModel || '';

    // Load Codex reasoning params
    const reasoningEffort = await api.config.get('codexReasoningEffort');
    const verbosity = await api.config.get('codexVerbosity');
    const reasoningInput = /** @type {HTMLInputElement} */ ($('#settings-reasoning-effort'));
    const verbosityInput = /** @type {HTMLInputElement} */ ($('#settings-verbosity'));
    if (reasoningInput) reasoningInput.value = reasoningEffort || '';
    if (verbosityInput) verbosityInput.value = verbosity || '';

    // Load stored API keys (shown as password fields, revealable via eye button)
    const anthropicInput = /** @type {HTMLInputElement} */ ($('#settings-key-anthropic'));
    const openaiInput = /** @type {HTMLInputElement} */ ($('#settings-key-openai'));
    const storedAnthropicKey = await api.config.getApiKey('anthropic');
    const storedOpenaiKey = await api.config.getApiKey('openai');
    if (anthropicInput) anthropicInput.value = storedAnthropicKey || '';
    if (openaiInput) openaiInput.value = storedOpenaiKey || '';

    settingsModal.classList.remove('hidden');

    // Load debug launch config previews
    loadDebugPreviews();
}

async function loadDebugPreviews() {
    const claudePreview = /** @type {HTMLElement} */ (document.getElementById('debug-claude-config'));
    const codexPreview = /** @type {HTMLElement} */ (document.getElementById('debug-codex-config'));

    try {
        const claudeConfig = await api.tools.getLaunchPreview('claude-code');
        if (claudeConfig && claudePreview) {
            const display = {
                bin: claudeConfig.bin,
                args: claudeConfig.args,
                env: Object.fromEntries(
                    Object.entries(claudeConfig.env).map(([k, v]) =>
                        [k, k.includes('KEY') || k.includes('TOKEN') ? String(v).slice(0, 8) + '***' : v]
                    )
                ),
            };
            claudePreview.textContent = JSON.stringify(display, null, 2);
        } else if (claudePreview) {
            claudePreview.textContent = '未配置或工具不可用';
        }
    } catch (e) {
        if (claudePreview) claudePreview.textContent = '获取失败: ' + e;
    }

    try {
        const codexConfig = await api.tools.getLaunchPreview('codex');
        if (codexConfig && codexPreview) {
            const display = {
                bin: codexConfig.bin,
                args: codexConfig.args,
                env: Object.fromEntries(
                    Object.entries(codexConfig.env).map(([k, v]) =>
                        [k, k.includes('KEY') || k.includes('TOKEN') ? String(v).slice(0, 8) + '***' : v]
                    )
                ),
            };
            codexPreview.textContent = JSON.stringify(display, null, 2);
        } else if (codexPreview) {
            codexPreview.textContent = '未配置或工具不可用';
        }
    } catch (e) {
        if (codexPreview) codexPreview.textContent = '获取失败: ' + e;
    }
}

// ===== File Explorer =====
function setupFileExplorer() {
    const toggleBtn = document.getElementById('btn-toggle-explorer');
    toggleBtn?.addEventListener('click', () => {
        fileExplorer.classList.toggle('collapsed');
        if (!fileExplorer.classList.contains('collapsed') && state.currentCwd) {
            loadFileTree(state.currentCwd);
        }
    });
}

async function loadFileTree(/** @type {string} */ dirPath) {
    if (!dirPath || fileExplorer.classList.contains('collapsed')) return;

    const parts = dirPath.replace(/\\/g, '/').split('/');
    explorerPath.textContent = parts.slice(-2).join('/');
    explorerPath.title = dirPath;

    fileTree.innerHTML = '';
    const entries = await api.fs.readDir(dirPath);
    renderTreeEntries(fileTree, entries);
}

function renderTreeEntries(/** @type {HTMLElement} */ container, /** @type {any[]} */ entries) {
    for (const entry of entries) {
        const item = document.createElement('div');
        item.className = 'tree-item';
        item.innerHTML = `<span class="icon">${entry.isDirectory ? '📂' : '📄'}</span><span>${entry.name}</span>`;

        if (entry.isDirectory) {
            const wrapper = document.createElement('div');
            const children = document.createElement('div');
            children.className = 'tree-children';
            children.style.display = 'none';
            let loaded = false;

            item.addEventListener('click', async () => {
                if (!loaded) {
                    const subEntries = await api.fs.readDir(entry.path);
                    renderTreeEntries(children, subEntries);
                    loaded = true;
                }
                const isOpen = children.style.display !== 'none';
                children.style.display = isOpen ? 'none' : 'block';
                item.querySelector('.icon').textContent = isOpen ? '📂' : '📂';
            });

            wrapper.appendChild(item);
            wrapper.appendChild(children);
            container.appendChild(wrapper);
        } else {
            container.appendChild(item);
        }
    }
}

// ===== Boot =====
document.addEventListener('DOMContentLoaded', init);
