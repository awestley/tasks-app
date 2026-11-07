// What the workspace's pieces (task rows, the sidebar, menus, shortcuts, page bodies) share. Workspace
// owns the state and builds this on each render.
import type React from "react";
import type { usePc } from "@awestley/pc-runtime/react";
import type { Profile, Project, Task } from "./api";
import type { MenuEntry, MenuRequest } from "./ContextMenu";
import type { Toast } from "./pieces";
import type { QuickDefaults } from "./QuickAdd";
import type { Permission } from "./reminders";
import type { View } from "./routes";
import type { TaskChanges } from "./store";
import type { Group } from "./useTaskGroups";
import type { usePressMenu } from "./usePressMenu";

type Set<T> = (value: T) => void;
type Ref<T> = { current: T };

export type W = {
  companion: boolean;
  hosted: boolean;
  phone: boolean;
  wide: boolean;
  narrow: boolean;
  detailBeside: boolean;
  sidebarDocked: boolean;
  coarse: boolean;
  pc: ReturnType<typeof usePc>;
  user: Profile;
  projects: Project[];
  active: Task[];
  labels: string[];
  counts: Record<"today" | "inbox" | "upcoming" | "all" | "completed", number>;
  permission: Permission;
  view: View;
  search: string;
  setSearch: Set<string>;
  today: string;
  title: string;
  selectedProject?: Project | null;
  sort: string;
  setSort: Set<string>;
  priorityFilter: boolean;
  setPriorityFilter: Set<boolean>;
  shown: Task[];
  flat: Task[];
  groups: Group[];
  openId: string | null;
  setOpenId: Set<string | null>;
  selected: string | null;
  setSelected: Set<string | null>;
  inlineAdd: string | null;
  setInlineAdd: Set<string | null>;
  drawer: boolean;
  setDrawer: Set<boolean>;
  sidebarPref: boolean;
  setSidebarPref: Set<boolean>;
  phoneScreen: "list" | "search" | "browse";
  setPhoneScreen: Set<"list" | "search" | "browse">;
  menu: MenuRequest | null;
  setMenu: Set<MenuRequest | null>;
  setPicker: Set<{
    task: Task;
    anchor: DOMRect | { x: number; y: number };
  } | null>;
  finishing: globalThis.Set<string>;
  hovered: Ref<string | null>;
  searchRef: React.RefObject<HTMLInputElement | null>;
  listRef: React.RefObject<HTMLDivElement | null>;
  lastEscape: Ref<number>;
  gPending: Ref<number>;
  toast: Toast | null;
  setToast: Set<Toast | null>;
  modalOpen: boolean;
  target: () => Task | null;
  navigate: (next: View) => void;
  openQuick: (defaults?: QuickDefaults) => void;
  openDetail: (task: Task) => void;
  openInColumn: (task: Task) => unknown;
  toggle: (task: Task) => void;
  schedule: (task: Task, due: string | null) => void;
  setPriority: (task: Task, priority: number) => void;
  patch: (task: Task, changes: TaskChanges, message?: string) => void;
  duplicate: (task: Task) => void;
  copy: (text: string, message: string) => unknown;
  removeTask: (task: Task) => void;
  goToProject: (task: Task) => void;
  menuFor: ReturnType<typeof usePressMenu>["menuFor"];
  openMenuAt: (
    e: React.MouseEvent,
    entries: MenuEntry[],
    title?: string,
    target?: string,
  ) => void;
  rowHandlers: (task: Task) => React.HTMLAttributes<HTMLDivElement>;
  addTaskIn: (next: View) => MenuEntry[];
  projectMenu: (project: Project) => MenuEntry[];
  listMenu: () => MenuEntry[];
  setProjectEditor: Set<Project | "new" | null>;
  setSettings: Set<boolean>;
  setShortcuts: Set<boolean>;
  setBell: Set<DOMRect | null>;
  setFocusKey: Set<number>;
};
