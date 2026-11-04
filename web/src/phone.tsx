// The phone layout: a bottom tab bar, the Browse screen, swipe actions on task rows, and keeping
// sheets above the on-screen keyboard. Used when Tasks has a phone-sized screen to itself, on its
// own or as the app on screen in Personal Command (which leaves the bottom edge to the app and
// passes the safe areas in as --pc-safe-* variables).
import React, { useEffect, useState } from "react";
import {
  Bell,
  BellOff,
  Calendar,
  CalendarDays,
  CheckCheck,
  ChevronRight,
  Inbox,
  Keyboard,
  Layers,
  LayoutGrid,
  Plus,
  Search,
  Settings,
  Tag,
} from "lucide-react";
import type { Project } from "./api";

export type PhoneTab = "inbox" | "today" | "upcoming" | "search" | "browse";

export function useMedia(query: string) {
  const [matches, setMatches] = useState(() => matchMedia(query).matches);
  useEffect(() => {
    const media = matchMedia(query);
    const update = () => setMatches(media.matches);
    media.addEventListener("change", update);
    update();
    return () => media.removeEventListener("change", update);
  }, [query]);
  return matches;
}

/**
 * Sets --kb on the root to the height the on-screen keyboard covers, so a sheet can sit on top of
 * it. iOS shrinks only the visual viewport; inside the shell that belongs to the top window, which
 * is the same origin. Android with interactive-widget=resizes-content resizes the page instead, and
 * this stays 0.
 */
export function useKeyboardInset(active: boolean) {
  useEffect(() => {
    if (!active) return;
    const root = document.documentElement;
    let host: Window = window;
    try {
      if (window.top && window.top !== window && window.frameElement)
        host = window.top;
    } catch {
      /* another origin: use our own viewport */
    }
    const viewport = host.visualViewport;
    if (!viewport) return;
    // Android resizes the page for the keyboard: notice the page getting much shorter.
    let tallest = { width: host.innerWidth, height: host.innerHeight };
    const update = () => {
      if (
        host.innerWidth !== tallest.width ||
        host.innerHeight > tallest.height
      )
        tallest = { width: host.innerWidth, height: host.innerHeight };
      const bottom =
        host === window
          ? host.innerHeight
          : window.frameElement!.getBoundingClientRect().bottom;
      const covered = Math.max(
        0,
        Math.round(bottom - (viewport.offsetTop + viewport.height)),
      );
      const shrunk = host.innerHeight < tallest.height - 150;
      root.style.setProperty("--kb", covered + "px");
      root.classList.toggle("has-keyboard", covered > 80 || shrunk);
    };
    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);
    host.addEventListener("resize", update);
    update();
    return () => {
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
      host.removeEventListener("resize", update);
      root.style.removeProperty("--kb");
      root.classList.remove("has-keyboard");
    };
  }, [active]);
}

/**
 * iOS opens the keyboard only for a focus made during the tap itself. A sheet's field mounts a
 * moment later, so focus a hidden field now and let the sheet's field take focus from it.
 */
export function holdKeyboard() {
  if (!matchMedia("(pointer: coarse)").matches) return;
  let proxy = document.getElementById("focus-proxy") as HTMLInputElement | null;
  if (!proxy) {
    proxy = document.createElement("input");
    proxy.id = "focus-proxy";
    proxy.className = "focus-proxy";
    proxy.tabIndex = -1;
    proxy.setAttribute("aria-hidden", "true");
    document.body.appendChild(proxy);
  }
  proxy.focus({ preventScroll: true });
}

const SWIPE = 72;
let drag: {
  el: HTMLElement;
  id: number;
  x: number;
  y: number;
  dx: number;
  mode: "pending" | "swipe" | "scroll";
  armed: boolean;
} | null = null;

/**
 * Swipe a row right to complete it and left to schedule it, as in Todoist. Vertical drags scroll
 * as usual (rows are touch-action: pan-y). The row moves with the finger through --dx.
 */
