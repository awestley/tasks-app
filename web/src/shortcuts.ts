// The keyboard: Q adds, G then a letter changes list, J and K move, and letters act on the selected task.
import { moveMenu } from "./taskMenus";
import { store, type View } from "./routes";
import type { W } from "./workspaceContext";

export function handleShortcut(e: KeyboardEvent, w: W) {
  const {
    companion,
    hosted,
    phone,
    wide,
    detailBeside,
    pc,
    search,
    setSearch,
    flat,
    groups,
    openId,
    setOpenId,
    selected,
    setSelected,
    inlineAdd,
    setInlineAdd,
    drawer,
    setDrawer,
    sidebarPref,
    setSidebarPref,
    setMenu,
    setPicker,
    searchRef,
    listRef,
    lastEscape,
    gPending,
    toast,
    setToast,
    modalOpen,
    target,
    navigate,
    openQuick,
    openDetail,
    openInColumn,
    toggle,
    schedule,
    setPriority,
    duplicate,
    goToProject,
    setShortcuts,
    setFocusKey,
  } = w;
  const typing = (e.target as HTMLElement).matches?.(
    "input,textarea,select,[contenteditable]",
  );
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key.toLowerCase() === "z" && !typing && toast?.undo) {
    e.preventDefault();
    toast.undo();
    setToast({ id: Date.now(), text: "Undone" });
    return;
  }
  if (mod && e.key.toLowerCase() === "k" && !hosted) {
    e.preventDefault();
    searchRef.current?.focus();
    return;
  }
  if (mod && e.key === "Enter" && companion && !typing) {
    const t = target();
    if (t) openInColumn(t);
    return;
  }
  if (e.key === "Escape") {
    if (modalOpen) return; // the dialog or menu closes itself
    if (typing) return;
    if (openId) {
      setOpenId(null);
      return;
    }
    if (inlineAdd) return setInlineAdd(null);
    if (search) return setSearch("");
    if (drawer) return setDrawer(false);
    if (selected) return setSelected(null);
    if (companion && hosted) {
      if (Date.now() - lastEscape.current < 600) pc.companion.hide();
      lastEscape.current = Date.now();
      (document.activeElement as HTMLElement | null)?.blur();
    }
    return;
  }
  if (typing || mod || e.altKey || modalOpen) return;
  const key = e.key;
  if (Date.now() - gPending.current < 900) {
    gPending.current = 0;
    const go = {
      t: "today",
      i: "inbox",
      u: "upcoming",
      c: "completed",
      a: "all",
    }[key.toLowerCase()];
    if (go) {
      e.preventDefault();
      navigate(go as View);
      return;
    }
  }
  if (key === "g") {
    gPending.current = Date.now();
    return;
  }
  if (key === "q") {
    e.preventDefault();
    return openQuick();
  }
  if (key === "a" && !companion) {
    e.preventDefault();
    const last = groups.filter((g) => g.add).at(-1);
    if (last) setInlineAdd(last.key);
    return;
  }
  if (key === "/") {
    e.preventDefault();
    if (companion) setFocusKey(Date.now());
    else searchRef.current?.focus();
    return;
  }
  if (key === "?") return setShortcuts(true);
  if (key === "m" && !companion && !phone) {
    if (wide) {
      setSidebarPref(!sidebarPref);
      store("tasks.sidebar", sidebarPref ? "hidden" : "shown");
    } else setDrawer(!drawer);
    return;
  }
  if (key === "j" || key === "k" || key === "ArrowDown" || key === "ArrowUp") {
    e.preventDefault();
    const i = flat.findIndex((t) => t.id === selected);
    const next =
      flat[
        Math.max(
          0,
          Math.min(
            flat.length - 1,
            i + (key === "j" || key === "ArrowDown" ? 1 : -1),
          ),
        )
      ];
    if (next) {
      setSelected(next.id);
      if (openId && detailBeside) setOpenId(next.id);
      requestAnimationFrame(() =>
        (
          listRef.current?.querySelector(
            `[data-id="${CSS.escape(next.id)}"]`,
          ) as HTMLElement | null
        )?.focus(),
      );
    }
    return;
  }
  const t = target();
  if (!t) return;
  if (key === "Enter" || key === "e") openDetail(t);
  else if (key === "c" || (key === " " && companion)) toggle(t);
  else if (key === "d") duplicate(t);
  else if (key === "G") goToProject(t);
  else if (key === "t") {
    const row = listRef.current?.querySelector(
      `[data-id="${CSS.escape(t.id)}"]`,
    );
    const box = row?.getBoundingClientRect();
    setPicker({
      task: t,
      anchor: box ? { x: box.left + 40, y: box.bottom } : { x: 100, y: 100 },
    });
  } else if (key === "T") schedule(t, null);
  else if (key === "v") {
    const row = listRef.current?.querySelector(
      `[data-id="${CSS.escape(t.id)}"]`,
    );
    const box = row?.getBoundingClientRect() || new DOMRect(100, 100, 0, 0);
    setMenu({
      x: box.left + 40,
      y: box.bottom,
      entries: moveMenu(t, w),
      title: "Move to",
      target: t.id,
      sheet: false,
    });
  } else if (["1", "2", "3", "4"].includes(key)) setPriority(t, Number(key));
  else return;
  e.preventDefault();
}
