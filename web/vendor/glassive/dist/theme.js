// Glassive theme helper. Applies a theme ({ mode, accent, fontSize }) to a root element.
// In Personal Command the shell owns these settings and sends them to each app; an app running
// on its own calls applyTheme() with DEFAULT_THEME (or its saved settings) and follows the system.

export const ACCENTS = Object.freeze([
  'red', 'orange', 'yellow', 'green', 'mint', 'teal', 'cyan',
  'blue', 'indigo', 'purple', 'pink', 'brown', 'obsidian',
]);
export const MODES = Object.freeze(['light', 'dark', 'system']);
export const FONT_SIZE_MIN = 14;
export const FONT_SIZE_MAX = 22;
export const DEFAULT_THEME = Object.freeze({ mode: 'system', accent: 'blue', fontSize: 17 });

/** Fill in defaults and clamp values, so a bad stored or relayed value can't break the page. */
export function normalizeTheme(input = {}) {
  const t = input && typeof input === 'object' ? input : {};
  const mode = MODES.includes(t.mode) ? t.mode : DEFAULT_THEME.mode;
  const accent = ACCENTS.includes(t.accent) ? t.accent : DEFAULT_THEME.accent;
  const n = Number(t.fontSize);
  const fontSize = Number.isFinite(n)
    ? Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, Math.round(n)))
    : DEFAULT_THEME.fontSize;
  return { mode, accent, fontSize };
}

/** 'light' or 'dark' for a mode, asking the system when the mode is 'system'. */
export function resolveMode(mode, win = globalThis.window) {
  if (mode === 'light' || mode === 'dark') return mode;
  const mq = win?.matchMedia?.('(prefers-color-scheme: dark)');
  return mq?.matches ? 'dark' : 'light';
}

/**
 * Apply a theme to `root` (default: the document element). Returns the normalized theme.
 * Sets data-theme, --color-accent and --font-text-size. Custom properties inherit into shadow DOM,
 * so embeds inside this root pick the theme up without doing anything.
 */
export function applyTheme(theme, root = globalThis.document?.documentElement, win = globalThis.window) {
  const t = normalizeTheme(theme);
  if (!root) return t;
  root.setAttribute('data-theme', resolveMode(t.mode, win));
  root.style.setProperty('--color-accent', `var(--accent-${t.accent})`);
  root.style.setProperty('--font-text-size', `${t.fontSize}px`);
  return t;
}

/**
 * Apply a theme and keep 'system' mode in step with the OS. Returns a function that stops watching.
 */
export function watchTheme(theme, root = globalThis.document?.documentElement, win = globalThis.window) {
  let current = applyTheme(theme, root, win);
  const mq = win?.matchMedia?.('(prefers-color-scheme: dark)');
  if (!mq?.addEventListener) return () => {};
  const onChange = () => { if (current.mode === 'system') current = applyTheme(current, root, win); };
  mq.addEventListener('change', onChange);
  return () => mq.removeEventListener('change', onChange);
}