export function swipeRow(actions: {
  right: () => void;
  left: () => void;
  /** A swipe began: cancel the long press. */
  began: () => void;
}) {
  const end = (e: React.PointerEvent<HTMLElement>) => {
    if (!drag || drag.el !== e.currentTarget || drag.id !== e.pointerId) return;
    const { el, dx, mode } = drag;
    drag = null;
    if (mode !== "swipe") return;
    el.classList.remove("is-swiping");
    el.classList.add("is-settling");
    el.style.setProperty("--dx", "0px");
    delete el.dataset.swipe;
    setTimeout(() => el.classList.remove("is-settling"), 260);
    // The lifted finger is not a tap: drop a click that follows straight away.
    const swallow = (ev: Event) => {
      ev.preventDefault();
      ev.stopPropagation();
    };
    document.addEventListener("click", swallow, { capture: true, once: true });
    setTimeout(
      () => document.removeEventListener("click", swallow, { capture: true }),
      80,
    );
    if (e.type !== "pointerup") return;
    if (dx >= SWIPE) actions.right();
    else if (dx <= -SWIPE) actions.left();
  };
  return {
    onPointerDown(e: React.PointerEvent<HTMLElement>) {
      if (e.pointerType !== "touch" || !e.isPrimary) return;
      drag = {
        el: e.currentTarget,
        id: e.pointerId,
        x: e.clientX,
        y: e.clientY,
        dx: 0,
        mode: "pending",
        armed: false,
      };
    },
    onPointerMove(e: React.PointerEvent<HTMLElement>) {
      if (!drag || drag.el !== e.currentTarget || drag.id !== e.pointerId)
        return;
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      if (drag.mode === "pending") {
        if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) {
          drag.mode = "scroll";
          return;
        }
        if (Math.abs(dx) < 12 || Math.abs(dx) < Math.abs(dy) * 1.4) return;
        drag.mode = "swipe";
        actions.began();
        try {
          drag.el.setPointerCapture(e.pointerId);
        } catch {
          /* already released */
        }
        drag.el.classList.add("is-swiping");
      }
      if (drag.mode !== "swipe") return;
      const limit = drag.el.offsetWidth * 0.55;
      const moved = Math.sign(dx) * Math.min(Math.abs(dx), limit);
      drag.dx = moved;
      drag.el.style.setProperty("--dx", moved + "px");
      const armed = Math.abs(moved) >= SWIPE;
      if (armed && !drag.armed) navigator.vibrate?.(8);
      drag.armed = armed;
      drag.el.dataset.swipe =
        moved > 0 ? (armed ? "done" : "right") : armed ? "date" : "left";
    },
    onPointerUp: end,
    onPointerCancel: end,
  };
}

export function TabBar({
  tab,
  go,
}: {
  tab: PhoneTab;
  go: (tab: PhoneTab) => void;
}) {
  const items: [PhoneTab, string, React.ReactNode][] = [
    ["inbox", "Inbox", <Inbox size={23} strokeWidth={1.75} />],
    [
      "today",
      "Today",
      <span className="tab-day">
        <Calendar size={23} strokeWidth={1.75} />
        <b>{new Date().getDate()}</b>
      </span>,
    ],
    ["upcoming", "Upcoming", <CalendarDays size={23} strokeWidth={1.75} />],
    ["search", "Search", <Search size={23} strokeWidth={1.75} />],
    ["browse", "Browse", <LayoutGrid size={23} strokeWidth={1.75} />],
  ];
  return (
    <nav className="tabbar" aria-label="Views">
      {items.map(([id, label, icon]) => (
        <button
          key={id}
          className={tab === id ? "is-active" : ""}
          aria-current={tab === id ? "page" : undefined}
          onClick={() => go(id)}
        >
          {icon}
          <span>{label}</span>
        </button>
      ))}
    </nav>
  );
}

