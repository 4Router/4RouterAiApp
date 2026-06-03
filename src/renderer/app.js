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
    workdirs: /** @type {string[]} */ ([]),
    tabCounter: 0,
    /** Cached `tools.list()` result, used to label mirrored sessions. */
    toolsMeta: /** @type {any[]|null} */ (null),
};

// ===== Shared-session mirroring =====
// Sessions live in the main process and are shared across every client (this
// window + any remote browser). Live pty output that arrives before a tab is
// ready (during scrollback replay) is parked here, keyed by sessionId, each
// chunk tagged with its cumulative end offset so replay can dedupe the overlap.
const pendingData = /** @type {Map<string, {end:number, data:string}[]>} */ (new Map());

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
 * @property {boolean} ready — false while scrollback is being replayed
 */

// ===== DOM References =====
const $ = (/** @type {string} */ sel) => document.querySelector(sel);
const welcomeScreen = /** @type {HTMLElement} */ ($('#welcome-screen'));
const appScreen = /** @type {HTMLElement} */ ($('#app-screen'));
const tabBar = /** @type {HTMLElement} */ ($('#tab-bar'));
const tabBarEmpty = /** @type {HTMLElement} */ ($('#tab-bar-empty'));const terminalContainer = /** @type {HTMLElement} */ ($('#terminal-container'));
const emptyState = /** @type {HTMLElement} */ ($('#empty-state'));
const settingsModal = /** @type {HTMLElement} */ ($('#settings-modal'));
const cwdList = /** @type {HTMLElement} */ ($('#cwd-list'));
const cwdListEmpty = /** @type {HTMLElement} */ ($('#cwd-list-empty'));
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

// Set once the terminal web font has loaded and terminals have been re-measured.
let webFontReady = false;

/**
 * Force xterm to re-measure its character cell size, then refit + nudge the PTY.
 *
 * The FIRST terminal opened before the web font (JetBrains Mono) finishes
 * loading measures its cell against the fallback font and caches a wrong size;
 * fit() reuses that cache, so the cols/rows sent to the PTY are wrong and the
 * CLI's TUI renders garbled. A tab switch happens to fix it (showing a hidden
 * terminal makes xterm re-measure), so we reproduce that explicitly: changing
 * fontSize forces charSizeService.measure() with the now-loaded font, then we
 * refit and briefly bump the PTY size so a full-screen TUI repaints at the
 * corrected width.
 * @param {TabState} tab
 */
function remeasureTerminal(tab) {
    if (!state.tabs.includes(tab) || tab.wrapper.classList.contains('hidden')) return;
    const term = tab.terminal;
    const w = tab.wrapper;

    // 1) A genuine fontSize change forces charSizeService.measure() with the
    //    now-loaded font (assigning the same value is a no-op).
    const fs = term.options.fontSize;
    term.options.fontSize = fs + 0.01;
    term.options.fontSize = fs;

    // 2) Reproduce a real tab switch: hide for one frame, then show + refit, so
    //    xterm's ResizeObserver re-measures the cell (this is the exact path a
    //    manual tab switch takes, which is known to fix the layout).
    w.classList.add('hidden');
    requestAnimationFrame(() => {
        if (!state.tabs.includes(tab)) return;
        w.classList.remove('hidden');
        requestAnimationFrame(() => {
            if (!state.tabs.includes(tab) || w.classList.contains('hidden')) return;
            tab.fitAddon.fit();
            const cols = term.cols, rows = term.rows;
            // Bump the PTY size then restore so a full-screen TUI gets a real
            // resize event and repaints at the corrected width.
            api.pty.resize(tab.sessionId, cols + 1, rows);
            requestAnimationFrame(() => {
                if (state.tabs.includes(tab)) api.pty.resize(tab.sessionId, cols, rows);
            });
        });
    });
}

/**
 * Force the current TUI to redraw at the correct geometry. A plain refit is
 * often not enough: full-screen TUIs (Claude Code / Codex) only repaint when
 * they receive a size *change*, so after the window is resized they can be left
 * with a broken layout even though xterm itself is already the right size. We
 * refit to the true dimensions, repaint xterm's own viewport, then nudge the
 * PTY by one column/row and immediately restore it so the child always gets a
 * genuine resize event (SIGWINCH) and performs a full redraw at the new width.
 *
 * This is non-destructive: it only nudges the app to repaint its *live* UI and
 * never clears the buffer. Text the CLI already hard-wrapped into the scrollback
 * at a narrower width cannot be reflowed (the original wide text is gone) and
 * these CLIs never reprint scrolled-off output, so those old lines stay as-is.
 * Clearing them was tried and only made the content vanish — worse, not better.
 * @param {TabState} tab
 */
