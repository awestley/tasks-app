export type Accent =
  | 'red' | 'orange' | 'yellow' | 'green' | 'mint' | 'teal' | 'cyan'
  | 'blue' | 'indigo' | 'purple' | 'pink' | 'brown' | 'obsidian';
export type Mode = 'light' | 'dark' | 'system';
export interface Theme { mode: Mode; accent: Accent; fontSize: number; }

export const ACCENTS: readonly Accent[];
export const MODES: readonly Mode[];
export const FONT_SIZE_MIN: number;
export const FONT_SIZE_MAX: number;
export const DEFAULT_THEME: Readonly<Theme>;

export function normalizeTheme(input?: Partial<Theme> | unknown): Theme;
export function resolveMode(mode: Mode, win?: Window): 'light' | 'dark';
export function applyTheme(theme: Partial<Theme>, root?: HTMLElement, win?: Window): Theme;
export function watchTheme(theme: Partial<Theme>, root?: HTMLElement, win?: Window): () => void;
