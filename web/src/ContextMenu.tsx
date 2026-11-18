import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Check, ChevronLeft, ChevronRight, X } from "lucide-react";

export type MenuOption = {
  label: string;
  icon: React.ReactNode;
  selected?: boolean;
  action?: () => void;
  /** Opens the system date picker instead of running an action. */
  date?: { value: string | null; change: (value: string) => void };
};
export type MenuItem = {
  label: string;
  icon?: React.ReactNode;
  shortcut?: string;
  /** Single key that activates the item while the menu is open. */
  key?: string;
  checked?: boolean;
  danger?: boolean;
  /** Label shown after the first activation; the second runs the action. */
  confirm?: string;
  action?: () => void;
  items?: MenuEntry[];
};
export type MenuRow = { row: string; shortcut?: string; options: MenuOption[] };
export type MenuEntry = MenuItem | MenuRow | "separator";
export type MenuRequest = {
  x: number;
  y: number;
  entries: MenuEntry[];
  sheet: boolean;
  title?: string;
  target?: string;
};

const isRow = (entry: MenuEntry): entry is MenuRow =>
  typeof entry === "object" && "row" in entry;
const inMenu = (target: EventTarget | null) =>
  !!(target as Element | null)?.closest?.(".context-menu, .menu-sheet");

export function ContextMenu({
  request,
  close,
}: {
  request: MenuRequest;
  close: () => void;
}) {
  // Read before the panel focuses itself, so closing returns focus here.
  const [previous] = useState(
    () => document.activeElement as HTMLElement | null,
  );
  useEffect(() => {
    const outside = (e: Event) => {
      if (!inMenu(e.target)) close();
    };
    // A scrolling page would leave the menu behind its target. A text field scrolling its own text, as
    // the search field does when the menu takes focus from it, moves nothing.
    const scrolled = (e: Event) => {
      const target = e.target;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement
      )
        return;
      outside(e);
    };
    if (!request.sheet) {
      document.addEventListener("pointerdown", outside, true);
      document.addEventListener("scroll", scrolled, true);
    }
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("scroll", scrolled, true);
      window.removeEventListener("resize", close);
      // Return focus without drawing a keyboard focus ring after a pointer menu.
      previous?.focus?.({
        preventScroll: true,
        focusVisible: false,
      } as FocusOptions);
    };
  }, [request, close, previous]);
  if (request.sheet) return <MenuSheet request={request} close={close} />;
  return (
    <MenuPanel
      entries={request.entries}
      x={request.x}
      y={request.y}
      label={request.title}
      close={close}
    />
  );
}

function MenuSheet({
  request,
  close,
}: {
  request: MenuRequest;
  close: () => void;
}) {
  const [stack, setStack] = useState([
    { title: request.title || "Actions", entries: request.entries },
  ]);
  const level = stack[stack.length - 1];
  return (
    <div
      className="menu-sheet-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div className="menu-sheet">
        <div className="menu-sheet-heading">
          {stack.length > 1 && (
            <button
              className="icon-button"
              aria-label="Back"
              onClick={() => setStack(stack.slice(0, -1))}
            >
              <ChevronLeft size={20} />
            </button>
          )}
          <strong>{level.title}</strong>
          <button
            className="icon-button"
            aria-label="Close menu"
            onClick={close}
          >
            <X size={18} />
          </button>
        </div>
        <MenuPanel
          key={stack.length}
          entries={level.entries}
          label={level.title}
          close={close}
          push={(item) =>
            setStack([...stack, { title: item.label, entries: item.items! }])
          }
        />
      </div>
    </div>
  );
}