function refreshTerminal(/** @type {TabState} */ tab) {
    if (!state.tabs.includes(tab) || tab.wrapper.classList.contains('hidden')) return;

    // Recompute the correct cols/rows for the current container size.
    tab.fitAddon.fit();
    const cols = tab.terminal.cols;
    const rows = tab.terminal.rows;

    // Repaint xterm's render layer in case it drifted out of sync. We do NOT
    // clear the buffer: clearing made committed history vanish (these CLIs never
    // reprint scrolled-off output), so keep everything and just redraw.
    tab.terminal.refresh(0, rows - 1);

    // Force the child to re-layout: a resize to the size it already has is a
    // no-op, so briefly report a size one column/row larger, then restore on
    // the next frame (the intermediate size is never painted). Nudging
    // *columns* — not just rows — is what makes a width-broken TUI reflow its
    // live UI back to the full width.
    api.pty.resize(tab.sessionId, cols + 1, rows + 1);
    requestAnimationFrame(() => {
        if (!state.tabs.includes(tab)) return;
        api.pty.resize(tab.sessionId, cols, rows);
        tab.terminal.scrollToBottom();
        tab.terminal.focus();
    });
}

// ===== Initialization =====
async function init() {
    setupWindowControls();
    setupToggleVisibility();
    await checkFirstLaunch();
    // Prime the tools list so mirrored tabs can be labelled synchronously.
    try { state.toolsMeta = await api.tools.list(); } catch { /* ignore */ }
    await applyTheme();
    setupWelcomeScreen();
    setupSidebar();
    setupSettings();
    setupAuthModal();
    setupPtyListeners();
    setupResize();
    setupMobile();
    setupFontReady();
    setupFileExplorer();
    checkRemoteConfigOnStartup();
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

    // Load saved working directories (migrate legacy single defaultCwd → list)
    let workdirs = await api.config.get('workdirs');
    const savedCwd = await api.config.get('defaultCwd');
    workdirs = Array.isArray(workdirs) ? workdirs.filter(Boolean) : [];
    if (!workdirs.length && savedCwd) {
        workdirs = [savedCwd];
        api.config.set('workdirs', workdirs);
    }
    state.workdirs = workdirs;
    state.currentCwd = savedCwd || workdirs[0] || '';
    renderWorkdirList();
}

function showWelcomeScreen() {
    welcomeScreen.classList.remove('hidden');
    appScreen.classList.add('hidden');
}

let sessionsSynced = false;
function showAppScreen() {
    welcomeScreen.classList.add('hidden');
    appScreen.classList.remove('hidden');
    // Mirror any sessions already running in the main process (created by this
    // app earlier or by another connected client). Runs once per load.
    if (!sessionsSynced) {
        sessionsSynced = true;
        void syncSessions();
    }
}

function shortenPath(/** @type {string} */ p) {
    if (p.length <= 30) return p;
    const parts = p.replace(/\\/g, '/').split('/');
    if (parts.length <= 3) return p;
    return parts[0] + '/.../' + parts.slice(-2).join('/');
}

// ===== Welcome Screen =====
function setupWelcomeScreen() {
    const setupChoice = /** @type {HTMLElement} */ ($('#setup-choice'));
    const setupManual = /** @type {HTMLElement} */ ($('#setup-manual'));
    const btnManual = /** @type {HTMLElement} */ ($('#btn-manual-config'));
    const btnSave = /** @type {HTMLElement} */ ($('#btn-save-keys'));

    // 点击"自行配置" → 展开手动配置表单
    btnManual?.addEventListener('click', () => {
        setupChoice.classList.add('hidden');
        setupManual.classList.remove('hidden');
    });

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

    // 两处 4Router 登录按钮都打开 WebView 登录流程
    $('#btn-login-4router')?.addEventListener('click', () => {
        handle4RouterLogin();
    });
    $('#btn-login-4router-manual')?.addEventListener('click', () => {
        handle4RouterLogin();
    });
}

function updateSetupStatus(/** @type {string} */ provider, /** @type {boolean} */ configured) {
    const el = document.getElementById(`status-${provider}`);
    if (el) {
        el.textContent = configured ? '已配置 ✓' : '未配置';
        el.classList.toggle('configured', configured);
    }
}

// ===== 4Router Embedded Login Flow =====
/** @type {ReturnType<typeof setInterval> | null} */
let authPollTimer = null;
let authPolling = false;
let authProvisioning = false;

function openAuthModal() {
    const modal = /** @type {HTMLElement} */ ($('#auth-login-modal'));
    const webview = /** @type {any} */ (document.getElementById('auth-webview'));
    const statusEl = /** @type {HTMLElement} */ ($('#auth-modal-status'));
    if (!modal || !webview) return;

    statusEl.textContent = '正在加载登录页…';
    webview.setAttribute('src', 'https://4router.net/login');
    modal.classList.remove('hidden');
}

function closeAuthModal() {
    const modal = /** @type {HTMLElement} */ ($('#auth-login-modal'));
    const webview = /** @type {any} */ (document.getElementById('auth-webview'));
    if (!modal) return;

    modal.classList.add('hidden');
    if (authPollTimer) { clearInterval(authPollTimer); authPollTimer = null; }
    authPolling = false;
    // Stop the in-modal page so it doesn't keep running in the background.
    if (webview) webview.setAttribute('src', 'about:blank');
}

