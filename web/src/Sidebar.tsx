import {
  CalendarDays,
  CheckCheck,
  ChevronDown,
  Inbox,
  Layers,
  PanelLeft,
  Plus,
  Settings,
  Sun,
  Tag,
} from "lucide-react";
import React from "react";
import { Logo } from "./SignIn";
import { store, viewNames } from "./routes";
import type { W } from "./workspaceContext";

const viewIcons = {
  today: Sun,
  inbox: Inbox,
  upcoming: CalendarDays,
  all: Layers,
  completed: CheckCheck,
};

export function Sidebar({ w, status }: { w: W; status: React.ReactNode }) {
  const {
    hosted,
    wide,
    user,
    projects,
    active,
    labels,
    counts,
    view,
    search,
    drawer,
    setSidebarPref,
    navigate,
    openQuick,
    menuFor,
    addTaskIn,
    projectMenu,
    setProjectEditor,
    setSettings,
  } = w;
  return (
    <aside
      className={`sidebar ${drawer ? "open" : ""}`}
      aria-label="Navigation"
    >
      <div className="sidebar-top">
        {!hosted ? <Logo /> : <span />}
        {wide && (
          <button
            className="icon-button"
            aria-label="Hide sidebar"
            title="Hide sidebar (M)"
            onClick={() => {
              setSidebarPref(false);
              store("tasks.sidebar", "hidden");
            }}
          >
            <PanelLeft size={17} />
          </button>
        )}
      </div>
      {!hosted && (
        <button className="workspace-switch" onClick={() => setSettings(true)}>
          <span className="avatar">{user.name.slice(0, 1)}</span>
          <span>
            {user.name}
            <small>Personal workspace</small>
          </span>
          <ChevronDown size={14} />
        </button>
      )}
      <button className="quick-add" onClick={() => openQuick()}>
        <Plus size={18} /> Add task <kbd>Q</kbd>
      </button>
      <nav>
        {(["inbox", "today", "upcoming", "all", "completed"] as const).map(
          (item) => {
            const Icon = viewIcons[item];
            return (
              <button
                className={view === item && !search ? "active" : ""}
                onClick={() => navigate(item)}
                key={item}
                {...(item !== "completed" && menuFor(() => addTaskIn(item)))}
              >
                <Icon size={18} className={`nav-${item}`} />
                <span>{viewNames[item]}</span>
                <small>{counts[item] || ""}</small>
              </button>
            );
          },
        )}
      </nav>
      <div className="sidebar-heading">
        My projects
        <button
          className="icon-button"
          aria-label="Add project"
          onClick={() => setProjectEditor("new")}
        >
          <Plus size={16} />
        </button>
      </div>
      <nav>
        {projects.map((p) => (
          <button
            key={p.id}
            className={view === `project:${p.id}` ? "active" : ""}
            onClick={() => navigate(`project:${p.id}`)}
            {...menuFor(() => projectMenu(p), p.name)}
          >
            <span className="project-hash" style={{ color: p.color }}>
              #
            </span>
            <span>{p.name}</span>
            <small>
              {active.filter((t) => t.project_id === p.id).length || ""}
            </small>
          </button>
        ))}
        {!projects.length && (
          <p className="sidebar-hint">
            Add one with +, or type #Name in quick add
          </p>
        )}
      </nav>
      <div className="sidebar-heading">
        Labels
        <Tag size={13} />
      </div>
      <nav>
        {labels.map((l) => (
          <button
            key={l}
            className={view === `label:${l}` ? "active" : ""}
            onClick={() => navigate(`label:${l}`)}
          >
            <span className="label-dot" />
            <span>{l}</span>
            <small>
              {active.filter((t) => t.labels.includes(l)).length || ""}
            </small>
          </button>
        ))}
        {!labels.length && (
          <p className="sidebar-hint">Type @label in quick add</p>
        )}
      </nav>
      <div className="sidebar-bottom">
        {status}
        <button onClick={() => setSettings(true)}>
          <Settings size={17} /> Settings & integrations
        </button>
      </div>
    </aside>
  );
}