function MenuPanel({
  entries,
  x = 0,
  y = 0,
  flipX,
  label,
  close,
  back,
  push,
  focusFirst,
  hold,
}: {
  entries: MenuEntry[];
  x?: number;
  y?: number;
  flipX?: number;
  label?: string;
  close: () => void;
  back?: () => void;
  push?: (item: MenuItem) => void;
  focusFirst?: boolean;
  hold?: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const hoverTimer = useRef(0);
  const [position, setPosition] = useState<{ left: number; top: number }>();
  const [sub, setSub] = useState<{
    index: number;
    rect: DOMRect;
    focus: boolean;
  } | null>(null);
  const [confirming, setConfirming] = useState(-1);
  const stops = () =>
    Array.from(
      ref.current?.querySelectorAll<HTMLElement>("[data-entry]") || [],
    );
  const entryOf = (el?: Element | null) =>
    Number((el as HTMLElement | null)?.dataset?.entry ?? -1);
  useLayoutEffect(() => {
    if (push) return;
    const box = ref.current!.getBoundingClientRect();
    let left = x;
    if (left + box.width > innerWidth - 8) left = (flipX ?? x) - box.width;
    setPosition({
      left: Math.max(8, left),
      top: Math.max(8, Math.min(y, innerHeight - box.height - 8)),
    });
  }, [x, y, flipX, push]);
  useEffect(() => {
    if (focusFirst) stops()[0]?.focus({ preventScroll: true });
    else ref.current?.focus({ preventScroll: true });
  }, []);
  // Hovering moves the highlight. While a submenu is open, wait briefly so the
  // pointer can cross other items on its way into the submenu.
  function hover(index: number, el: HTMLElement) {
    if (push) return;
    clearTimeout(hoverTimer.current);
    const item = entries[index];
    const go = () => {
      el.focus({ preventScroll: true });
      if (typeof item === "object" && !isRow(item) && item.items)
        openSub(index, el, false);
      else setSub(null);
    };
    if (sub && sub.index !== index)
      hoverTimer.current = window.setTimeout(go, 250);
    else go();
  }
  function openSub(index: number, el: HTMLElement, focus: boolean) {
    const item = entries[index] as MenuItem;
    if (push) return push(item);
    setSub({ index, rect: el.getBoundingClientRect(), focus });
  }
  function activate(index: number, el: HTMLElement) {
    const item = entries[index] as MenuItem;
    if (item.items) return openSub(index, el, true);
    if (item.confirm && confirming !== index) return setConfirming(index);
    close();
    item.action?.();
  }
  function choose(option: MenuOption, el: HTMLElement) {
    if (!option.date) {
      close();
      return option.action?.();
    }
    const input = el.nextElementSibling as HTMLInputElement;
    try {
      input.showPicker();
    } catch {
      input.focus();
    }
  }
  function onKeyDown(e: React.KeyboardEvent) {
    e.stopPropagation();
    const all = stops();
    const current = all.find((s) => s === document.activeElement);
    const here = entryOf(current);
    const vertical = e.key === "ArrowDown" || e.key === "ArrowUp";
    const horizontal = e.key === "ArrowRight" || e.key === "ArrowLeft";
    if (vertical) {
      e.preventDefault();
      const groups = [...new Set(all.map((s) => entryOf(s)))];
      const step = e.key === "ArrowDown" ? 1 : -1;
      const at = groups.indexOf(here);
      const next =
        groups[
          at === -1
            ? step > 0
              ? 0
              : groups.length - 1
            : (at + step + groups.length) % groups.length
        ];
      const choices = all.filter((s) => entryOf(s) === next);
      (
        choices.find((s) => s.getAttribute("aria-checked") === "true") ||
        choices[0]
      )?.focus();
    } else if (horizontal) {
      const right = e.key === "ArrowRight";
      const row = all.filter((s) => entryOf(s) === here);
      if (row.length > 1 && current) {
        e.preventDefault();
        const i = row.indexOf(current);
        row[(i + (right ? 1 : -1) + row.length) % row.length].focus();
      } else if (right && current?.dataset.submenu) {
        e.preventDefault();
        openSub(here, current, true);
      } else if (!right && back) {
        e.preventDefault();
        back();
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      if (back) back();
      else close();
    } else if (e.key === "Tab") {
      e.preventDefault();
    } else if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const index = entries.findIndex(
        (entry) =>
          typeof entry === "object" &&
          !isRow(entry) &&
          entry.key === e.key.toLowerCase(),
      );
      const el = all.find((s) => entryOf(s) === index);
      if (el) {
        e.preventDefault();
        activate(index, el);
      }
    }
  }
  const subItem = sub ? (entries[sub.index] as MenuItem) : null;
  return (
    <>
      <div
        ref={ref}
        className={push ? "menu-panel" : "menu-panel context-menu"}
        role="menu"
        aria-label={label}
        tabIndex={-1}
        style={
          push
            ? undefined
            : {
                left: position?.left ?? x,
                top: position?.top ?? y,
                // Stay focusable while measuring; the position is set before paint.
                opacity: position ? undefined : 0,
              }
        }
        onKeyDown={onKeyDown}
        onMouseEnter={hold}
        onContextMenu={(e) => e.preventDefault()}
      >
        {entries.map((entry, i) => {
          if (entry === "separator")
            return <div className="menu-separator" role="separator" key={i} />;
          if (isRow(entry))
            return (
              <div
                className="menu-row"
                role="group"
                aria-label={entry.row}
                key={i}
              >
                <div className="menu-row-heading">
                  <span>{entry.row}</span>
                  {entry.shortcut && (
                    <kbd className="menu-shortcut">{entry.shortcut}</kbd>
                  )}
                </div>
                <div className="menu-row-options">
                  {entry.options.map((option) => (
                    <span className="menu-option-wrap" key={option.label}>
                      <button
                        role="menuitemradio"
                        aria-checked={!!option.selected}
                        aria-label={option.label}
                        title={option.label}
                        data-entry={i}
                        className={`menu-option ${option.selected ? "selected" : ""}`}
                        onClick={(e) => choose(option, e.currentTarget)}
                        onMouseEnter={(e) => hover(i, e.currentTarget)}
                      >
                        {option.icon}
                        <span className="menu-option-label">
                          {option.label.split(" · ")[0]}
                        </span>
                      </button>
                      {option.date && (
                        <input
                          type="date"
                          className="menu-date-input"
                          tabIndex={-1}
                          aria-hidden="true"
                          value={option.date.value || ""}
                          onChange={(e) => {
                            if (!e.target.value) return;
                            close();
                            option.date!.change(e.target.value);
                          }}
                        />
                      )}
                    </span>
                  ))}
                </div>
              </div>
            );
          return (
            <button
              key={i}
              role={
                entry.checked === undefined ? "menuitem" : "menuitemcheckbox"
              }
              aria-checked={entry.checked}
              aria-haspopup={entry.items ? "menu" : undefined}
              aria-expanded={entry.items ? sub?.index === i : undefined}
              data-entry={i}
              data-submenu={entry.items ? "true" : undefined}
              className={`menu-item ${entry.danger ? "danger" : ""} ${sub?.index === i ? "expanded" : ""}`}
              onClick={(e) => activate(i, e.currentTarget)}
              onMouseEnter={(e) => hover(i, e.currentTarget)}
            >
              <span className="menu-icon">{entry.icon}</span>
              <span className="menu-label">
                {confirming === i ? entry.confirm : entry.label}
              </span>
              {entry.checked && <Check className="menu-check" size={15} />}
              {entry.shortcut && (
                <kbd className="menu-shortcut">{entry.shortcut}</kbd>
              )}
              {entry.items && (
                <ChevronRight className="menu-chevron" size={14} />
              )}
            </button>
          );
        })}
      </div>
      {sub && subItem?.items && (
        <MenuPanel
          key={`${sub.index}-${sub.focus}`}
          entries={subItem.items}
          label={subItem.label}
          x={sub.rect.right + 2}
          y={sub.rect.top - 6}
          flipX={sub.rect.left - 2}
          close={close}
          focusFirst={sub.focus}
          hold={() => clearTimeout(hoverTimer.current)}
          back={() => {
            const index = sub.index;
            setSub(null);
            stops()
              .find((s) => entryOf(s) === index)
              ?.focus();
          }}
        />
      )}
    </>
  );
}
