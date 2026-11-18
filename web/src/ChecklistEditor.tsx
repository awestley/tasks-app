import { useRef } from "react";
import { Plus, X } from "lucide-react";
import type { ChecklistItem } from "./api";

export function ChecklistEditor({
  items,
  onChange,
  locked = false,
}: {
  items: ChecklistItem[];
  onChange: (items: ChecklistItem[]) => void;
  locked?: boolean;
}) {
  const inputs = useRef(new Map<string, HTMLInputElement>());
  function add() {
    if (locked || items.length >= 100) return;
    const id = crypto.randomUUID();
    onChange([...items, { id, title: "", completed: false }]);
    requestAnimationFrame(() => inputs.current.get(id)?.focus());
  }
  function change(id: string, patch: Partial<ChecklistItem>) {
    onChange(
      items.map((item) => (item.id === id ? { ...item, ...patch } : item)),
    );
  }
  return (
    <section className="checklist-editor" aria-label="Task checklist">
      <div className="checklist-heading">
        <h3>Checklist</h3>
        <span>
          {items.filter((item) => item.completed).length}/{items.length}
        </span>
      </div>
      {items.map((item, index) => (
        <div className="checklist-item" key={item.id}>
          <input
            type="checkbox"
            checked={item.completed}
            disabled={locked}
            aria-label={`Complete checklist item ${index + 1}`}
            onChange={(e) => change(item.id, { completed: e.target.checked })}
          />
          <input
            ref={(input) => {
              if (input) inputs.current.set(item.id, input);
              else inputs.current.delete(item.id);
            }}
            type="text"
            aria-label={`Checklist item ${index + 1}`}
            placeholder="Item title"
            value={item.title}
            maxLength={500}
            required
            disabled={locked}
            className={item.completed ? "checked" : ""}
            onChange={(e) => change(item.id, { title: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                if (item.title.trim()) add();
              }
            }}
          />
          <button
            type="button"
            className="icon-button"
            aria-label={`Remove checklist item ${index + 1}`}
            disabled={locked}
            onClick={() =>
              onChange(items.filter((other) => other.id !== item.id))
            }
          >
            <X size={15} />
          </button>
        </div>
      ))}
      {locked ? (
        <p className="checklist-hint">
          Reopen this task to change its checklist.
        </p>
      ) : (
        <button
          type="button"
          className="add-checklist-item"
          disabled={items.length >= 100}
          onClick={add}
        >
          <Plus size={15} /> Add item
        </button>
      )}
    </section>
  );
}
