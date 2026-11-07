// The page bodies of the phone and full layouts. Their roots stay in Workspace, shared on purpose, so a
// rotation or a resize between the two keeps an open sheet and what was typed in it.
import React from "react";
import {
  ArrowDownWideNarrow,
  ChevronLeft,
  Layers,
  ListFilter,
  Menu,
  MoreHorizontal,
  PanelLeft,
  Pencil,
  Plus,
  Search,
  X,
} from "lucide-react";
import { BrowseScreen, type PhoneTab } from "./phone";
import { WeekStrip } from "./pieces";
import { store, type View } from "./routes";
import type { W } from "./workspaceContext";

export type LayoutParts = {
  sections: React.ReactNode;
  status: React.ReactNode;
  bellButton: React.ReactNode;
  expiredBanner: React.ReactNode;
  detail: React.ReactNode;
};

export function PhonePage({
  w,
  parts,
  tab,
  subtitle,
  viewButton,
}: {
  w: W;
  parts: LayoutParts;
  tab: PhoneTab;
  subtitle: string | null;
  viewButton: React.ReactNode;
}) {
  const { sections, status, bellButton, expiredBanner } = parts;
  const {
    coarse,
    projects,
    active,
    labels,
    counts,
    permission,
    view,
    search,
    setSearch,
    title,
    selectedProject,
    phoneScreen,
    setPhoneScreen,
    searchRef,
    listRef,
    navigate,
    menuFor,
    projectMenu,
    listMenu,
    setProjectEditor,
    setSettings,
    setShortcuts,
    setBell,
  } = w;
  return phoneScreen === "browse" ? (
    <BrowseScreen
      projects={projects}
      labels={labels}
      counts={counts}
      projectCount={(id) => active.filter((t) => t.project_id === id).length}
      labelCount={(l) => active.filter((t) => t.labels.includes(l)).length}
      go={(next) => navigate(next as View)}
      addProject={() => setProjectEditor("new")}
      projectProps={(p) => menuFor(() => projectMenu(p), p.name)}
      reminders={permission === "granted"}
      openReminders={(anchor) => setBell(anchor)}
      openSettings={() => setSettings(true)}
      openShortcuts={coarse ? undefined : () => setShortcuts(true)}
      status={status}
    />
  ) : phoneScreen === "search" ? (
    <div className="phone-page">
      <header className="phone-head">
        <div className="phone-bar">
          <span />
          <span className="phone-bar-title">Search</span>
          <div className="phone-bar-actions">{status}</div>
        </div>
        <h1>Search</h1>
        <div className="search-box phone-search">
          <Search size={18} />
          <input
            ref={searchRef}
            type="search"
            enterKeyHint="search"
            autoFocus
            placeholder="Tasks, descriptions and labels"
            aria-label="Search tasks"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === "Escape")
                e.currentTarget.blur();
            }}
          />
          {search && (
            <button aria-label="Clear search" onClick={() => setSearch("")}>
              <X size={16} />
            </button>
          )}
        </div>
      </header>
      {search ? (
        <main className="task-main">{sections}</main>
      ) : (
        <p className="phone-hint">
          Search task names, descriptions and labels.
        </p>
      )}
    </div>
  ) : (
    <div className="phone-page">
      <header className="phone-head">
        <div className="phone-bar">
          {tab === "browse" ? (
            <button
              className="phone-back"
              onClick={() => {
                setPhoneScreen("browse");
                scrollTo({ top: 0 });
              }}
            >
              <ChevronLeft size={24} />
              Browse
            </button>
          ) : (
            <span />
          )}
          <span className="phone-bar-title">{title}</span>
          <div className="phone-bar-actions">
            {status}
            {selectedProject && (
              <button
                className="icon-button"
                aria-label="Edit project"
                onClick={() => setProjectEditor(selectedProject)}
              >
                <Pencil size={19} />
              </button>
            )}
            {bellButton}
            {viewButton}
          </div>
        </div>
        <h1>
          {selectedProject && (
            <span
              className="project-hash"
              style={{ color: selectedProject.color }}
            >
              #
            </span>
          )}
          {title}
        </h1>
        {subtitle && <p className="phone-sub">{subtitle}</p>}
      </header>
      {expiredBanner}
      {view === "upcoming" && (
        <WeekStrip
          tasks={active}
          jump={(d) => {
            const el = listRef.current?.querySelector(
              `[data-group="${d}"]`,
            ) as HTMLElement | null;
            if (el)
              scrollTo({
                top: el.getBoundingClientRect().top + scrollY - 64,
                behavior: "smooth",
              });
          }}
        />
      )}
      <main className="task-main" {...menuFor(listMenu, title)}>
        {sections}
      </main>
    </div>
  );
}

