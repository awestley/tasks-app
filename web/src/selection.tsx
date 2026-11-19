// Several tasks selected at once: Cmd/Ctrl-click or Shift-click rows, then change them together from
// the toolbar that replaces the list toolbar, or from the right-click menu on a selected row.
// Separate from W.selected, which is the single keyboard cursor.
import React, { useEffect, useState } from "react";
import {
  CalendarDays,
  CheckCircle2,
  Flag,
  FolderInput,
  SquareCheck,
  Trash2,
  X,
} from "lucide-react";
import type { Task } from "./api";
import type { MenuEntry } from "./ContextMenu";
import { dateChoices, moveChoices, priorityChoices } from "./taskMenus";
import type { W } from "./workspaceContext";

export type Selection = {
  /** False in the companion and phone layouts, which have no selection toolbar. */
  canSelect: boolean;
  /** The selected tasks, in list order. */
  chosen: Task[];
  selecting: boolean;
  has: (id: string) => boolean;
  /** Returns true when the click changed the selection instead of acting on the row. */
  click: (task: Task, e: React.MouseEvent) => boolean;
  add: (task: Task) => void;
  all: () => void;
  clear: () => void;
  complete: () => void;
  schedule: (due: string | null) => void;
  pickDate: (anchor: DOMRect | { x: number; y: number }) => void;
  priority: (priority: number) => void;
  move: (projectId: string | null, name: string) => void;
  remove: () => void;
};

export const taskCount = (n: number) => (n === 1 ? "1 task" : `${n} tasks`);

/** A value every selected task shares, or undefined when they differ. */
export function shared<K extends keyof Task>(
  tasks: Task[],
  key: K,
): Task[K] | undefined {
  const first = tasks[0]?.[key];
  return tasks.every((t) => t[key] === first) ? first : undefined;
}

const dateRow = (w: W, anchor: () => { x: number; y: number }) => ({
  row: "Date",
  options: dateChoices(
    w,
    shared(w.selection.chosen, "due_date"),
    w.selection.schedule,
    () => w.selection.pickDate(anchor()),
  ),
});
const priorityRow = (w: W) => ({
  row: "Priority",
  shortcut: "1–4",
  options: priorityChoices(
    shared(w.selection.chosen, "priority"),
    w.selection.priority,
  ),
});
const moveItems = (w: W) =>
  moveChoices(
    w.projects,
    shared(w.selection.chosen, "project_id"),
    w.selection.move,
  );
const menuAnchor = (w: W) => () => ({
  x: w.menu?.x ?? innerWidth / 2,
  y: w.menu?.y ?? 120,
});

/** The menu for a selected row when more than one task is selected. */
export function selectionMenu(w: W): MenuEntry[] {
  const { selection, flat } = w;
  const { chosen } = selection;
  const allCompleted = chosen.every((t) => t.completed);
  return [
    {
      label: allCompleted ? "Restore" : "Complete",
      icon: <CheckCircle2 size={16} />,
      shortcut: "C",
      key: "c",
      action: selection.complete,
    },
    "separator",
    dateRow(w, menuAnchor(w)),
    priorityRow(w),
    "separator",
    {
      label: "Move to",
      icon: <FolderInput size={16} />,
      shortcut: "V",
      key: "v",
      items: moveItems(w),
    },
    ...(chosen.length < flat.length
      ? [
          {
            label: "Select all",
            icon: <SquareCheck size={16} />,
            shortcut: "⌘A",
            action: selection.all,
          },
        ]
      : []),
    {
      label: "Clear selection",
      icon: <X size={16} />,
      shortcut: "Esc",
      action: selection.clear,
    },
    "separator",
    {
      label: `Delete ${taskCount(chosen.length)}`,
      icon: <Trash2 size={16} />,
      danger: true,
      confirm: "Confirm delete",
      action: selection.remove,
    },
  ];
}

/** Replaces the list toolbar while tasks are selected. */
export function SelectionToolbar({ w }: { w: W }) {
  const { selection, openMenuAt } = w;
  const { chosen } = selection;
  const [confirmDelete, setConfirmDelete] = useState(false);
  const ids = chosen.map((t) => t.id).join(" ");
  useEffect(() => setConfirmDelete(false), [ids]);
  const allCompleted = chosen.every((t) => t.completed);
  const buttonAnchor = (e: React.MouseEvent<HTMLButtonElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    return () => ({ x: box.left, y: box.bottom + 4 });
  };
  return (
    <div
      className="list-toolbar selection-toolbar"
      role="toolbar"
      aria-label="Selected tasks"
    >
      <span>
        <SquareCheck size={15} />
        {chosen.length} selected
      </span>
      <div>
        <button
          aria-label={allCompleted ? "Restore" : "Complete"}
          onClick={selection.complete}
        >
          <CheckCircle2 size={15} />
          <span>{allCompleted ? "Restore" : "Complete"}</span>
        </button>
        <button
          aria-label="Date"
          aria-haspopup="menu"
          onClick={(e) => openMenuAt(e, [dateRow(w, buttonAnchor(e))], "Date")}
        >
          <CalendarDays size={15} />
          <span>Date</span>
        </button>
        <button
          aria-label="Priority"
          aria-haspopup="menu"
          onClick={(e) => openMenuAt(e, [priorityRow(w)], "Priority")}
        >
          <Flag size={15} />
          <span>Priority</span>
        </button>
        <button
          aria-label="Move to"
          aria-haspopup="menu"
          onClick={(e) => openMenuAt(e, moveItems(w), "Move to")}
        >
          <FolderInput size={15} />
          <span>Move</span>
        </button>
        <button
          className={confirmDelete ? "danger-on" : ""}
          aria-label={confirmDelete ? "Confirm delete" : "Delete"}
          onClick={() => {
            if (!confirmDelete) return setConfirmDelete(true);
            setConfirmDelete(false);
            selection.remove();
          }}
        >
          <Trash2 size={15} />
          <span>{confirmDelete ? "Confirm delete" : "Delete"}</span>
        </button>
        <button
          className="icon-only"
          aria-label="Clear selection"
          title="Clear selection (Esc)"
          onClick={selection.clear}
        >
          <X size={15} />
        </button>
      </div>
    </div>
  );
}
