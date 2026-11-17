/* Glassive ships no component library: these describe the static renditions' class API (components/bundle.css). */

/** Liquid-glass pill for toolbar actions. Wrap the stage in `.gl-liquid` to get the control fill. */
export interface ToolbarButtonProps {
  /** `.gl-toolbar-button` alone, or several inside `.gl-toolbar-group`. */
  variant?: "icon" | "text" | "group";
  /** `.is-active`: hover/selected fill. `.is-toggled`: accent fill for an enabled toggle. */
  state?: "rest" | "is-active" | "is-toggled";
  children: unknown;
}

/** Pill button. `.gl-button` plus modifiers; `.is-modal` for a modal button row. */
export interface ButtonProps {
  variant?: "default" | "mod-cta" | "mod-destructive" | "mod-destructive mod-cta";
  inModal?: boolean;
  label: string;
}

/** Glass context menu: `.gl-menu.gl-glass` containing `.gl-menu-item` rows and `.gl-menu-separator`. */
export interface MenuProps {
  items: Array<{ title: string; icon?: string; shortcut?: string; selected?: boolean; warning?: boolean } | "separator">;
}

/** Dialog shell: `.gl-modal` with `.gl-modal-title`, `.gl-modal-body`, `.gl-modal-buttons`. */
export interface ModalProps {
  title?: string;
  children: unknown;
  buttons: ButtonProps[];
}

/** Glass hover label: `.gl-tooltip` (inside `.gl-liquid`). */
export interface TooltipProps { text: string; }

/** Subtle-glass toast: `.gl-notice.gl-glass-subtle`. */
export interface NoticeProps { message: string; }

/** Quick switcher: `.gl-prompt` with `.gl-prompt-input` and `.gl-prompt-results` of `.gl-suggestion` rows. */
export interface CommandPaletteProps {
  query: string;
  results: Array<{ title: string; prefix?: string; selected?: boolean }>;
}

/** Editor autocomplete: `.gl-suggest.gl-glass` with `.gl-suggest-list` of `.gl-suggest-item` and a `.gl-suggest-footer`. */
export interface SuggestionPopupProps { items: Array<{ title: string; path?: string; selected?: boolean }>; instructions?: string[]; }

/** Hover preview: `.gl-popover` with a `.gl-popover-link` button. */
export interface PopoverProps { children: unknown; }

/** Sidebar tree: `.gl-sidebar` with `.gl-nav-header`, `.gl-tree-item` rows (`.is-folder`, `.is-child`, `.is-active`) and `.gl-vault-profile`. */
export interface FileTreeProps { items: Array<{ name: string; kind?: "file" | "folder"; depth?: number; tag?: string; active?: boolean }>; vault?: string; }

/** Main-area tabs: `.gl-tabbar` of `.gl-tab` (`.is-active`) > `.gl-tab-inner`, then `.gl-viewheader`. */
export interface TabBarProps { tabs: Array<{ title: string; active?: boolean }>; breadcrumb?: string; }

/** Sidebar view switcher: `.gl-sidetabs` of `.gl-sidetab` icons (`.is-active`), inside `.gl-liquid`. */
export interface SidebarTabsProps { tabs: Array<{ icon: string; active?: boolean }>; }

/** Settings card: `.gl-setting-heading` + `.gl-setting-items` of `.gl-setting-item` rows; controls `.gl-toggle`, `.gl-slider`, `.gl-dropdown`. */
export interface SettingGroupProps {
  heading?: string;
  items: Array<{ name: string; description?: string; control: "toggle" | "slider" | "dropdown" | "button"; value?: unknown }>;
}

/** Settings window: `.gl-settings` with `.gl-settings-side` (`.gl-settings-nav`, `.is-active`) and `.gl-settings-main`. */
export interface SettingsModalProps { nav: Array<{ group: string; items: string[] }>; active: string; children: unknown; }

/** Callout: `.gl-callout` (`.is-note`, `.is-warning`, `.is-danger`; default tip) with `.gl-callout-title`. */
export interface CalloutProps { type?: "tip" | "note" | "warning" | "danger"; title: string; children: unknown; }

/** Table: `.gl-table` inside `.gl-table-wrap` (`.has-focus` adds the glass card and `.gl-table-btn` pills). */
export interface TableProps { head: string[]; rows: string[][]; focused?: boolean; }

/** Drag preview: `.gl-ghost-card`. */
export interface DragGhostProps { children: unknown; }
