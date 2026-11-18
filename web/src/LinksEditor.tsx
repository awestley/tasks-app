import { useEffect, useState } from "react";
import { Link2, Plus, X } from "lucide-react";
import { api, type Link } from "./api";

// Links save as soon as they are added or removed, separately from the task's other fields.
export function LinksEditor({ owner }: { owner: string }) {
  const [links, setLinks] = useState<Link[] | null>(null);
  const [target, setTarget] = useState("");
  const [title, setTitle] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let cancelled = false;
    api<Link[]>(`${owner}/links`)
      .then((value) => !cancelled && setLinks(value))
      .catch((e) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [owner]);
  async function add() {
    const value = target.trim();
    if (!value || busy) return;
    setBusy(true);
    setError("");
    try {
      const body = value.startsWith("pc://")
        ? { ref: value, title: title.trim() }
        : { url: value, title: title.trim() };
      const link = await api<Link>(`${owner}/links`, "POST", body);
      setLinks((current) => [
        ...(current || []).filter((item) => item.id !== link.id),
        link,
      ]);
      setTarget("");
      setTitle("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function remove(link: Link) {
    setError("");
    try {
      await api(`${owner}/links/${link.id}`, "DELETE");
      setLinks((current) => (current || []).filter((l) => l.id !== link.id));
    } catch (e) {
      setError((e as Error).message);
    }
  }
  const enter = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      add();
    }
  };
  return (
    <section className="checklist-editor links-editor" aria-label="Links">
      <div className="checklist-heading">
        <h3>Links</h3>
        <span>{links?.length ?? ""}</span>
      </div>
      {links?.map((link) => (
        <div className="checklist-item link-item" key={link.id}>
          <Link2 size={15} aria-hidden="true" />
          {link.url ? (
            <a href={link.url} target="_blank" rel="noreferrer noopener">
              {link.title}
            </a>
          ) : (
            <span title={link.ref || ""}>{link.title}</span>
          )}
          <button
            type="button"
            className="icon-button"
            aria-label={`Remove link ${link.title}`}
            onClick={() => remove(link)}
          >
            <X size={15} />
          </button>
        </div>
      ))}
      <div className="checklist-item link-new">
        <input
          type="text"
          aria-label="Link address"
          placeholder="Note or web address"
          value={target}
          maxLength={2000}
          onChange={(e) => setTarget(e.target.value)}
          onKeyDown={enter}
        />
        <input
          type="text"
          aria-label="Link title"
          placeholder="Title"
          value={title}
          maxLength={200}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={enter}
        />
        <button
          type="button"
          className="icon-button"
          aria-label="Add link"
          disabled={busy || !target.trim()}
          onClick={add}
        >
          <Plus size={15} />
        </button>
      </div>
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