type CellProps = React.ButtonHTMLAttributes<HTMLButtonElement>;
function Cell({
  icon,
  label,
  count,
  ...rest
}: {
  icon: React.ReactNode;
  label: React.ReactNode;
  count?: number | string;
} & CellProps) {
  return (
    <button className="phone-cell" {...rest}>
      <span className="phone-cell-icon">{icon}</span>
      <span className="phone-cell-label">{label}</span>
      {count ? <small>{count}</small> : null}
      <ChevronRight size={18} className="phone-cell-chevron" />
    </button>
  );
}

/** Everything that is not a tab: other views, projects, labels, reminders and settings. */
export function BrowseScreen({
  projects,
  labels,
  counts,
  projectCount,
  labelCount,
  go,
  addProject,
  projectProps,
  reminders,
  openReminders,
  openSettings,
  openShortcuts,
  status,
}: {
  projects: Project[];
  labels: string[];
  counts: { all: number; completed: number };
  projectCount: (id: string) => number;
  labelCount: (label: string) => number;
  go: (view: string) => void;
  addProject: () => void;
  projectProps: (project: Project) => CellProps;
  reminders: boolean;
  openReminders: (anchor: DOMRect) => void;
  openSettings: () => void;
  openShortcuts?: () => void;
  status: React.ReactNode;
}) {
  return (
    <div className="phone-page">
      <header className="phone-head">
        <div className="phone-bar">
          <span />
          <span className="phone-bar-title">Browse</span>
          <div className="phone-bar-actions">{status}</div>
        </div>
        <h1>Browse</h1>
      </header>
      <div className="phone-group">
        <Cell
          icon={<Layers size={20} className="nav-all" />}
          label="All tasks"
          count={counts.all}
          onClick={() => go("all")}
        />
        <Cell
          icon={<CheckCheck size={20} className="nav-completed" />}
          label="Completed"
          count={counts.completed}
          onClick={() => go("completed")}
        />
      </div>
      <div className="phone-group-head">
        <h2>My projects</h2>
        <button
          className="icon-button"
          aria-label="Add project"
          onClick={addProject}
        >
          <Plus size={20} />
        </button>
      </div>
      <div className="phone-group">
        {projects.map((p) => (
          <Cell
            key={p.id}
            icon={
              <span className="project-hash" style={{ color: p.color }}>
                #
              </span>
            }
            label={p.name}
            count={projectCount(p.id)}
            onClick={() => go(`project:${p.id}`)}
            {...projectProps(p)}
          />
        ))}
        {!projects.length && (
          <p className="phone-group-hint">
            Tap + or type #Name when adding a task.
          </p>
        )}
      </div>
      <div className="phone-group-head">
        <h2>Labels</h2>
      </div>
      <div className="phone-group">
        {labels.map((l) => (
          <Cell
            key={l}
            icon={<Tag size={18} className="tone-muted" />}
            label={l}
            count={labelCount(l)}
            onClick={() => go(`label:${l}`)}
          />
        ))}
        {!labels.length && (
          <p className="phone-group-hint">Type @label when adding a task.</p>
        )}
      </div>
      <div className="phone-group">
        <Cell
          icon={
            reminders ? (
              <Bell size={19} className="tone-blue" />
            ) : (
              <BellOff size={19} className="tone-muted" />
            )
          }
          label="Reminders"
          count={reminders ? "On" : "Off"}
          onClick={(e) =>
            openReminders(
              (e.currentTarget as HTMLElement).getBoundingClientRect(),
            )
          }
        />
        <Cell
          icon={<Settings size={19} className="tone-muted" />}
          label="Settings & integrations"
          onClick={openSettings}
        />
        {openShortcuts && (
          <Cell
            icon={<Keyboard size={19} className="tone-muted" />}
            label="Keyboard shortcuts"
            onClick={openShortcuts}
          />
        )}
      </div>
    </div>
  );
}