async function handle4RouterLogin() {
    if (authProvisioning) return; // already finishing up
    openAuthModal();

    const statusEl = /** @type {HTMLElement} */ ($('#auth-modal-status'));

    const tick = async () => {
        if (authPolling || authProvisioning) return;
        authPolling = true;
        try {
            const status = await api.auth.checkLoginStatus();
            if (!status?.loggedIn) {
                if (statusEl) statusEl.textContent = '等待登录…';
                return;
            }

            // Logged in — stop polling, close modal, provision keys
            authProvisioning = true;
            if (authPollTimer) { clearInterval(authPollTimer); authPollTimer = null; }
            closeAuthModal();
            showToast('登录成功，正在配置 API Key…', 'info', 4000);

            try {
                const provisionResult = await api.provision.createKeys();
                if (!provisionResult.success) {
                    showToast(`Key 创建失败: ${provisionResult.error}`, 'error', 5000);
                    return;
                }
                await api.config.set('firstLaunch', false);
                showAppScreen();
                await refreshToolStatus();
                showToast('配置完成 ✓', 'success', 2500);
            } catch (err) {
                showToast(`配置失败: ${err}`, 'error', 5000);
            } finally {
                authProvisioning = false;
            }
        } finally {
            authPolling = false;
        }
    };

    if (authPollTimer) clearInterval(authPollTimer);
    authPollTimer = setInterval(tick, 3000);
    // Fire one immediately in case the user is already logged in from a prior session.
    tick();
}

// ===== Toast =====
/**
 * @param {string} message
 * @param {'info'|'success'|'error'} [type='info']
 * @param {number} [durationMs=2500]
 */
function showToast(message, type = 'info', durationMs = 2500) {
    const host = document.getElementById('toast-host');
    if (!host) return;

    const el = document.createElement('div');
    el.className = `toast toast-${type}`;
    el.textContent = message;
    host.appendChild(el);

    // Trigger enter animation
    requestAnimationFrame(() => el.classList.add('toast-visible'));

    setTimeout(() => {
        el.classList.remove('toast-visible');
        setTimeout(() => el.remove(), 250);
    }, durationMs);
}