export function MainColumn({ w, parts }: { w: W; parts: LayoutParts }) {
  const { sections, bellButton, expiredBanner, detail } = parts;
  const {
    hosted,
    wide,
    sidebarDocked,
    user,
    active,
    view,
    search,
    setSearch,
    title,
    selectedProject,
    sort,
    setSort,
    priorityFilter,
    setPriorityFilter,
    shown,
    flat,
    setSelected,
    setDrawer,
    setSidebarPref,
    searchRef,
    listRef,
    openQuick,
    openMenuAt,
    listMenu,
    setProjectEditor,
    setSettings,
    menuFor,
  } = w;
  return (
    <div className="main-shell">
      <header className="topbar">
        {!sidebarDocked && (
          <button
            className="icon-button mobile-menu"
            aria-label={wide ? "Show sidebar" : "Open navigation"}
            title={wide ? "Show sidebar (M)" : "Navigation"}
            onClick={() => {
              if (wide) {
                setSidebarPref(true);
                store("tasks.sidebar", "shown");
              } else setDrawer(true);
            }}
          >
            {wide ? <PanelLeft size={18} /> : <Menu size={20} />}
          </button>
        )}
        {!hosted && (
          <div className="breadcrumb">
            My workspace <span className="crumb-sep">/</span>{" "}
            <span>{title}</span>
          </div>
        )}
        <span className="spacer" />
        <div className="search-box">
          <Search size={16} />
          <input
            ref={searchRef}
            placeholder="Search tasks"
            aria-label="Search tasks"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setSearch("");
                e.currentTarget.blur();
              } else if (e.key === "ArrowDown" || e.key === "Enter") {
                e.preventDefault();
                const first = flat[0];
                if (first) {
                  setSelected(first.id);
                  (
                    listRef.current?.querySelector(
                      `[data-id="${CSS.escape(first.id)}"]`,
                    ) as HTMLElement | null
                  )?.focus();
                }
              }
            }}
          />
          {search ? (
            <button aria-label="Clear search" onClick={() => setSearch("")}>
              <X size={14} />
            </button>
          ) : (
            <kbd>{hosted ? "/" : "⌘ K"}</kbd>
          )}
        </div>
        {bellButton}
        {!hosted && (
          <button
            className="top-avatar"
            aria-label="Open settings"
            onClick={() => setSettings(true)}
          >
            {user.name.slice(0, 1)}
          </button>
        )}
      </header>
      {expiredBanner}
      <div className="content-layout">
        <main className="task-main" {...menuFor(listMenu, title)}>
          <div className="page-title">
            <h1>
              {selectedProject && (
                <span
                  className="project-hash"
                  style={{ color: selectedProject.color }}
                >
                  #
                </span>
              )}
              {title}
            </h1>
            <div>
              {selectedProject && (
                <button
                  className="icon-button"
                  aria-label="Edit project"
                  onClick={() => setProjectEditor(selectedProject)}
                >
                  <Pencil size={18} />
                </button>
              )}
              <button
                className="icon-button"
                aria-label="View options"
                title="Sort and filter"
                onClick={(e) => openMenuAt(e, listMenu().slice(2), "View")}
              >
                <MoreHorizontal size={18} />
              </button>
              <button className="primary" onClick={() => openQuick()}>
                <Plus size={16} /> Add task
              </button>
            </div>
          </div>
          <div className="list-toolbar">
            <span>
              <Layers size={15} />
              {view === "completed"
                ? `${shown.length} completed`
                : (() => {
                    const n = shown.filter((t) => !t.completed).length;
                    return `${n} ${n === 1 ? "task" : "tasks"}`;
                  })()}
            </span>
            <div>
              <button
                className={priorityFilter ? "filter-on" : ""}
                onClick={() => setPriorityFilter(!priorityFilter)}
              >
                <ListFilter size={15} />
                {priorityFilter ? "High priority" : "Filter"}
              </button>
              <label>
                <ArrowDownWideNarrow size={14} />
                <select
                  aria-label="Sort tasks"
                  value={sort}
                  onChange={(e) => {
                    setSort(e.target.value);
                    store("tasks.sort", e.target.value);
                  }}
                >
                  <option value="smart">Due date</option>
                  <option value="priority">Priority</option>
                  <option value="name">Name</option>
                </select>
              </label>
            </div>
          </div>
          {view === "upcoming" && !search && (
            <WeekStrip
              tasks={active}
              jump={(d) =>
                listRef.current
                  ?.querySelector(`[data-group="${d}"]`)
                  ?.scrollIntoView({ behavior: "smooth", block: "start" })
              }
            />
          )}
          {sections}
        </main>
        {detail}
      </div>
    </div>
  );
}
