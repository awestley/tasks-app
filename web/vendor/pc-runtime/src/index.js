// Personal Command runtime for apps. Load it in every pane:
//
//   import { connect } from '@awestley/pc-runtime';
//   import { applyTheme } from '@awestley/glassive';
//   const pc = connect({ app: 'tasks', applyTheme });
//   pc.registerCommands([{ id: 'new-task', label: 'New task' }]);
//   pc.on('command', ({ id }) => { ... });
//
// Hosted in the shell, it follows the shell's theme and can open things in other columns.
// On its own, isHosted() is false, open() navigates this window, and the theme follows the system.
import { PROTOCOL, TO_SHELL, TO_APP, PLACEMENTS, NOTICE_KINDS, SURFACES, message, readMessage } from './protocol.js';

export { PROTOCOL } from './protocol.js';
export { parseRef, formatRef, findShortRefs, shortRef } from './refs.js';

const DEFAULT_THEME = { mode: 'system', accent: 'blue', fontSize: 17 };

function fallbackApplyTheme(theme, root, win) {
  const dark = theme.mode === 'dark' || (theme.mode === 'system' && win.matchMedia?.('(prefers-color-scheme: dark)').matches);
  root.setAttribute('data-theme', dark ? 'dark' : 'light');
  root.style.setProperty('--color-accent', `var(--accent-${theme.accent})`);
  root.style.setProperty('--font-text-size', `${theme.fontSize}px`);
}

function sameOriginParent(win) {
  try {
    return win.parent && win.parent !== win && win.parent.location.origin === win.location.origin ? win.parent : null;
  } catch {
    return null; // a cross-origin parent throws: not our shell
  }
}

/**
 * Connect this page to the shell. Returns the same client for repeated calls in one window (React
 * StrictMode and hot reloads call it more than once), so the shell only ever sees one pane.
 */
export function connect(options = {}) {
  const win = options.win || globalThis.window;
  if (win.__pcRuntime) return win.__pcRuntime;
  const client = createClient({ ...options, win });
  Object.defineProperty(win, '__pcRuntime', { value: client, configurable: true });
  return client;
}

function createClient({ app, applyTheme, win }) {
  const parent = sameOriginParent(win);
  const listeners = new Map();
  let theme = { ...DEFAULT_THEME };
  let paneId = null;
  // Where this view is shown (docs/companion.md). A pane, or standalone, until the shell says otherwise.
  const windowSize = () => ({ width: win.innerWidth || 0, height: win.innerHeight || 0 });
  let surface = { kind: 'pane', ...windowSize() };
  const setSurface = (next) => {
    if (!next || !SURFACES.includes(next.kind)) return;
    surface = { kind: next.kind, ...windowSize(), ...(next.detent ? { detent: String(next.detent) } : {}) };
    emit('surface', { ...surface });
  };
  let resolveReady;
  const ready = new Promise((r) => { resolveReady = r; });

  const emit = (event, detail) => (listeners.get(event) || []).forEach((fn) => { try { fn(detail); } catch (e) { console.error(e); } });
  const apply = () => (applyTheme || fallbackApplyTheme)(theme, win.document.documentElement, win);
  const send = (type, fields) => parent?.postMessage(message(type, fields), win.location.origin);

  if (parent) {
    win.addEventListener('message', (event) => {
      if (event.source !== parent || event.origin !== win.location.origin) return;
      const msg = readMessage(event.data);
      if (!msg) return;
      if (msg.type === TO_APP.WELCOME) {
        paneId = msg.paneId ?? null;
        if (msg.theme) { theme = msg.theme; apply(); emit('theme', theme); }
        if (msg.surface) setSurface(msg.surface);
        resolveReady(true);
      } else if (msg.type === TO_APP.THEME && msg.theme) {
        theme = msg.theme; apply(); emit('theme', theme);
      } else if (msg.type === TO_APP.COMMAND && typeof msg.id === 'string') {
        emit('command', { id: msg.id });
      } else if (msg.type === TO_APP.SURFACE) {
        setSurface(msg.surface);
      }
    });
    send(TO_SHELL.HELLO, { app });
    // Shell shortcuts still work while focus is inside the pane.
    win.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && (e.key === 'k' || e.key === 'p')) {
        e.preventDefault();
        send(TO_SHELL.SHORTCUT, { key: 'palette' });
      } else if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'j') {
        e.preventDefault();
        send(TO_SHELL.SHORTCUT, { key: 'companion' });
      }
    });
    // A shell that never answers (an old version, or not ours) leaves the app standalone.
    setTimeout(() => resolveReady(false), 2000);
  } else {
    apply();
    const mq = win.matchMedia?.('(prefers-color-scheme: dark)');
    mq?.addEventListener?.('change', () => { if (theme.mode === 'system') apply(); });
    resolveReady(false);
  }
  // The size changes with the window; the kind only changes when the shell says so.
  win.addEventListener?.('resize', () => {
    const size = windowSize();
    if (size.width === surface.width && size.height === surface.height) return;
    surface = { ...surface, ...size };
    emit('surface', { ...surface });
  });

  return {
    PROTOCOL,
    ready,
    isHosted: () => Boolean(parent),
    paneId: () => paneId,
    theme: () => ({ ...theme }),
    /** Where this view is shown: { kind: 'pane' | 'docked' | 'floating' | 'sheet' | 'window', width, height, detent? }. */
    surface: () => ({ ...surface }),
    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(fn);
      return () => listeners.set(event, listeners.get(event).filter((f) => f !== fn));
    },
    /**
     * Open a pc:// ref or a path under /apps/. Standalone, refs open through the app's resolve link.
     * 'companion' shows it in the companion slot when it belongs to the companion app; otherwise a new column.
     */
    open(target, { placement = 'new-column' } = {}) {
      if (!PLACEMENTS.includes(placement)) throw new Error(`Unknown placement: ${placement}`);
      if (parent) return send(TO_SHELL.OPEN, { target, placement });
      if (typeof target === 'string' && target.startsWith('/apps/')) win.location.assign(target);
      else win.location.assign(`/?open=${encodeURIComponent(target)}`);
    },
    notify(text, kind = 'info') {
      if (!NOTICE_KINDS.includes(kind)) kind = 'info';
      if (parent) send(TO_SHELL.NOTIFY, { text: String(text).slice(0, 500), kind });
    },
    registerCommands(commands) {
      const clean = (commands || []).filter((c) => c && typeof c.id === 'string' && typeof c.label === 'string')
        .map(({ id, label, shortcut }) => ({ id, label, shortcut: typeof shortcut === 'string' ? shortcut : undefined }));
      send(TO_SHELL.REGISTER_COMMANDS, { commands: clean });
    },
    setTitle(title) { send(TO_SHELL.TITLE, { title: String(title).slice(0, 200) }); },
    companion: {
      show() { send(TO_SHELL.COMPANION, { action: 'show' }); },
      hide() { send(TO_SHELL.COMPANION, { action: 'hide' }); },
    },
  };
}
