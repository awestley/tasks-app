// Right-click opens a menu at the pointer; a touch long-press opens it as a sheet.
import React, { useEffect, useRef } from "react";
import type { MenuEntry, MenuRequest } from "./ContextMenu";

const editable = "input,textarea,select,a[href],code,[contenteditable]";

export function usePressMenu(setMenu: (menu: MenuRequest | null) => void) {
  const press = useRef({ timer: 0, x: 0, y: 0, active: false, until: 0 });
  const pointerType = useRef("mouse");
  const claimed = useRef<Event | null>(null);
  useEffect(() => {
    // Behave like an app: no browser context menu outside text and links.
    const native = (e: MouseEvent) => {
      const target = e.target as Element;
      if (!target.closest?.(editable) && !getSelection()?.toString())
        e.preventDefault();
    };
    const released = () => {
      clearTimeout(press.current.timer);
      if (press.current.active) press.current.until = Date.now() + 400;
      press.current.active = false;
    };
    const swallow = (e: MouseEvent) => {
      if (Date.now() < press.current.until) {
        e.preventDefault();
        e.stopPropagation();
        press.current.until = 0;
      }
    };
    document.addEventListener("contextmenu", native);
    document.addEventListener("pointerup", released, true);
    document.addEventListener("pointercancel", released, true);
    document.addEventListener("click", swallow, true);
    return () => {
      document.removeEventListener("contextmenu", native);
      document.removeEventListener("pointerup", released, true);
      document.removeEventListener("pointercancel", released, true);
      document.removeEventListener("click", swallow, true);
    };
  }, []);
  const menuFor = (
    entries: () => MenuEntry[],
    title?: string,
    target?: string,
  ) => ({
    onContextMenu: (e: React.MouseEvent) => {
      if ((e.target as Element).closest(editable)) return;
      e.preventDefault();
      e.stopPropagation();
      clearTimeout(press.current.timer);
      if (press.current.active) return;
      const touch = pointerType.current === "touch";
      press.current.active = touch;
      let { clientX: x, clientY: y } = e;
      if (!x && !y) {
        const box = e.currentTarget.getBoundingClientRect();
        x = box.left + 24;
        y = box.bottom;
      }
      setMenu({ x, y, entries: entries(), title, target, sheet: touch });
    },
    onPointerDown: (e: React.PointerEvent) => {
      pointerType.current = e.pointerType;
      if (e.pointerType !== "touch" || claimed.current === e.nativeEvent)
        return;
      claimed.current = e.nativeEvent;
      clearTimeout(press.current.timer);
      press.current.x = e.clientX;
      press.current.y = e.clientY;
      press.current.timer = window.setTimeout(() => {
        press.current.active = true;
        navigator.vibrate?.(10);
        getSelection()?.removeAllRanges();
        setMenu({
          x: press.current.x,
          y: press.current.y,
          entries: entries(),
          title,
          target,
          sheet: true,
        });
      }, 450);
    },
    onPointerMove: (e: React.PointerEvent) => {
      if (
        Math.hypot(e.clientX - press.current.x, e.clientY - press.current.y) > 8
      )
        clearTimeout(press.current.timer);
    },
  });
  return { press, pointerType, menuFor };
}
