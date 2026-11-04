// React bindings for the runtime, for apps built with React (Taskwell, Notebook).
//
//   import { PcProvider, usePaneTitle, useCommands, useTheme, PcEmbed } from '@awestley/pc-runtime/react';
//   import { applyTheme } from '@awestley/glassive';
//
//   <PcProvider app="tasks" applyTheme={applyTheme}>
//     <App />
//   </PcProvider>
//
//   function TaskPage({ task }) {
//     usePaneTitle(task.title);
//     useCommands([{ id: 'new-task', label: 'New task' }], (id) => { ... });
//     return <PcEmbed target="pc://notes/note/abc" size="card" />;
//   }
//
// Written without JSX so it needs no build step of its own. React is a peer dependency.
import { createContext, createElement, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { connect } from './index.js';
import { defineEmbed } from './embed.js';

const PcContext = createContext(null);

export function PcProvider({ app, applyTheme, children }) {
  const pc = useMemo(() => connect({ app, applyTheme }), [app, applyTheme]);
  useEffect(() => { defineEmbed(pc); }, [pc]);
  return createElement(PcContext.Provider, { value: pc }, children);
}

/** The runtime client: open, notify, isHosted, ... (docs/app-contract.md, section 7). */
export function usePc() {
  const pc = useContext(PcContext);
  if (!pc) throw new Error('usePc() must be used inside <PcProvider>');
  return pc;
}

/** The current theme ({ mode, accent, fontSize }), updated live when the shell changes it. */
export function useTheme() {
  const pc = usePc();
  const [theme, setTheme] = useState(() => pc.theme());
  useEffect(() => pc.on('theme', setTheme), [pc]);
  return theme;
}

/** Whether the app is running inside the shell; false until the shell answers. */
export function useHosted() {
  const pc = usePc();
  const [hosted, setHosted] = useState(false);
  useEffect(() => { let live = true; pc.ready.then((h) => { if (live) setHosted(h); }); return () => { live = false; }; }, [pc]);
  return hosted;
}

/** Name the tab. Call it in every page, so the shell also records where the pane is. */
export function usePaneTitle(title) {
  const pc = usePc();
  useEffect(() => { if (title) pc.setTitle(title); }, [pc, title]);
}

/** Register commands for the ⌘K palette and handle them while this component is mounted. */
export function useCommands(commands, onCommand) {
  const pc = usePc();
  const handler = useRef(onCommand);
  handler.current = onCommand;
  const key = JSON.stringify(commands);
  useEffect(() => {
    pc.registerCommands(JSON.parse(key));
    const off = pc.on('command', ({ id }) => handler.current?.(id));
    return () => { off(); pc.registerCommands([]); };
  }, [pc, key]);
}

/**
 * An embedded item from any app. React reserves the `ref` prop, so the reference is passed as
 * `target` and set as the element's `ref` attribute here.
 */
export function PcEmbed({ target, size = 'inline', className, children }) {
  const el = useRef(null);
  useEffect(() => {
    if (!el.current) return;
    el.current.setAttribute('ref', target);
    el.current.setAttribute('size', size);
  }, [target, size]);
  return createElement('pc-embed', { ref: el, class: className }, children);
}
