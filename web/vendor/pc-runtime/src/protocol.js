// The messages between the shell and the apps it hosts (docs/app-contract.md, section 7).
// Every message is { protocol: 'pc/1', type, ...fields } sent with postMessage to the same origin.

export const PROTOCOL = 'pc/1';

/** App -> shell */
export const TO_SHELL = Object.freeze({
  HELLO: 'hello',                 // { app }  first message from a pane
  OPEN: 'open',                   // { target, placement }  target is a pc:// ref or a path under /apps/
  NOTIFY: 'notify',               // { text, kind }
  REGISTER_COMMANDS: 'commands',  // { commands: [{ id, label, shortcut? }] }
  TITLE: 'title',                 // { title }  the tab's title; send after navigating so the shell saves where the pane is
  SHORTCUT: 'shortcut',           // { key }  a shell shortcut pressed while the pane had focus ('palette')
});

/** Shell -> app */
export const TO_APP = Object.freeze({
  WELCOME: 'welcome',             // { theme, paneId }
  THEME: 'theme',                 // { theme }
  COMMAND: 'command',             // { id }
});

export const PLACEMENTS = Object.freeze(['new-column', 'replace', 'split', 'tab']);
export const NOTICE_KINDS = Object.freeze(['info', 'success', 'warning', 'error']);

export function message(type, fields = {}) {
  return { ...fields, protocol: PROTOCOL, type };
}

/** A message from our protocol, or null. */
export function readMessage(data) {
  if (!data || typeof data !== 'object' || data.protocol !== PROTOCOL || typeof data.type !== 'string') return null;
  return data;
}
