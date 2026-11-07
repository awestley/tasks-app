import { useState } from "react";
import { X } from "lucide-react";
import type { Project } from "./api";
import { Modal } from "./Modal";

export function ProjectEditor({
  project,
  busy,
  close,
  save,
  remove,
}: {
  project: Project | null;
  busy: boolean;
  close: () => void;
  save: (name: string, color: string) => void;
  remove?: () => void;
}) {
  const [name, setName] = useState(project?.name || ""),
    [color, setColor] = useState(project?.color || "#2563eb"),
    [confirm, setConfirm] = useState(false);
  return (
    <Modal close={close} label="Project editor">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save(name, color);
        }}
      >
        <div className="modal-heading">
          <h2>{project ? "Edit project" : "New project"}</h2>
          <button
            type="button"
            className="icon-button"
            onClick={close}
            aria-label="Close project editor"
          >
            <X />
          </button>
        </div>
        <label className="field-label">
          Project name
          <input
            required
            maxLength={100}
            placeholder="Project name"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label className="field-label">
          Project color
          <input
            type="color"
            value={color}
            onChange={(e) => setColor(e.target.value)}
          />
        </label>
        {confirm && (
          <p className="muted">Tasks in this project will move to Inbox.</p>
        )}
        <div className="modal-actions">
          {remove && (
            <button
              type="button"
              className={`danger-button ${confirm ? "mod-cta" : ""}`}
              disabled={busy}
              onClick={() => (confirm ? remove() : setConfirm(true))}
            >
              {confirm ? "Confirm delete" : "Delete project"}
            </button>
          )}
          <span />
          <button type="button" className="secondary" onClick={close}>
            Cancel
          </button>
          <button className="primary" disabled={busy || !name.trim()}>
            Save project
          </button>
        </div>
      </form>
    </Modal>
  );
}