function setupAuthModal() {
    $('#btn-close-auth-modal')?.addEventListener('click', closeAuthModal);
    const modal = /** @type {HTMLElement} */ ($('#auth-login-modal'));
    modal?.querySelector('.modal-overlay')?.addEventListener('click', closeAuthModal);

    // Update status when webview navigates / fails
    const webview = /** @type {any} */ (document.getElementById('auth-webview'));
    const statusEl = /** @type {HTMLElement} */ ($('#auth-modal-status'));
    if (webview && statusEl) {
        webview.addEventListener('did-start-loading', () => { statusEl.textContent = '加载中…'; });
        webview.addEventListener('did-stop-loading', () => {
            if (!authProvisioning) statusEl.textContent = '等待登录…';
        });
        webview.addEventListener('did-fail-load', (/** @type {any} */ e) => {
            if (e?.errorCode === -3) return; // ABORTED — happens when we navigate to about:blank
            statusEl.textContent = `加载失败 (${e?.errorCode || ''})`;
        });
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

    $('#btn-add-cwd')?.addEventListener('click', addWorkdir);

    $('#btn-settings')?.addEventListener('click', () => openSettings());

    $('#btn-open-website')?.addEventListener('click', () => {
        window.open('https://4router.net');
    });

    setupAppUpdateButton();

    refreshToolStatus();
}

// ===== Working Directories =====
function renderWorkdirList() {
    if (!cwdList) return;
    // Remove existing items but keep the empty-state placeholder element.
    cwdList.querySelectorAll('.cwd-item').forEach((el) => el.remove());

    if (!state.workdirs.length) {
        cwdListEmpty?.classList.remove('hidden');
        return;
    }
    cwdListEmpty?.classList.add('hidden');

    for (const dir of state.workdirs) {
        const item = document.createElement('div');
        item.className = 'cwd-item';
        item.setAttribute('data-path', dir);
        item.title = dir;

        const icon = document.createElement('span');
        icon.className = 'cwd-item-icon';
        icon.textContent = '📁';

        // Split into parent path + leaf so the last segment is always shown in
        // full; only the parent gets truncated (…) when the sidebar is narrow.
        const norm = dir.replace(/\\/g, '/').replace(/\/+$/, '');
        const slash = norm.lastIndexOf('/');
        const text = document.createElement('span');
        text.className = 'cwd-item-text';
        if (slash > 0) {
            const parentSpan = document.createElement('span');
            parentSpan.className = 'cwd-item-parent';
            parentSpan.textContent = norm.slice(0, slash);
            text.appendChild(parentSpan);
        }
        const leafSpan = document.createElement('span');
        leafSpan.className = 'cwd-item-leaf';
        leafSpan.textContent = slash > 0 ? norm.slice(slash) : (norm || dir);
        text.appendChild(leafSpan);

        const remove = document.createElement('span');
        remove.className = 'cwd-remove';
        remove.title = '移除';
        remove.textContent = '×';

        item.append(icon, text, remove);
        item.addEventListener('click', (e) => {
            if (/** @type {HTMLElement} */ (e.target)?.closest('.cwd-remove')) {
                removeWorkdir(dir);
            } else {
                selectWorkdir(dir);
            }
        });
        cwdList.appendChild(item);
    }

    syncDirLinkage();
}

/**
 * Two-way highlight: mark the selected directory's entry, and mark every tab
 * bound to it. `state.currentCwd` is the single source of truth and always
 * tracks the active tab's directory, so the link stays in sync both ways.
 */
function syncDirLinkage() {
    const linked = state.currentCwd;
    if (cwdList) {
        cwdList.querySelectorAll('.cwd-item').forEach((el) => {
            el.classList.toggle('selected', !!linked && el.getAttribute('data-path') === linked);
        });
    }
    for (const tab of state.tabs) {
        tab.tabElement.classList.toggle('dir-linked', !!linked && tab.cwd === linked);
    }
}

async function addWorkdir() {
    const dir = await api.dialog.selectDirectory();
    if (!dir) return;
    if (!state.workdirs.includes(dir)) {
        state.workdirs.push(dir);
        await api.config.set('workdirs', state.workdirs);
        renderWorkdirList();
    }
    selectWorkdir(dir);
}

/**
 * Select a working directory: make it the launch target for new tools and, if
 * a tab is already bound to it, switch to that tab. Drives the dir→tab half of
 * the two-way highlight.
 * @param {string} dir
 */
function selectWorkdir(dir) {
    if (!dir) return;
    state.currentCwd = dir;
    api.config.set('defaultCwd', dir);

    const bound = state.tabs.filter((t) => t.cwd === dir);
    const activeIsBound = bound.some((t) => t.id === state.activeTabId);
    if (bound.length && !activeIsBound) {
        // Jump to the first tab running in this directory; activateTab re-syncs.
        activateTab(bound[0].id);
    } else {
        loadFileTree(dir);
        syncDirLinkage();
    }
}

/**
 * Remove a directory bookmark. Tabs already running in it keep running — this
 * only drops it from the sidebar list.
 * @param {string} dir
 */
async function removeWorkdir(dir) {
    const idx = state.workdirs.indexOf(dir);
    if (idx === -1) return;
    state.workdirs.splice(idx, 1);
    await api.config.set('workdirs', state.workdirs);

    if (state.currentCwd === dir) {
        // Fall back to the active tab's directory, then the first remaining one.
        const activeTab = state.tabs.find((t) => t.id === state.activeTabId);
        state.currentCwd = (activeTab && activeTab.cwd) || state.workdirs[0] || '';
        if (state.currentCwd) {
            api.config.set('defaultCwd', state.currentCwd);
            loadFileTree(state.currentCwd);
        }
    }
    renderWorkdirList();
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
            btn.classList.remove('updatable');
            btn.classList.add('updating');

            try {
                const result = await api.app.downloadUpdate(pendingUpdate.downloadUrl);
                if (result.success) {
                    statusText.textContent = '下载完成，请安装';
                } else {
                    statusText.textContent = '下载失败';
                    console.error('Download failed:', result.error);
                    setTimeout(() => {
                        statusText.textContent = '点击更新';
                        btn.classList.add('updatable');
                    }, 3000);
                }
            } catch (err) {
                statusText.textContent = '下载失败';
                console.error('Download error:', err);
                setTimeout(() => {
                    statusText.textContent = '点击更新';
                    btn.classList.add('updatable');
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
                btn.classList.add('updatable');
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
            btn.classList.add('updatable');
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
        const cwd = state.currentCwd || '';
        const sessionId = await api.pty.create(toolId, cwd || undefined);
        // The tab may already exist via the pty:created broadcast; ensureTab is
        // idempotent. Then focus it (the user explicitly launched this one).
        ensureTab({ sessionId, toolId, cwd }, /*replay*/ false, /*activate*/ true);
        activateBySession(sessionId);

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
        const cwd = state.currentCwd || '';
        const sessionId = await api.pty.create('terminal', cwd || undefined);
        ensureTab({ sessionId, toolId: 'terminal', cwd }, /*replay*/ false, /*activate*/ true);
        activateBySession(sessionId);
    } catch (err) {
        console.error('Failed to launch terminal:', err);
        alert(`启动终端失败: ${err}`);
    }
}

// ===== Clipboard Paste Helper =====
/**
 * Paste clipboard contents into the PTY.
 * Falls back to image (saved as temp file, path sent wrapped in bracketed
 * paste markers) when the clipboard has no text.
 * @param {string} sessionId
 */
async function pasteFromClipboard(sessionId) {
    try {
        // Try text first — covers normal text paste and mixed text+image clipboards
        // (where the user meant to paste the text).
        let text = '';
        try {
            text = await navigator.clipboard.readText();
        } catch {
            text = '';
        }
        if (text) {
            api.pty.write(sessionId, text);
            return;
        }

        // No text — try an image. Main process writes a temp .png and returns the path.
        const imagePath = await api.clipboard?.readImage?.();
        if (imagePath) {
            // Wrap in bracketed paste markers so Claude Code CLI's paste handler
            // treats it as a paste and its `isImageFilePath` check resolves the
            // path to an image attachment. Prefixed with a space to match the
            // CLI's path-after-space splitter.
            const BRACKET_PASTE_START = '\x1b[200~';
            const BRACKET_PASTE_END = '\x1b[201~';
            api.pty.write(sessionId, `${BRACKET_PASTE_START} ${imagePath}${BRACKET_PASTE_END}`);
        }
    } catch (err) {
        console.error('[pasteFromClipboard] failed:', err);
    }
}

// ===== Tab Management =====
function createTab(
  /** @type {string} */ toolId,
  /** @type {string} */ toolName,
  /** @type {string} */ toolIcon,
  /** @type {string} */ sessionId,
  /** @type {string} */ cwd = state.currentCwd || '',
  /** @type {boolean} */ activate = true
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
        <button class="toolbar-btn" data-action="refresh" title="重绘 TUI（修复窗口缩放后当前界面的排版错位，不清空历史）">🔄 刷新</button>
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
            await pasteFromClipboard(sessionId);
            terminal.focus();
        } else if (action === 'refresh') {
            refreshTerminal(tabState);
            btn.textContent = '✅ 已刷新';
            setTimeout(() => { btn.textContent = '🔄 刷新'; }, 1000);
        }
    });

    // Show/hide toolbar on selection
    terminal.onSelectionChange(() => {
        const sel = terminal.getSelection();
        toolbar.classList.toggle('has-selection', !!sel);
    });

    // Tap-to-focus: on touch devices, tapping the terminal must focus xterm's
    // hidden textarea to summon the on-screen keyboard.
    wrapper.addEventListener('click', (e) => {
        if (/** @type {HTMLElement} */ (e.target)?.closest('.terminal-toolbar')) return;
        terminal.focus();
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
        // Ctrl+V: paste from clipboard (text or image)
        if (e.ctrlKey && (e.code === 'KeyV' || e.key === 'v' || e.key === 'V')) {
            e.preventDefault();
            pasteFromClipboard(sessionId);
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
        cwd: cwd || '',
        ready: false,
    };
    state.tabs.push(tabState);

    tabBarEmpty.classList.add('hidden');
    emptyState.classList.add('hidden');

    // Auto-activate when the user launched this tab, or when it's the only one.
    // Mirrored tabs from another client are added without stealing focus.
    if (activate || state.tabs.length === 1) {
        activateTab(tabId);
        refitTerminal(tabState);
    } else {
        wrapper.classList.add('hidden');
    }

    return tabState;
}

// ===== Shared-session helpers =====

/** Resolve display name/icon for a session's tool from the cached tools list. */
function resolveToolMeta(/** @type {string} */ toolId) {
    if (toolId === 'terminal') return { name: 'Terminal', icon: '⬛' };
    const t = (state.toolsMeta || []).find((m) => m.id === toolId);
    return { name: (t && t.name) || toolId, icon: (t && t.icon) || '⬛' };
}

/**
 * Flush parked live output into a freshly-attached tab.
 * @param {TabState} tab
 * @param {number|null} threshold offset already covered by replayed scrollback;
 *   chunks at/below it are dropped, a straddling chunk is sliced. null = write all.
 */
function flushPending(/** @type {TabState} */ tab, /** @type {number|null} */ threshold) {
    const q = pendingData.get(tab.sessionId);
    if (!q) return;
    for (const chunk of q) {
        if (threshold == null) { tab.terminal.write(chunk.data); continue; }
        const start = chunk.end - chunk.data.length;
        if (chunk.end <= threshold) continue;          // fully inside replayed buffer
        if (start >= threshold) tab.terminal.write(chunk.data);
        else tab.terminal.write(chunk.data.slice(threshold - start)); // partial overlap
    }
    pendingData.delete(tab.sessionId);
}

/**
 * Make sure a tab exists for a shared session, creating it if needed.
 * @param {{sessionId:string, toolId:string, cwd?:string}} session
 * @param {boolean} replay  fetch & write the session's existing scrollback
 * @param {boolean} activate  focus the new tab
 */
function ensureTab(session, replay, activate) {
    if (state.tabs.some((t) => t.sessionId === session.sessionId)) return;
    const meta = resolveToolMeta(session.toolId);
    const tab = createTab(session.toolId, meta.name, meta.icon, session.sessionId, session.cwd || '', activate);

    if (replay) {
        api.pty.attach(session.sessionId).then((buf) => {
            const data = (buf && buf.data) || '';
            const endOffset = (buf && buf.endOffset) || 0;
            if (data) tab.terminal.write(data);
            flushPending(tab, endOffset);
            tab.ready = true;
            if (tab.id === state.activeTabId) refreshTerminal(tab);
        }).catch(() => {
            flushPending(tab, null);
            tab.ready = true;
        });
    } else {
        flushPending(tab, null);
        tab.ready = true;
    }
}

/** Activate the tab bound to a session id, if present. */
function activateBySession(/** @type {string} */ sessionId) {
    const tab = state.tabs.find((t) => t.sessionId === sessionId);
    if (tab) activateTab(tab.id);
}

/** Reconcile local tabs with the main process's live session list (mirroring). */
async function syncSessions() {
    try {
        if (!state.toolsMeta) state.toolsMeta = await api.tools.list();
        const sessions = await api.pty.list();
        for (const s of sessions) ensureTab(s, /*replay*/ true, /*activate*/ false);
        if (!state.activeTabId && state.tabs.length) activateTab(state.tabs[0].id);
    } catch (err) {
        console.error('[syncSessions] failed:', err);
    }
}

function activateTab(/** @type {string} */ tabId) {
    state.activeTabId = tabId;

    for (const tab of state.tabs) {
        const isActive = tab.id === tabId;
        tab.tabElement.classList.toggle('active', isActive);
        tab.wrapper.classList.toggle('hidden', !isActive);
        if (isActive) {
            refitTerminal(tab, { focus: true });
            // The selected working directory follows the active tab (tab→dir link).
            if (tab.cwd) {
                state.currentCwd = tab.cwd;
                loadFileTree(tab.cwd);
            }
        }
    }

    syncDirLinkage();
}

/** Remove a tab from THIS client's UI only (no pty kill). Shared by the user
 *  close path and the pty:closed mirror handler. */
function removeTab(/** @type {string} */ tabId) {
    const idx = state.tabs.findIndex(t => t.id === tabId);
    if (idx === -1) return;

    const tab = state.tabs[idx];
    tab.terminal.dispose();
    tab.wrapper.remove();
    tab.tabElement.remove();
    state.tabs.splice(idx, 1);
    pendingData.delete(tab.sessionId);

    if (state.tabs.length === 0) {
        state.activeTabId = null;
        tabBarEmpty.classList.remove('hidden');
        emptyState.classList.remove('hidden');
        syncDirLinkage();
        refreshToolStatus();
    } else if (state.activeTabId === tabId) {
        const newIdx = Math.min(idx, state.tabs.length - 1);
        activateTab(state.tabs[newIdx].id);
    }
}

function closeTab(/** @type {string} */ tabId) {
    const tab = state.tabs.find(t => t.id === tabId);
    if (!tab) return;
    // Destroy the shared pty; the main process broadcasts pty:closed so every
    // other client drops its mirrored tab too.
    api.pty.destroy(tab.sessionId);
    removeTab(tabId);
}

// ===== PTY Listeners =====
function setupPtyListeners() {
    api.pty.onData((/** @type {string} */ sessionId, /** @type {string} */ data, /** @type {number} */ endOffset) => {
        const tab = state.tabs.find(t => t.sessionId === sessionId);
        if (tab && tab.ready) {
            tab.terminal.write(data);
        } else {
            // Tab not created/ready yet (mirrored session mid-replay): park it.
            const arr = pendingData.get(sessionId) || [];
            arr.push({ end: endOffset || 0, data });
            pendingData.set(sessionId, arr);
        }
    });

    // Another client (or this one) created a session → mirror it as a tab.
    api.pty.onCreated((/** @type {{sessionId:string,toolId:string,cwd:string}} */ session) => {
        ensureTab(session, /*replay*/ true, /*activate*/ false);
    });

    // A session was deliberately closed somewhere → drop the mirrored tab here.
    api.pty.onClosed((/** @type {string} */ sessionId) => {
        const tab = state.tabs.find(t => t.sessionId === sessionId);
        if (tab) removeTab(tab.id);
    });

    api.pty.onExit((/** @type {string} */ sessionId, /** @type {number} */ exitCode) => {
        const tab = state.tabs.find(t => t.sessionId === sessionId);
        if (tab) {
            tab.terminal.writeln(`\r\n\x1b[90m[进程已退出，代码: ${exitCode}]\x1b[0m`);
        }
        refreshToolStatus();
    });
}

// ===== Web font readiness =====
// When the terminal web font loads after a terminal was already opened, the
// active terminal's cached cell size is stale — re-measure it so its layout
// (and the CLI's TUI) corrects without needing a manual tab switch.
function setupFontReady() {
    if (webFontReady || !document.fonts?.load) return;
    Promise.resolve(document.fonts.load('14px "JetBrains Mono"'))
        .catch(() => { })
        .then(() => document.fonts.ready)
        .then(() => {
            webFontReady = true;
            const active = state.tabs.find(t => t.id === state.activeTabId);
            if (active) remeasureTerminal(active);
        })
        .catch(() => { /* ignore */ });
}

// ===== Mobile / touch adaptation =====
function setupMobile() {
    const menuBtn = $('#btn-menu');
    const backdrop = $('#sidebar-backdrop');
    const sidebar = $('#sidebar');
    const closeSidebar = () => document.body.classList.remove('sidebar-open');

    menuBtn?.addEventListener('click', () => document.body.classList.toggle('sidebar-open'));
    backdrop?.addEventListener('click', closeSidebar);
    // Launching a tool / picking a workdir from the drawer closes it.
    sidebar?.addEventListener('click', (e) => {
        if (/** @type {HTMLElement} */ (e.target)?.closest('.tool-launch-btn, .cwd-item')) {
            closeSidebar();
        }
    });

    // ---- Floating terminal control panel (Copy/Paste/Refresh + Esc + arrows) ----
    const ctrlToggle = $('#mobile-ctrl-toggle');
    const ctrlPanel = $('#mobile-ctrl-panel');
    const getActiveTab = () => state.tabs.find(t => t.id === state.activeTabId);
    // ANSI sequences for the special keys.
    const KEY_SEQ = { esc: '\x1b', up: '\x1b[A', down: '\x1b[B', right: '\x1b[C', left: '\x1b[D' };

    ctrlToggle?.addEventListener('click', () => {
        const open = ctrlPanel?.classList.toggle('open');
        ctrlToggle.classList.toggle('active', !!open);
    });

    ctrlPanel?.addEventListener('click', async (e) => {
        const btn = /** @type {HTMLElement} */ (e.target)?.closest('[data-mc]');
        if (!btn) return;
        const action = btn.getAttribute('data-mc');
        const tab = getActiveTab();
        if (!tab) return;

        if (action === 'copy') {
            const sel = tab.terminal.getSelection();
            if (sel) { await navigator.clipboard.writeText(sel).catch(() => { }); tab.terminal.clearSelection(); }
        } else if (action === 'paste') {
            await pasteFromClipboard(tab.sessionId);
        } else if (action === 'refresh') {
            refreshTerminal(tab);
        } else if (action && KEY_SEQ[action]) {
            api.pty.write(tab.sessionId, KEY_SEQ[action]);
        }
        // Keep the soft keyboard up so arrow/esc taps don't dismiss it.
        tab.terminal.focus();
    });

    // The on-screen keyboard shrinks the visual viewport. Mirror its height into
    // --app-vh (consumed by the mobile CSS) so the terminal stays above the
    // keyboard, then refit the active terminal to the new size. Web only — the
    // desktop window has no soft keyboard and uses the normal resize path.
    const vv = window.visualViewport;
    if (vv && document.documentElement.classList.contains('web-mode')) {
        const apply = () => {
            document.documentElement.style.setProperty('--app-vh', vv.height + 'px');
            // Height the keyboard covers, so the control FAB/panel float above it.
            const kbInset = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
            document.documentElement.style.setProperty('--kb-inset', kbInset + 'px');
            const activeTab = state.tabs.find(t => t.id === state.activeTabId);
            if (activeTab) refitTerminal(activeTab);
        };
        vv.addEventListener('resize', apply);
        vv.addEventListener('scroll', apply);
        apply();
    }
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
    const btnReset = /** @type {HTMLButtonElement} */ ($('#btn-reset-settings'));
    const overlay = settingsModal.querySelector('.modal-overlay');

    const closeModal = () => settingsModal.classList.add('hidden');

    btnClose?.addEventListener('click', closeModal);
    btnCancel?.addEventListener('click', closeModal);
    overlay?.addEventListener('click', closeModal);

    btnReset?.addEventListener('click', async () => {
        const confirmed = confirm(
            '⚠️ 恢复初始设置将：\n' +
            '\n' +
            '• 清除所有 API Key 与 Base URL\n' +
            '• 清除 4Router 登录状态\n' +
            '• 重置主题、字体、模型、effort 等所有偏好\n' +
            '• 关闭当前所有运行中的工具/终端\n' +
            '• 返回欢迎页面\n' +
            '\n' +
            '此操作不可撤销，确定继续吗？'
        );
        if (!confirmed) return;

        btnReset.disabled = true;
        const origText = btnReset.textContent;
        btnReset.textContent = '正在重置...';
        try {
            const result = await api.app.resetAll();
            if (!result?.success) {
                alert(`重置失败: ${result?.error || '未知错误'}`);
                btnReset.disabled = false;
                btnReset.textContent = origText;
                return;
            }
            // Reload the renderer — init() will see firstLaunch=true and show
            // the welcome screen with no API keys configured.
            window.location.reload();
        } catch (err) {
            alert(`重置失败: ${err}`);
            btnReset.disabled = false;
            btnReset.textContent = origText;
        }
    });

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
        const ccEffort = /** @type {HTMLInputElement} */ ($('#settings-cc-effort'))?.value?.trim();
        await api.config.set('ccEffortLevel', ccEffort || '');
        const ccBypassPermissions = /** @type {HTMLInputElement} */ ($('#settings-cc-bypass-permissions'))?.checked || false;
        await api.config.set('ccBypassPermissions', ccBypassPermissions);
        const codexBypassPermissions = /** @type {HTMLInputElement} */ ($('#settings-codex-bypass-permissions'))?.checked || false;
        await api.config.set('codexBypassPermissions', codexBypassPermissions);
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

        // Remote web access — persist + (re)start/stop the bridge.
        await applyWebSettings();

        closeModal();
    });

    // Toggling the enable / LAN switches applies immediately so the access URLs
    // appear (or clear) without closing the panel.
    $('#settings-web-enabled')?.addEventListener('change', () => { void applyWebSettings(); });
    $('#settings-web-lan')?.addEventListener('change', () => { void applyWebSettings(); });
}

