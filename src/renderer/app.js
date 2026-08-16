import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';

// ============================================================
// 4RouterAi — Main Renderer Application
// ============================================================

/** @type {typeof window.routerAi} */
const api = /** @type {any} */ (window).routerAi;

// ===== Icon system =====
// 与 index.html 保持一致的手工 SVG 图标（1.8 圆头描边 / 填充星芒）。
const ICONS = {
    spark: '<svg class="icon icon-fill" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.2l2.5 7.3L21.8 12l-7.3 2.5L12 21.8l-2.5-7.3L2.2 12l7.3-2.5L12 2.2z"/></svg>',
    code: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M8.5 7L4 12l4.5 5M15.5 7l4.5 5-4.5 5"/></svg>',
    terminal: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4.5" width="18" height="15" rx="3"/><path d="M7.5 9.5l3 2.7-3 2.7M13.5 15.2h3.5"/></svg>',
    folder: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 7.8c0-1.1.9-2 2-2h4.1l2 2.2h6.9c1.1 0 2 .9 2 2v8.2c0 1.1-.9 2-2 2h-13c-1.1 0-2-.9-2-2V7.8z"/></svg>',
    file: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M6.5 3.5h6.8L19 9.2v9.3c0 1.1-.9 2-2 2H6.5c-1.1 0-2-.9-2-2v-13c0-1.1.9-2 2-2z"/><path d="M13 3.8V9h5.4"/></svg>',
    chevron: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M9.5 6.5l5.5 5.5-5.5 5.5"/></svg>',
    close: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    copy: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="9.5" y="9.5" width="11" height="11" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
    paste: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1"/><path d="M12 10.5v6M9.5 14l2.5 2.5L14.5 14"/></svg>',
    refresh: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M21 4v6h-6"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L21 10"/></svg>',
    phone: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="7.5" y="2.5" width="9" height="19" rx="2.2"/><path d="M11 18.5h2"/></svg>',
    monitor: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="2.5" y="4.5" width="19" height="12.5" rx="2"/><path d="M8.5 20.5h7M12 17v3.5"/></svg>',
    pencil: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20l4.5-1 11-11a2.1 2.1 0 0 0-3-3l-11 11L4 20z"/></svg>',
    external: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M13.5 4.5H19.5V10.5"/><path d="M19.5 4.5L11 13"/><path d="M19 14v4.5a2 2 0 0 1-2 2H5.5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2H10"/></svg>',
};

/** toolId → 标签页图标（带品牌配色的样式类）。 */
function toolGlyphHTML(/** @type {string} */ toolId, /** @type {string} */ fallbackIcon = '') {
    if (toolId === 'claude-code') return `<span class="tab-icon tab-icon--claude">${ICONS.spark}</span>`;
    if (toolId === 'codex') return `<span class="tab-icon tab-icon--codex">${ICONS.code}</span>`;
    if (toolId === 'terminal') return `<span class="tab-icon tab-icon--terminal">${ICONS.terminal}</span>`;
    return `<span class="tab-icon">${esc(fallbackIcon)}</span>`;
}

/** Escape text for safe interpolation into innerHTML templates. */
function esc(/** @type {unknown} */ value) {
    return String(value ?? '').replace(/[&<>"']/g, (ch) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch] || ch
    ));
}

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
    setupRemotePanel();
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

    // Update native Windows titlebar button colors (must match --titlebar-bg)
    try {
        if (theme === 'light') {
            api.window.setTitleBarOverlay({ color: '#f2f3f7', symbolColor: '#5c6478' });
        } else if (theme === 'fruit') {
            api.window.setTitleBarOverlay({ color: '#fbf3e3', symbolColor: '#7e6135' });
        } else {
            api.window.setTitleBarOverlay({ color: '#0b0d12', symbolColor: '#9aa3b8' });
        }
    } catch { /* ignore if not supported */ }

    const terminalTheme = getTerminalTheme(theme);
    for (const tab of state.tabs) {
        tab.terminal.options.theme = terminalTheme;
    }
}

