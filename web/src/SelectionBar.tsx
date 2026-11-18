// Actions for the picked tasks. It takes the list toolbar's place while tasks are picked.
import { useEffect, useState } from "react";
import {
  CalendarDays,
  CheckCircle2,
  Flag,
  FolderInput,
  SquareCheck,
  Trash2,
  X,
} from "lucide-react";
import { dateChoices, priorityRow, projectChoices, shared } from "./taskMenus";
import type { W } from "./workspaceContext";

export function SelectionBar({ w }: { w: W }) {
  const { chosen, bulk, clearPicks, openMenuAt } = w;
  const [confirm, setConfirm] = useState(false);
  const ids = chosen.map((t) => t.id).join();
  useEffect(() => setConfirm(false), [ids]);
  const allDone = chosen.every((t) => t.completed);
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
          aria-label={allDone ? "Restore" : "Complete"}
          onClick={bulk.complete}
        >
          <CheckCircle2 size={15} />
          <span>{allDone ? "Restore" : "Complete"}</span>
        </button>
        <button
          aria-label="Date"
          aria-haspopup="menu"
          onClick={(e) =>
            openMenuAt(
              e,
              [
                {
                  row: "Date",
                  options: dateChoices(
                    w,
                    shared(chosen, "due_date"),
                    bulk.schedule,
                    bulk.pickDate,
                  ),
                },
              ],
              "Date",
            )
          }
        >
          <CalendarDays size={15} />
          <span>Date</span>
        </button>
        <button
          aria-label="Priority"
          aria-haspopup="menu"
          onClick={(e) =>
            openMenuAt(
              e,
              [priorityRow(shared(chosen, "priority"), bulk.priority)],
              "Priority",
            )
          }
        >
          <Flag size={15} />
          <span>Priority</span>
        </button>
        <button
          aria-label="Move to"
          aria-haspopup="menu"
          onClick={(e) =>
            openMenuAt(
              e,
              projectChoices(w, shared(chosen, "project_id"), bulk.move),
              "Move to",
            )
          }
        >
          <FolderInput size={15} />
          <span>Move</span>
        </button>
        <button
          className={confirm ? "danger-on" : ""}
          aria-label={confirm ? "Confirm delete" : "Delete"}
          onClick={() => {
            if (!confirm) return setConfirm(true);
            setConfirm(false);
            bulk.remove();
          }}
        >
          <Trash2 size={15} />
          <span>{confirm ? "Confirm delete" : "Delete"}</span>
        </button>
        <button
          className="icon-only"
          aria-label="Clear selection"
          title="Clear selection (Esc)"
          onClick={clearPicks}
        >
          <X size={15} />
        </button>
      </div>
    </div>
  );
}
