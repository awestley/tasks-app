import React from "react";
import {
  CalendarDays,
  CheckCheck,
  ChevronDown,
  Inbox,
  Layers,
  Plus,
  Settings,
  Sun,
  Tag,
} from "lucide-react";
import type { Profile, Project, Task } from "./api";
import { Logo } from "./Logo";
import type { View } from "./tasks";

const icons = {
  today: Sun,
  inbox: Inbox,
  upcoming: CalendarDays,
  all: Layers,
  completed: CheckCheck,
};
type Press = React.HTMLAttributes<HTMLButtonElement>;

export function Sidebar({
  user,
  mobile,
  view,
  search,
  today,
  active,
  total,
  projects,
  labels,
  navigate,
  openSettings,
  addTask,
  addProject,
  taskListPress,
  projectPress,
}: {
  user: Profile;
  mobile: boolean;
  view: string;
  search: string;
  today: string;
  active: Task[];
  total: number;
  projects: Project[];
  labels: string[];
  navigate: (next: View) => void;
  openSettings: () => void;
  addTask: () => void;
  addProject: () => void;
  taskListPress: (item: "inbox" | "today" | "upcoming" | "all") => Press;
  projectPress: (project: Project) => Press;
}) {
  return (
    <aside className={`sidebar ${mobile ? "open" : ""}`}>
      <Logo />
      <button className="workspace-switch" onClick={openSettings}>
        <span className="avatar">{user.name.slice(0, 1)}</span>
        <span>
          {user.name}
          <small>Personal workspace</small>
        </span>
        <ChevronDown size={14} />
      </button>
      <button className="quick-add" onClick={addTask}>
        <Plus size={18} /> Add task <kbd>Q</kbd>
      </button>
      <nav>
        {(["inbox", "today", "upcoming", "all", "completed"] as const).map(
          (item) => {
            const Icon = icons[item];
            const count =
              item === "today"
                ? active.filter((t) => t.due_date && t.due_date <= today).length
                : item === "inbox"
                  ? active.filter((t) => !t.project_id).length
                  : item === "upcoming"
                    ? active.filter((t) => t.due_date && t.due_date > today)
                        .length
                    : item === "completed"
                      ? total - active.length
                      : active.length;
            return (
              <button
                className={view === item && !search ? "active" : ""}
                onClick={() => navigate(item)}
                key={item}
                {...(item !== "completed" && taskListPress(item))}
              >
                <Icon size={18} />
                <span>
                  {
                    {
                      inbox: "Inbox",
                      today: "Today",
                      upcoming: "Upcoming",
                      all: "All tasks",
                      completed: "Completed",
                    }[item]
                  }
                </span>
                <small>{count || ""}</small>
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
          onClick={addProject}
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
            {...projectPress(p)}
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
          </button>
        ))}
        {!labels.length && <p className="sidebar-hint">No labels</p>}
      </nav>
      <div className="sidebar-bottom">
        <button onClick={openSettings}>
          <Settings size={17} /> Settings & integrations
        </button>
      </div>
    </aside>
  );
}