function getTerminalTheme(/** @type {string} */ theme) {
    // 背景色与 CSS 的 --bg-term 严格一致，终端与界面浑然一体。
    const darkTheme = {
        background: '#0e1117',
        foreground: '#dde3ee',
        cursor: '#f09450',
        cursorAccent: '#0e1117',
        selectionBackground: 'rgba(240,148,80,0.28)',
        black: '#464e5e', red: '#f2716b', green: '#63c983', yellow: '#e6b04e',
        blue: '#7fa7f2', magenta: '#b9a3f5', cyan: '#58c7d4', white: '#dde3ee',
        brightBlack: '#5f6880', brightRed: '#ff938e', brightGreen: '#84dda0', brightYellow: '#f4c778',
        brightBlue: '#a3c2fa', brightMagenta: '#d0bffa', brightCyan: '#7fdce8', brightWhite: '#f2f5fa',
    };
    const lightTheme = {
        background: '#ffffff',
        foreground: '#2a3040',
        cursor: '#e0761f',
        cursorAccent: '#ffffff',
        selectionBackground: 'rgba(224,118,31,0.22)',
        black: '#3b4254', red: '#d64550', green: '#2f9e57', yellow: '#a67609',
        blue: '#3067d4', magenta: '#7a5cd6', cyan: '#0e8796', white: '#828a9c',
        brightBlack: '#5c6478', brightRed: '#b32e39', brightGreen: '#1f7f42', brightYellow: '#8a6200',
        brightBlue: '#204fb0', brightMagenta: '#6244b8', brightCyan: '#0a6d7a', brightWhite: '#9aa1b2',
    };
    const fruitTheme = {
        background: '#fffaf0',
        foreground: '#563c1e',
        cursor: '#ec8a1f',
        cursorAccent: '#fffaf0',
        selectionBackground: 'rgba(236,138,31,0.2)',
        black: '#6d4a24', red: '#d05b33', green: '#679b3f', yellow: '#c08a1a',
        blue: '#d48b38', magenta: '#c9764f', cyan: '#52a08a', white: '#d3b48a',
        brightBlack: '#97724a', brightRed: '#e97f56', brightGreen: '#82b85c', brightYellow: '#dca63f',
        brightBlue: '#eba861', brightMagenta: '#e29674', brightCyan: '#75bda6', brightWhite: '#f7ecd9',
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
        icon.innerHTML = ICONS.folder;

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
        remove.innerHTML = ICONS.close;

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
        <button class="toolbar-btn" data-action="copy" title="复制选中内容">${ICONS.copy}<span class="toolbar-label">复制</span></button>
        <button class="toolbar-btn" data-action="paste" title="粘贴">${ICONS.paste}<span class="toolbar-label">粘贴</span></button>
        <button class="toolbar-btn" data-action="refresh" title="重绘 TUI（修复窗口缩放后当前界面的排版错位，不清空历史）">${ICONS.refresh}<span class="toolbar-label">刷新</span></button>
    `;
    wrapper.appendChild(toolbar);

    /** 短暂切换按钮文案并点亮成功态。 */
    const flashLabel = (/** @type {HTMLElement} */ btn, /** @type {string} */ text, /** @type {string} */ revert) => {
        const label = btn.querySelector('.toolbar-label');
        if (!label) return;
        label.textContent = text;
        btn.classList.add('ok');
        setTimeout(() => { label.textContent = revert; btn.classList.remove('ok'); }, 1000);
    };

    toolbar.addEventListener('click', async (e) => {
        const btn = /** @type {HTMLElement} */ (e.target)?.closest('[data-action]');
        if (!btn) return;
        const action = btn.getAttribute('data-action');
        if (action === 'copy') {
            const sel = terminal.getSelection();
            if (sel) {
                await navigator.clipboard.writeText(sel);
                terminal.clearSelection();
                flashLabel(/** @type {HTMLElement} */(btn), '已复制', '复制');
            }
        } else if (action === 'paste') {
            await pasteFromClipboard(sessionId);
            terminal.focus();
        } else if (action === 'refresh') {
            refreshTerminal(tabState);
            flashLabel(/** @type {HTMLElement} */(btn), '已刷新', '刷新');
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
    ${toolGlyphHTML(toolId, toolIcon)}
    <span class="tab-label">${esc(toolName)}</span>
    <span class="tab-close" title="关闭">${ICONS.close}</span>
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

    const closeModal = () => {
        settingsModal.classList.add('hidden');
        // Stop the pairing-code countdown; it only exists while the panel is up.
        if (pairCodeTimer) { clearInterval(pairCodeTimer); pairCodeTimer = null; }
    };

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

        closeModal();
    });

    // A remote browser can't administer the bridge (every web:* channel is
    // local-only), so the settings panel only offers it a way to unpair itself.
    $('#btn-web-unpair')?.addEventListener('click', () => {
        /** @type {any} */ (api).session?.logout?.();
    });
}

// ===== Remote access panel (host side) =====
// Every web:* channel is local-only in the main process, so this whole section
// is inert in a remote browser (api.web is undefined there).

/** Last status payload, so list actions can re-render without a round trip. */
let webStatus = /** @type {any} */ (null);
let pairCodeTimer = /** @type {any} */ (null);

/** Audit kinds worth pulling the user's attention to via the sidebar dot. */
const NOTABLE_AUDIT = new Set([
    'pair-fail', 'reject-insecure', 'reject-origin', 'reject-host',
    'reject-prefix', 'reject-auth', 'rate-limit', 'lockdown', 'port-fallback',
]);

function setupRemotePanel() {
    if (!api.web) return; // remote browser — nothing here is reachable

    const modal = $('#remote-modal');

    // Listeners are registered at startup, not on panel open: an approval
    // prompt has to appear even when the panel was never opened.
    api.web.onAccessRequest?.((/** @type {any} */ request) => {
        showAccessRequest(request);
        if (modal && !modal.classList.contains('hidden')) void refreshRemoteRequests();
    });
    api.web.onClientsChanged?.((/** @type {any[]} */ clients) => {
        if (webStatus) webStatus.clients = clients;
        renderRemoteBadge(clients);
        renderRemotePeers();
        renderRemoteStats();
    });
    api.web.onAudit?.((/** @type {any} */ entry) => {
        if (NOTABLE_AUDIT.has(entry?.kind)) $('#remote-dot')?.classList.remove('hidden');
        // A port conflict silently changes the access URLs, so say so even when
        // the panel isn't open.
        if (entry?.kind === 'port-fallback') {
            showToast(entry.detail || '监听端口已自动调整', 'info', 6000);
            void refreshRemoteStatus();
        }
        if (modal && !modal.classList.contains('hidden')) void refreshRemoteAudit();
    });
    api.web.onLockdown?.((/** @type {any} */ state) => {
        renderRemoteLockdown(state);
        showToast('检测到大量失败尝试，已暂停接受新设备', 'error', 6000);
    });

    $('#btn-remote-access')?.addEventListener('click', () => void openRemotePanel());
    $('#btn-close-remote')?.addEventListener('click', closeRemotePanel);
    modal?.querySelector('.modal-overlay')?.addEventListener('click', closeRemotePanel);

    // Prime the status once at startup so the sidebar badge (and the panel's
    // first paint) reflect connections that existed before this window loaded.
    void refreshRemoteStatus();

    $('#btn-web-approve')?.addEventListener('click', () => void resolveAccessRequest(true));
    $('#btn-web-deny')?.addEventListener('click', () => void resolveAccessRequest(false));

    // Switches and text fields apply immediately so the URLs, warnings and
    // service state always reflect what is actually running.
    //
    // Turning the service ON first walks through trusting the local root
    // certificate: if the first browser visit happens before trust is in
    // place, the browser caches an "insecure" verdict — the exact thing the
    // certificate model is meant to prevent. (The main process enforces the
    // same rule; this flow just makes it a one-click path.)
    $('#remote-enabled')?.addEventListener('change', async (ev) => {
        const el = /** @type {HTMLInputElement} */ (ev.currentTarget);
        if (el.checked) {
            el.disabled = true;
            try {
                const ready = await ensureCaTrustBeforeEnable();
                if (!ready) {
                    el.checked = false;
                    // 证书可能已签发：刷新一次，让证书区显示指纹与信任状态。
                    void refreshRemoteStatus();
                    return;
                }
            } finally {
                el.disabled = false;
            }
        }
        void applyRemoteSettings();
    });
    $('#remote-port')?.addEventListener('change', () => { void applyRemoteSettings(); });
    $('#remote-hosts')?.addEventListener('change', () => { void applyRemoteSettings(); });
    $('#remote-networks')?.addEventListener('change', () => { void applyRemoteSettings(); });

    $('#remote-https')?.addEventListener('change', async (ev) => {
        const el = /** @type {HTMLInputElement} */ (ev.currentTarget);
        if (!el.checked && !window.confirm(
            '关闭内置 HTTPS 后，除本机外的设备将无法接入——未加密的连接会被一律拒绝。\n\n'
            + '只有当你把接入流量交给已启用 TLS 的隧道，或登记了网络层已加密的受信任网段时，才需要关闭它。\n\n确定关闭？'
        )) {
            el.checked = true;
            return;
        }
        // 服务运行中把 HTTPS 重新打开：同样先完成根证书信任，避免浏览器
        // 先一步缓存“不安全”。取消则恢复原状（保持关闭）。
        if (el.checked && /** @type {HTMLInputElement} */ ($('#remote-enabled'))?.checked) {
            el.disabled = true;
            try {
                const ready = await ensureCaTrustBeforeEnable();
                if (!ready) {
                    el.checked = false;
                    void refreshRemoteStatus();
                    return;
                }
            } finally {
                el.disabled = false;
            }
        }
        void applyRemoteSettings();
    });

    $('#btn-remote-copy-cert')?.addEventListener('click', async () => {
        const value = webStatus?.certFingerprint;
        if (value) await copyText(value, '证书指纹已复制');
    });

    $('#btn-remote-regen-cert')?.addEventListener('click', async () => {
        if (!window.confirm(
            '重新签发服务证书？根证书保持不变：\n'
            + '已安装根证书的设备不受影响；仅手动“忽略过警告”的设备会再提示一次。'
        )) return;
        renderRemoteStatus(await api.web.regenerateCert());
        showToast('服务证书已重新签发', 'success');
    });

    $('#btn-remote-trust-ca')?.addEventListener('click', async () => {
        const btn = /** @type {HTMLButtonElement} */ ($('#btn-remote-trust-ca'));
        if (btn) btn.disabled = true;
        try {
            const res = await api.web.trustCert();
            if (res?.status) renderRemoteStatus(res.status);
            else await refreshRemoteStatus();
            if (res?.ok) {
                showToast('根证书已加入系统信任，刷新浏览器页面即可看到安全锁', 'success', 6000);
            } else {
                showToast(res?.message || '未完成信任（可能已取消）', 'error', 5000);
            }
        } catch {
            showToast('信任根证书失败', 'error');
            if (btn) btn.disabled = false;
        }
    });

    $('#btn-remote-export-ca')?.addEventListener('click', async () => {
        try {
            const res = await api.web.exportCa();
            if (res?.ok) showToast(`根证书已导出：${res.path}`, 'success', 6000);
            else if (!res?.canceled) showToast(res?.message || '导出失败', 'error');
        } catch {
            showToast('导出失败', 'error');
        }
    });

    $('#remote-approval')?.addEventListener('change', (ev) => {
        const el = /** @type {HTMLInputElement} */ (ev.currentTarget);
        if (!el.checked && !window.confirm(
            '关闭后，任何持有访问令牌的人都能直接接入，无需你在本机确认。\n'
            + '令牌一旦泄露便再无第二道防线。\n\n确定关闭？'
        )) {
            el.checked = true;
            return;
        }
        void applyRemoteSettings();
    });

    document.querySelectorAll('[data-preset-network]').forEach((btn) => {
        btn.addEventListener('click', () => {
            const cidr = btn.getAttribute('data-preset-network') || '';
            const input = /** @type {HTMLInputElement} */ ($('#remote-networks'));
            if (!input || !cidr) return;
            const current = input.value.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
            if (current.includes(cidr)) return;
            input.value = [...current, cidr].join(', ');
            void applyRemoteSettings();
        });
    });

    $('#btn-remote-gen-code')?.addEventListener('click', async () => {
        try {
            renderRemotePairingCode(await api.web.createPairingCode());
            showToast('配对码已生成，5 分钟内有效', 'success');
        } catch {
            showToast('生成配对码失败', 'error');
        }
    });

    // URL rows are rebuilt on every render; delegate the per-row buttons.
    $('#remote-urls')?.addEventListener('click', async (ev) => {
        const target = /** @type {HTMLElement} */ (ev.target);
        const open = target.closest('[data-open-url]');
        if (open) {
            // 桌面端由 setWindowOpenHandler 转交系统默认浏览器打开。
            window.open(open.getAttribute('data-open-url') || '');
            return;
        }
        const btn = target.closest('[data-copy-url]');
        if (!btn) return;
        await copyText(btn.getAttribute('data-copy-url') || '', '入口地址已复制');
    });

    $('#btn-remote-copy-token')?.addEventListener('click', async () => {
        const value = /** @type {HTMLInputElement} */ ($('#remote-token'))?.value || '';
        if (value) await copyText(value, '访问令牌已复制');
    });

    $('#btn-remote-rotate-token')?.addEventListener('click', async () => {
        if (!window.confirm('重新生成访问令牌？旧令牌立即失效，已配对的设备不受影响。')) return;
        await api.web.rotateToken();
        await refreshRemoteStatus();
        showToast('访问令牌已更新', 'success');
    });

    $('#btn-remote-rotate-prefix')?.addEventListener('click', async () => {
        if (!window.confirm('更换入口路径？旧地址立即失效，所有远程设备都要用新地址重新打开页面。')) return;
        renderRemoteStatus(await api.web.rotatePathPrefix());
        showToast('入口路径已更换', 'success');
    });

    $('#btn-remote-revoke-all')?.addEventListener('click', async () => {
        if (!window.confirm('撤销所有已配对设备？它们会立即断开，需重新配对。')) return;
        await api.web.revokeAllDevices();
        await refreshRemoteStatus();
        showToast('已撤销所有设备', 'success');
    });

    $('#btn-remote-kick-all')?.addEventListener('click', async () => {
        const count = await api.web.disconnectAll();
        await refreshRemoteStatus();
        showToast(count ? `已断开 ${count} 个连接` : '当前没有连接', 'info');
    });

    $('#btn-remote-unlock')?.addEventListener('click', async () => {
        await api.web.clearLockdown();
        await refreshRemoteStatus();
        showToast('已解除，恢复接受新设备', 'success');
    });

    $('#btn-remote-clear-audit')?.addEventListener('click', async () => {
        if (!window.confirm('清空活动记录？')) return;
        await api.web.clearAudit();
        await refreshRemoteAudit();
    });

    // Rows are rebuilt on every render, so bind once on the container.
    $('#remote-devices')?.addEventListener('click', async (ev) => {
        const target = /** @type {HTMLElement} */ (ev.target);

        const revoke = target.closest('[data-revoke-device]');
        if (revoke) {
            if (!window.confirm('撤销该设备？它会立即断开，需重新配对才能接入。')) return;
            await api.web.revokeDevice(revoke.getAttribute('data-revoke-device') || '');
            await refreshRemoteStatus();
            showToast('设备已撤销', 'success');
            return;
        }

        const rename = target.closest('[data-rename-device]');
        if (rename) {
            const id = rename.getAttribute('data-rename-device') || '';
            const current = rename.getAttribute('data-current-name') || '';
            const name = window.prompt('设备名称', current);
            if (name == null || !name.trim() || name.trim() === current) return;
            await api.web.renameDevice(id, name.trim());
            await refreshRemoteStatus();
            return;
        }

        // 断开某台设备的所有连接（一台设备可能开着多个页面）。
        const kickDevice = target.closest('[data-kick-device]');
        if (kickDevice) {
            const id = kickDevice.getAttribute('data-kick-device') || '';
            const conns = (webStatus?.clients || []).filter((/** @type {any} */ c) => c.deviceId === id);
            for (const conn of conns) await api.web.disconnectClient(conn.id);
            await refreshRemoteStatus();
            showToast('已断开该设备', 'info');
            return;
        }

        const kickClient = target.closest('[data-kick-client]');
        if (kickClient) {
            await api.web.disconnectClient(kickClient.getAttribute('data-kick-client') || '');
            await refreshRemoteStatus();
            showToast('已断开该连接', 'info');
        }
    });

    // Pending access requests surfaced inside the panel (in case the approval
    // modal was missed or dismissed).
    $('#remote-requests')?.addEventListener('click', async (ev) => {
        const target = /** @type {HTMLElement} */ (ev.target);
        const approve = target.closest('[data-approve-request]');
        const deny = target.closest('[data-deny-request]');
        const btn = approve || deny;
        if (!btn) return;
        const id = btn.getAttribute(approve ? 'data-approve-request' : 'data-deny-request') || '';
        try {
            await api.web.resolveRequest(id, !!approve);
            showToast(approve ? '已允许该设备接入' : '已拒绝该设备', approve ? 'success' : 'info');
        } catch { /* request may have expired */ }
        closeAccessRequest();
        await refreshRemoteRequests();
        await refreshRemoteStatus();
    });
}

async function copyText(/** @type {string} */ value, /** @type {string} */ okMessage) {
    try {
        await navigator.clipboard.writeText(value);
        showToast(okMessage, 'success');
    } catch {
        showToast('复制失败', 'error');
    }
}

/**
 * 开启服务前的信任闸门：内置 HTTPS + 支持一键信任的系统上，根证书必须先受信任。
 * 返回 true 表示可以继续开启。
 */
async function ensureCaTrustBeforeEnable() {
    if (!api.web) return false;
    // 明文/隧道模式与证书无关，直接放行。
    const httpsOn = /** @type {HTMLInputElement} */ ($('#remote-https'))?.checked !== false;
    if (!httpsOn) return true;

    const status = webStatus || await api.web.getStatus().catch(() => null);
    if (!status) return true;
    if (status.caTrustSupported === false) return true;
    if (status.caTrusted === true) return true;

    if (!window.confirm(
        '开启远程访问前，需要先把本机根证书加入系统信任。\n\n'
        + '这样浏览器第一次打开就会显示为安全连接，不会缓存“不安全”警告。\n'
        + '点击「确定」后，请在系统弹出的安全警告对话框中选择「是」。'
    )) {
        showToast('已取消开启：请先完成根证书信任', 'info');
        return false;
    }

    try {
        // 注意：这里不能用返回的 status 全量重绘面板——此刻服务尚未开启，
        // 重绘会把用户刚拨上的开关拨回去；成功后紧随的 apply 会刷新一切。
        const res = await api.web.trustCert();
        if (res?.ok) {
            showToast('根证书已加入系统信任，正在开启远程访问…', 'success');
            return true;
        }
        showToast(res?.message || '未完成信任，远程访问保持关闭', 'error', 5000);
        return false;
    } catch {
        showToast('信任根证书失败，远程访问保持关闭', 'error');
        return false;
    }
}

async function openRemotePanel() {
    $('#remote-dot')?.classList.add('hidden');
    $('#remote-modal')?.classList.remove('hidden');
    await refreshRemoteStatus();
    await refreshRemoteRequests();
    await refreshRemoteAudit();
}

function closeRemotePanel() {
    $('#remote-modal')?.classList.add('hidden');
    // The pairing countdown only needs to tick while the panel is visible.
    if (pairCodeTimer) { clearInterval(pairCodeTimer); pairCodeTimer = null; }
}

/** Pull a fresh status payload and repaint the whole panel. */
async function refreshRemoteStatus() {
    if (!api.web) return;
    try {
        renderRemoteStatus(await api.web.getStatus());
    } catch (err) {
        console.error('[refreshRemoteStatus] failed:', err);
    }
}

/** Read the panel inputs, apply them in the main process, repaint. */
async function applyRemoteSettings() {
    if (!api.web) return;
    const splitList = (/** @type {string} */ sel) =>
        (/** @type {HTMLInputElement} */ ($(sel))?.value || '')
            .split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);

    const cfg = {
        enabled: /** @type {HTMLInputElement} */ ($('#remote-enabled'))?.checked || false,
        port: parseInt(/** @type {HTMLInputElement} */($('#remote-port'))?.value || '4178', 10) || 4178,
        allowedHosts: splitList('#remote-hosts'),
        requireApproval: /** @type {HTMLInputElement} */ ($('#remote-approval'))?.checked !== false,
        https: /** @type {HTMLInputElement} */ ($('#remote-https'))?.checked || false,
        trustedNetworks: splitList('#remote-networks'),
    };
    try {
        const status = await api.web.apply(cfg);
        renderRemoteStatus(status);
        // 主进程的信任闸门兜底：未信任根证书时拒绝开启。
        if (status?.trustRequired) {
            showToast('需要先信任根证书，远程访问未开启', 'error', 5000);
        }
    } catch (err) {
        console.error('[applyRemoteSettings] failed:', err);
        showToast('应用远程访问设置失败', 'error');
    }
}

function renderRemoteStatus(/** @type {any} */ status) {
    if (!status) return;
    webStatus = status;

    const setChecked = (/** @type {string} */ sel, /** @type {boolean} */ value) => {
        const el = /** @type {HTMLInputElement} */ ($(sel));
        if (el) el.checked = value;
    };
    // Skip fields the user is mid-edit in, so a repaint can't eat keystrokes.
    const setValue = (/** @type {string} */ sel, /** @type {string} */ value) => {
        const el = /** @type {HTMLInputElement} */ ($(sel));
        if (el && document.activeElement !== el) el.value = value;
    };

    setChecked('#remote-enabled', !!status.enabled);
    setChecked('#remote-approval', status.requireApproval !== false);
    setChecked('#remote-https', status.https !== false);
    setValue('#remote-port', String(status.port || 4178));
    setValue('#remote-hosts', (status.allowedHosts || []).join(', '));
    setValue('#remote-networks', (status.trustedNetworks || []).join(', '));

    const token = /** @type {HTMLInputElement} */ ($('#remote-token'));
    if (token) token.value = status.token || '';

    renderRemoteCert(status);

    const chip = $('#remote-state-chip');
    if (chip) {
        const running = !!status.running;
        chip.textContent = running
            ? (status.clients?.length ? `运行中 · ${status.clients.length} 个连接` : '运行中')
            : (status.enabled ? '启动失败' : '未启用');
        chip.className = `remote-chip ${running ? 'remote-chip-on' : status.enabled ? 'remote-chip-err' : ''}`;
    }

    // 服务说明只在关闭时出现；开启后让位给状态速览。
    $('#remote-intro')?.classList.toggle('hidden', !!status.enabled);

    renderRemoteBadge(status.clients || []);
    renderRemoteStats();
    renderRemoteUrls(status);
    renderRemoteWarning(status);
    renderRemoteLockdown(status.lockdown);
    renderRemoteLockouts(status.lockouts || []);
    renderRemotePairingCode(status.pairingCode);
    renderRemotePeers();
}

/** 状态速览：端口 / 加密 / 设备数 / 在线数。 */
function renderRemoteStats() {
    const status = webStatus;
    if (!status) return;
    const set = (/** @type {string} */ sel, /** @type {string} */ text, /** @type {string} */ tone = '') => {
        const el = $(sel);
        if (!el) return;
        el.textContent = text;
        el.className = `remote-stat-value${tone ? ` ${tone}` : ''}`;
    };

    set('#stat-port', String(status.port || '—'));
    if (status.https) {
        set('#stat-tls', 'HTTPS');
    } else {
        // 明文本身是需要注意的状态（除非流量走已加密的隧道/专网）。
        set('#stat-tls', '明文', 'stat-warn');
    }
    const devices = status.devices || [];
    const clients = status.clients || [];
    set('#stat-devices', String(devices.length));
    set('#stat-clients', String(clients.length), clients.length ? 'stat-ok' : '');
}

/** 从访问地址推导根证书下载地址（优先局域网地址，手机扫码/输入用）。 */
function caDownloadUrl(/** @type {any} */ status) {
    const urls = status?.urls || [];
    if (!status?.running || !urls.length) return '';
    const lan = urls.find((/** @type {string} */ u) => urlScope(u).label === '局域网');
    const base = lan || urls[0];
    return base.endsWith('/') ? `${base}api/ca` : `${base}/api/ca`;
}

function renderRemoteCert(/** @type {any} */ status) {
    const field = $('#remote-cert-field');
    const box = $('#remote-cert');
    if (!field || !box) return;
    field.classList.toggle('hidden', !status.https);
    if (!status.https) return;

    const trustBtn = /** @type {HTMLButtonElement} */ ($('#btn-remote-trust-ca'));
    const exportBtn = $('#btn-remote-export-ca');
    if (!status.certFingerprint) {
        box.textContent = '开启服务时自动签发证书，并引导完成根证书信任';
        trustBtn?.classList.add('hidden');
        exportBtn?.classList.add('hidden');
        return;
    }

    const lines = [];
    if (status.caTrusted === true) {
        lines.push('根证书状态：已加入系统信任 ✓（本机浏览器显示为安全连接）');
    } else if (status.caTrusted === false) {
        lines.push('根证书状态：未信任 —— 点击下方「信任根证书」，浏览器即不再提示“不安全”');
    } else if (status.caTrustSupported === false) {
        lines.push('根证书状态：此系统需手动安装 —— 用「导出根证书」后导入系统信任');
    } else {
        lines.push('根证书状态：未知');
    }
    if (status.caFingerprint) {
        lines.push(`根证书指纹：${status.caFingerprint}`);
    }
    lines.push(`服务证书指纹：${status.certFingerprint}`);
    lines.push(`有效期至 ${new Date(status.certExpiresAt).toLocaleDateString()}（到期自动续签，根证书不变）`);
    const dl = caDownloadUrl(status);
    if (dl) lines.push(`其他设备安装根证书：${dl}`);
    box.textContent = lines.join('\n');

    if (trustBtn) {
        trustBtn.classList.toggle('hidden', status.caTrustSupported === false);
        trustBtn.disabled = status.caTrusted === true;
        trustBtn.textContent = status.caTrusted === true ? '已信任（本机）' : '信任根证书（本机）';
    }
    exportBtn?.classList.remove('hidden');
}

/** 每条地址标注作用域（本机 / 局域网 / 域名），并提供行内复制。 */
function urlScope(/** @type {string} */ url) {
    try {
        const host = new URL(url).hostname;
        if (host === '127.0.0.1' || host === 'localhost' || host === '[::1]') {
            return { label: '本机', cls: '' };
        }
        if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.startsWith('[')) {
            return { label: '局域网', cls: 'url-tag-lan' };
        }
        return { label: '域名', cls: 'url-tag-host' };
    } catch {
        return { label: '地址', cls: '' };
    }
}

function renderRemoteUrls(/** @type {any} */ status) {
    const box = $('#remote-urls');
    if (!box) return;
    if (!status?.running || !status.urls?.length) {
        box.innerHTML = `<div class="url-empty">${status?.enabled
            ? '启动失败，请检查端口是否被占用'
            : '开启服务后生成访问地址'}</div>`;
        return;
    }
    box.innerHTML = status.urls.map((/** @type {string} */ u) => {
        const scope = urlScope(u);
        return `
        <div class="url-row">
          <span class="url-tag ${scope.cls}">${scope.label}</span>
          <span class="url-text">${esc(u)}</span>
          <button class="btn-input-action url-copy" data-copy-url="${esc(u)}" title="复制">${ICONS.copy}</button>
          <button class="btn-input-action url-open" data-open-url="${esc(u)}" title="在浏览器中打开">${ICONS.external}</button>
        </div>`;
    }).join('');
}

/** Surface the risks the current configuration carries, in plain language. */
function renderRemoteWarning(/** @type {any} */ status) {
    const box = $('#remote-warning');
    if (!box) return;
    const notes = [];
    if (status.requireApproval === false) {
        notes.push('已关闭「新设备需本机批准」：任何持有访问令牌的人都能直接接入，令牌泄露即失守。');
    }
    if (status.running && status.https === false
        && !(status.trustedNetworks || []).length && !(status.allowedHosts || []).length) {
        notes.push('内置 HTTPS 已关闭，且没有配置隧道域名或受信任网段——目前只有本机能接入，其他设备的连接都会被拒。');
    }
    if ((status.trustedNetworks || []).length) {
        notes.push('受信任网段会跳过加密检查。请确认这些网段确实在网络层加密（Tailscale、WireGuard 等），普通局域网不满足这个条件。');
    }
    if (!notes.length) {
        box.classList.add('hidden');
        box.innerHTML = '';
        return;
    }
    box.classList.remove('hidden');
    box.innerHTML = notes.map((n) => `<div>${esc(n)}</div>`).join('');
}

function renderRemoteLockdown(/** @type {any} */ state) {
    const banner = $('#remote-lockdown');
    const text = $('#remote-lockdown-text');
    if (!banner || !text) return;
    if (!state?.active) {
        banner.classList.add('hidden');
        return;
    }
    const until = new Date(state.until).toLocaleTimeString();
    text.textContent = `检测到 ${state.failures} 次失败尝试，已暂停接受新设备（至 ${until}）。已配对的设备不受影响。`;
    banner.classList.remove('hidden');
}

/** Pairing codes live for 5 minutes; the countdown bar drains against this. */
const PAIR_CODE_TTL_S = 5 * 60;

function renderRemotePairingCode(/** @type {any} */ code) {
    const box = $('#remote-code');
    const bar = /** @type {HTMLElement} */ ($('#remote-code-bar'));
    const left = $('#remote-code-left');
    const genBtn = $('#btn-remote-gen-code');
    if (!box) return;
    if (pairCodeTimer) { clearInterval(pairCodeTimer); pairCodeTimer = null; }

    const reset = (/** @type {string} */ text, /** @type {string} */ hint) => {
        box.textContent = text;
        box.classList.remove('pair-code-active');
        if (bar) bar.style.width = '0';
        if (left) left.textContent = hint;
        if (genBtn) genBtn.textContent = '生成配对码';
    };

    if (!code?.code) {
        reset('·· ··', '尚未生成配对码');
        return;
    }

    // 8 位数字分两组显示，隔屏读码不串位。
    box.textContent = `${code.code.slice(0, 4)} ${code.code.slice(4)}`;
    if (genBtn) genBtn.textContent = '重新生成';

    const tick = () => {
        const secs = Math.round((code.expiresAt - Date.now()) / 1000);
        if (secs <= 0) {
            clearInterval(pairCodeTimer);
            pairCodeTimer = null;
            reset('·· ··', '配对码已过期，可重新生成');
            return;
        }
        box.classList.add('pair-code-active');
        if (bar) bar.style.width = `${Math.min(100, (secs / PAIR_CODE_TTL_S) * 100)}%`;
        if (left) {
            const m = Math.floor(secs / 60);
            const s = secs % 60;
            left.textContent = `${m}:${String(s).padStart(2, '0')} 后过期 · 仅可使用一次`;
        }
    };
    tick();
    pairCodeTimer = setInterval(tick, 1000);
}

/** 侧栏「远程访问」按钮上的在线连接数徽章；无连接时自动隐藏。 */
function renderRemoteBadge(/** @type {any[]} */ clients) {
    const badge = document.getElementById('remote-badge');
    if (!badge) return;
    const n = (clients || []).length;
    badge.textContent = n ? `${n} 在线` : '';
    badge.className = n ? 'tool-badge running' : 'tool-badge';
    badge.title = n ? `${n} 个在线连接` : '';
}

/** 手机还是电脑？决定设备行的图标。 */
function deviceGlyph(/** @type {string} */ userAgent) {
    return /Android|iPhone|iPad|iPod|Mobile/i.test(userAgent || '') ? ICONS.phone : ICONS.monitor;
}

/** 连接时长，用于在线设备的元信息。 */
function formatDuration(/** @type {number} */ since) {
    const secs = Math.max(0, Math.round((Date.now() - since) / 1000));
    if (secs < 60) return `${secs} 秒`;
    const mins = Math.floor(secs / 60);
    if (mins < 60) return `${mins} 分钟`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours} 小时 ${mins % 60} 分`;
    return `${Math.floor(hours / 24)} 天`;
}

/**
 * 设备卡：配对记录与在线连接合并成一份名单。
 * 每台已配对设备标注在线状态；未落配对记录的连接（如 CLI）单独列出。
 */
function renderRemotePeers() {
    const box = $('#remote-devices');
    if (!box) return;
    const devices = /** @type {any[]} */ (webStatus?.devices || []);
    const clients = /** @type {any[]} */ (webStatus?.clients || []);

    const countChip = $('#remote-peers-count');
    if (countChip) {
        const online = clients.length;
        countChip.textContent = (devices.length || online)
            ? `${devices.length} 台 · ${online} 在线`
            : '';
    }

    const rows = [];

    for (const d of devices) {
        const conns = clients.filter((c) => c.deviceId === d.id);
        const online = conns.length > 0;
        const meta = online
            ? `${d.ip} · 在线 ${formatDuration(conns[0].connectedAt)}${conns.length > 1 ? ` · ${conns.length} 个连接` : ''}`
            : `${d.ip} · 最近活跃 ${formatAgo(d.lastSeenAt)}`;
        rows.push(`
        <div class="peer-row${online ? ' online' : ''}">
          <span class="peer-dot" title="${online ? '在线' : '离线'}"></span>
          <span class="peer-ico">${deviceGlyph(d.userAgent)}</span>
          <div class="peer-main">
            <span class="peer-name">
              <span class="peer-name-text">${esc(d.name)}</span>
              <button class="peer-rename" data-rename-device="${esc(d.id)}" data-current-name="${esc(d.name)}"
                title="重命名">${ICONS.pencil}</button>
            </span>
            <span class="peer-meta">${esc(meta)}</span>
          </div>
          <div class="peer-actions">
            ${online ? `<button class="btn-link" data-kick-device="${esc(d.id)}">断开</button>` : ''}
            <button class="btn-link-danger" data-revoke-device="${esc(d.id)}">撤销</button>
          </div>
        </div>`);
    }

    // 无设备记录的连接（关闭批准后的 CLI 直连等）。
    for (const c of clients.filter((c) => !c.deviceId)) {
        rows.push(`
        <div class="peer-row online">
          <span class="peer-dot" title="在线"></span>
          <span class="peer-ico">${ICONS.terminal}</span>
          <div class="peer-main">
            <span class="peer-name"><span class="peer-name-text">${esc(c.deviceName || '临时连接')}</span></span>
            <span class="peer-meta">${esc(`${c.ip} · 在线 ${formatDuration(c.connectedAt)} · 未配对`)}</span>
          </div>
          <div class="peer-actions">
            <button class="btn-link" data-kick-client="${esc(c.id)}">断开</button>
          </div>
        </div>`);
    }

    box.innerHTML = rows.length
        ? rows.join('')
        : '<div class="peer-empty">尚无配对设备 — 在上方生成配对码即可接入</div>';
}

// ===== Pending access requests (inside the panel) =====

async function refreshRemoteRequests() {
    if (!api.web?.listRequests) return;
    try {
        renderRemoteRequests(await api.web.listRequests());
    } catch { /* bridge may be off */ }
}

function renderRemoteRequests(/** @type {any[]} */ requests) {
    const box = $('#remote-requests');
    if (!box) return;
    const pending = (requests || []).filter((r) => r.status === 'pending');
    if (!pending.length) {
        box.classList.add('hidden');
        box.innerHTML = '';
        return;
    }
    box.classList.remove('hidden');
    box.innerHTML = pending.map((r) => `
        <div class="req-row">
          <span class="req-ico">${deviceGlyph(r.userAgent)}</span>
          <div class="req-main">
            <span class="req-name">${esc(r.name)} 请求接入</span>
            <span class="req-meta">${esc(r.ip)} · 凭访问令牌 · ${Math.max(0, Math.round((r.expiresAt - Date.now()) / 1000))}s 后自动拒绝</span>
          </div>
          <button class="btn-secondary btn-sm" data-deny-request="${esc(r.id)}">拒绝</button>
          <button class="btn-primary btn-sm" data-approve-request="${esc(r.id)}">允许</button>
        </div>`).join('');
}

/** 被限速的来源 IP（仅在有记录时出现在安全防线卡内）。 */
function renderRemoteLockouts(/** @type {any[]} */ lockouts) {
    const box = $('#remote-lockouts');
    if (!box) return;
    if (!lockouts?.length) {
        box.classList.add('hidden');
        box.innerHTML = '';
        return;
    }
    box.classList.remove('hidden');
    box.innerHTML = '<label>限速中的来源</label>' + lockouts.map((l) =>
        `<div class="lockout-row">${esc(l.ip)} · 失败 ${esc(String(l.failures))} 次 · ${Math.ceil(l.remainingMs / 1000)}s 后解除</div>`
    ).join('');
}

/** Human-readable label and severity class for each audit event kind. */
const AUDIT_LABELS = {
    'bridge-start': ['服务已启动', ''],
    'bridge-stop': ['服务已停止', ''],
    'port-fallback': ['端口冲突', 'warn'],
    'connect': ['设备接入', 'ok'],
    'disconnect': ['设备断开', ''],
    'pair-ok': ['配对成功', 'ok'],
    'pair-fail': ['配对码错误', 'warn'],
    'token-request': ['收到接入请求', 'warn'],
    'approve': ['已允许接入', 'ok'],
    'deny': ['已拒绝接入', ''],
    'revoke': ['撤销设备', ''],
    'kick': ['断开连接', ''],
    'token-rotate': ['更换访问令牌', ''],
    'prefix-rotate': ['更换入口路径', ''],
    'cert-regenerate': ['重新签发证书', ''],
    'reject-insecure': ['拒绝明文连接', 'warn'],
    'reject-origin': ['拒绝跨站连接', 'warn'],
    'reject-host': ['拒绝未知域名', 'warn'],
    'reject-prefix': ['探测未知路径', 'warn'],
    'reject-auth': ['凭证校验失败', 'warn'],
    'rate-limit': ['触发限速', 'warn'],
    'lockdown': ['暂停接受新设备', 'danger'],
    'lockdown-clear': ['解除暂停', 'ok'],
};

async function refreshRemoteAudit() {
    if (!api.web?.listAudit) return;
    try {
        renderRemoteAudit(await api.web.listAudit(200));
    } catch (err) {
        console.error('[refreshRemoteAudit] failed:', err);
    }
}

function renderRemoteAudit(/** @type {any[]} */ events) {
    const box = $('#remote-audit');
    if (!box) return;
    const countChip = $('#remote-audit-count');
    if (countChip) countChip.textContent = events?.length ? `${events.length} 条` : '';
    if (!events?.length) {
        box.textContent = '暂无记录';
        return;
    }
    box.innerHTML = events.map((e) => {
        const [label, level] = AUDIT_LABELS[e.kind] || [e.kind, ''];
        const parts = [e.device, e.ip, e.detail].filter(Boolean).map(esc).join(' · ');
        return `
        <div class="audit-row">
          <span class="audit-time">${esc(formatClock(e.at))}</span>
          <span class="audit-label ${level ? `audit-${level}` : ''}">${esc(label)}</span>
          <span class="audit-detail">${parts}</span>
        </div>`;
    }).join('');
}

/** Date-stamped only when it isn't today, to keep the log column narrow. */
function formatClock(/** @type {number} */ ts) {
    const date = new Date(ts);
    const time = date.toLocaleTimeString('zh-CN', { hour12: false });
    const today = new Date();
    const sameDay = date.toDateString() === today.toDateString();
    return sameDay ? time : `${date.getMonth() + 1}/${date.getDate()} ${time}`;
}

/** Coarse relative time — exact timestamps add noise in these lists. */
function formatAgo(/** @type {number} */ ts) {
    if (!ts) return '未知';
    const secs = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (secs < 60) return `${secs} 秒前`;
    const mins = Math.round(secs / 60);
    if (mins < 60) return `${mins} 分钟前`;
    const hours = Math.round(mins / 60);
    if (hours < 24) return `${hours} 小时前`;
    return `${Math.round(hours / 24)} 天前`;
}

// ===== Device approval prompt =====

let accessRequest = /** @type {any} */ (null);
let accessCountdownTimer = /** @type {any} */ (null);

function showAccessRequest(/** @type {any} */ request) {
    const modal = $('#web-access-modal');
    const info = $('#web-access-info');
    if (!modal || !info) return;

    accessRequest = request;
    info.innerHTML = `
        <div class="web-access-row"><span>设备</span><b>${esc(request.name)}</b></div>
        <div class="web-access-row"><span>来源 IP</span><b>${esc(request.ip)}</b></div>
        <div class="web-access-row"><span>User-Agent</span><b class="web-access-ua">${esc(request.userAgent)}</b></div>`;
    modal.classList.remove('hidden');

    // Default to deny: if nobody is at the machine the request just lapses.
    if (accessCountdownTimer) clearInterval(accessCountdownTimer);
    const countdown = $('#web-access-countdown');
    const tick = () => {
        const left = Math.round((request.expiresAt - Date.now()) / 1000);
        if (left <= 0) {
            clearInterval(accessCountdownTimer);
            accessCountdownTimer = null;
            closeAccessRequest();
            showToast('接入请求已超时，已自动拒绝', 'info');
            return;
        }
        if (countdown) countdown.textContent = `未操作将在 ${left} 秒后自动拒绝`;
    };
    tick();
    accessCountdownTimer = setInterval(tick, 1000);
}

function closeAccessRequest() {
    if (accessCountdownTimer) { clearInterval(accessCountdownTimer); accessCountdownTimer = null; }
    accessRequest = null;
    $('#web-access-modal')?.classList.add('hidden');
}

async function resolveAccessRequest(/** @type {boolean} */ approved) {
    const request = accessRequest;
    closeAccessRequest();
    if (!request) return;
    try {
        await api.web.resolveRequest(request.id, approved);
        showToast(approved ? `已允许 ${request.name} 接入` : '已拒绝该设备', approved ? 'success' : 'info');
        // 面板可能开着——同步请求条与设备列表。
        const panelOpen = !$('#remote-modal')?.classList.contains('hidden');
        if (panelOpen) await refreshRemoteRequests();
        if (approved || panelOpen) await refreshRemoteStatus();
    } catch (err) {
        console.error('[resolveAccessRequest] failed:', err);
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
        item.className = entry.isDirectory ? 'tree-item is-dir' : 'tree-item';
        item.innerHTML = `<span class="tree-chevron">${entry.isDirectory ? ICONS.chevron : ''}</span>`
            + `<span class="icon-slot">${entry.isDirectory ? ICONS.folder : ICONS.file}</span>`
            + `<span class="tree-name">${esc(entry.name)}</span>`;

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
                item.classList.toggle('open', !isOpen);
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
        let html = '<table class="config-diff">';
        html += '<tr><th>配置项</th><th>当前值</th><th></th><th>新值</th></tr>';
        for (const change of result.changes) {
            html += '<tr>';
            html += `<td class="config-diff-key">${esc(change.key)}</td>`;
            html += `<td class="config-diff-old">${esc(change.oldValue)}</td>`;
            html += `<td class="config-diff-arrow">→</td>`;
            html += `<td class="config-diff-new">${esc(change.newValue)}</td>`;
            html += '</tr>';
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
