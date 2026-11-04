// Types for @awestley/pc-runtime (docs/app-contract.md, section 7).
export type Placement = 'new-column' | 'replace' | 'split' | 'tab';
export type NoticeKind = 'info' | 'success' | 'warning' | 'error';
export interface Theme { mode: 'light' | 'dark' | 'system'; accent: string; fontSize: number }
export interface Command { id: string; label: string; shortcut?: string }
// Takes any theme-shaped value, so a design system with narrower types (e.g. glassive applyTheme) fits.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ApplyTheme = (theme: any, root?: HTMLElement, win?: Window) => unknown;

export interface PcClient {
  readonly PROTOCOL: string;
  /** Resolves true once the shell answers, false when the app runs on its own. */
  readonly ready: Promise<boolean>;
  isHosted(): boolean;
  paneId(): string | null;
  theme(): Theme;
  on(event: 'theme', fn: (theme: Theme) => void): () => void;
  on(event: 'command', fn: (detail: { id: string }) => void): () => void;
  open(target: string, options?: { placement?: Placement }): void;
  notify(text: string, kind?: NoticeKind): void;
  registerCommands(commands: Command[]): void;
  setTitle(title: string): void;
}

export const PROTOCOL: string;
export function connect(options?: { app?: string; applyTheme?: ApplyTheme; win?: Window }): PcClient;
export { parseRef, formatRef, findShortRefs, shortRef } from './refs.js';