/** Render the list of reachable URLs (or a hint) into the settings panel. */
function renderWebUrls(/** @type {any} */ status) {
    const box = $('#settings-web-urls');
    if (!box) return;
    if (!status || !status.running || !status.urls?.length) {
        box.textContent = status?.enabled ? '启动失败，请检查端口是否被占用' : '未启用';
        return;
    }
    box.innerHTML = status.urls
        .map((/** @type {string} */ u) => `<div>${u.replace(/</g, '&lt;')}</div>`)
        .join('');
}

/** Read the web inputs, apply them in the main process, refresh the URL list. */
async function applyWebSettings() {
    if (!api.web) return;
    const cfg = {
        enabled: /** @type {HTMLInputElement} */ ($('#settings-web-enabled'))?.checked || false,
        port: parseInt(/** @type {HTMLInputElement} */($('#settings-web-port'))?.value || '4178', 10) || 4178,
        allowLan: /** @type {HTMLInputElement} */ ($('#settings-web-lan'))?.checked || false,
        token: /** @type {HTMLInputElement} */ ($('#settings-web-token'))?.value?.trim() || '',
    };
    try {
        const status = await api.web.apply(cfg);
        renderWebUrls(status);
    } catch (err) {
        console.error('[applyWebSettings] failed:', err);
    }
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

    // Load Claude Code effort level
    const ccEffort = await api.config.get('ccEffortLevel');
    const ccEffortInput = /** @type {HTMLInputElement} */ ($('#settings-cc-effort'));
    if (ccEffortInput) ccEffortInput.value = ccEffort || '';

    // Load Claude Code bypass-permissions toggle
    const ccBypass = await api.config.get('ccBypassPermissions');
    const ccBypassInput = /** @type {HTMLInputElement} */ ($('#settings-cc-bypass-permissions'));
    if (ccBypassInput) ccBypassInput.checked = !!ccBypass;

    // Load Codex reasoning params
    const reasoningEffort = await api.config.get('codexReasoningEffort');
    const verbosity = await api.config.get('codexVerbosity');
    const reasoningInput = /** @type {HTMLInputElement} */ ($('#settings-reasoning-effort'));
    const verbosityInput = /** @type {HTMLInputElement} */ ($('#settings-verbosity'));
    if (reasoningInput) reasoningInput.value = reasoningEffort || '';
    if (verbosityInput) verbosityInput.value = verbosity || '';

    // Load Codex bypass-permissions toggle
    const codexBypass = await api.config.get('codexBypassPermissions');
    const codexBypassInput = /** @type {HTMLInputElement} */ ($('#settings-codex-bypass-permissions'));
    if (codexBypassInput) codexBypassInput.checked = !!codexBypass;

    // Load stored API keys (shown as password fields, revealable via eye button)
    const anthropicInput = /** @type {HTMLInputElement} */ ($('#settings-key-anthropic'));
    const openaiInput = /** @type {HTMLInputElement} */ ($('#settings-key-openai'));
    const storedAnthropicKey = await api.config.getApiKey('anthropic');
    const storedOpenaiKey = await api.config.getApiKey('openai');
    if (anthropicInput) anthropicInput.value = storedAnthropicKey || '';
    if (openaiInput) openaiInput.value = storedOpenaiKey || '';

    // Load remote web access status + config.
    if (api.web) {
        try {
            const web = await api.web.getStatus();
            const en = /** @type {HTMLInputElement} */ ($('#settings-web-enabled'));
            const port = /** @type {HTMLInputElement} */ ($('#settings-web-port'));
            const lan = /** @type {HTMLInputElement} */ ($('#settings-web-lan'));
            const token = /** @type {HTMLInputElement} */ ($('#settings-web-token'));
            if (en) en.checked = !!web.enabled;
            if (port) port.value = String(web.port || 4178);
            if (lan) lan.checked = !!web.allowLan;
            if (token) token.value = web.token || '';
            renderWebUrls(web);
        } catch (err) {
            console.error('[openSettings] web status failed:', err);
        }
    }

    settingsModal.classList.remove('hidden');

    // Show app version
    const versionEl = document.getElementById('settings-app-version');
    if (versionEl) {
        const version = await api.app.getVersion();
        versionEl.textContent = version ? `v${version}` : '';
    }

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
// ===== Remote Config Sync =====
function checkRemoteConfigOnStartup() {
    api.app.checkRemoteConfig().then((/** @type {any} */ result) => {
        if (!result.hasChanges || !result.changes.length) return;

        const modal = /** @type {HTMLElement} */ ($('#config-update-modal'));
        const changesList = /** @type {HTMLElement} */ ($('#config-changes-list'));
        if (!modal || !changesList) return;

        // Build changes table
        let html = '<table style="width:100%;border-collapse:collapse;font-size:13px;">';
        html += '<tr style="opacity:0.6;"><th style="text-align:left;padding:6px 8px;">配置项</th><th style="text-align:left;padding:6px 8px;">当前值</th><th style="text-align:left;padding:6px 8px;"></th><th style="text-align:left;padding:6px 8px;">新值</th></tr>';
        for (const change of result.changes) {
            html += `<tr style="border-top:1px solid rgba(128,128,128,0.2);">`;
            html += `<td style="padding:6px 8px;font-weight:500;">${change.key}</td>`;
            html += `<td style="padding:6px 8px;opacity:0.6;text-decoration:line-through;">${change.oldValue}</td>`;
            html += `<td style="padding:6px 8px;">→</td>`;
            html += `<td style="padding:6px 8px;color:#3fb950;font-weight:600;">${change.newValue}</td>`;
            html += `</tr>`;
        }
        html += '</table>';
        changesList.innerHTML = html;

        // Show modal
        modal.classList.remove('hidden');

        const closeModal = () => modal.classList.add('hidden');

        $('#btn-close-config-modal')?.addEventListener('click', closeModal);
        $('#btn-dismiss-config')?.addEventListener('click', closeModal);
        modal.querySelector('.modal-overlay')?.addEventListener('click', closeModal);

        $('#btn-apply-config')?.addEventListener('click', async () => {
            await api.app.applyRemoteConfig(result.remoteConfig);
            closeModal();
        });
    }).catch(() => { /* ignore startup config check failures */ });
}

// ===== Boot =====
document.addEventListener('DOMContentLoaded', init);
