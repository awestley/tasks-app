// Embeds for other apps (app contract, section 5): <tasks-task> and <tasks-project>.
// Hosts don't use these tags directly; they write <pc-embed ref="pc://tasks/task/…">, which loads this
// module from the manifest's embedModule and creates the right element in its shadow root.
//
// Styled only with Glassive custom properties, which inherit through shadow DOM from the host page,
// so an embedded task matches the note around it. Content is set with textContent only.
// Plain DOM, no React: this module is loaded into other apps' pages and should stay small.
import { dueLabel, localDate } from "./due";

type Task = {
  id: string;
  title: string;
  project_id: string | null;
  due_date: string | null;
  due_time: string | null;
  priority: number;
  checklist: { completed: boolean }[];
  completed: boolean;
  version: number;
};
type Project = { id: string; name: string; color: string };

// The API sits next to this module (…/apps/tasks/embed.js → …/apps/tasks/api/v1/).
const API = new URL(/* @vite-ignore */ "./api/v1/", import.meta.url).href;

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(API + path, {
    credentials: "same-origin",
    ...init,
    headers: init?.body ? { "Content-Type": "application/json" } : {},
  });
  if (!response.ok)
    throw Object.assign(new Error(String(response.status)), {
      status: response.status,
    });
  return response.json();
}

// One change stream per page, shared by every embed on it.
const watchers = new Map<string, Set<() => void>>();
let source: EventSource | null = null;
function watch(ref: string, reload: () => void) {
  if (!watchers.has(ref)) watchers.set(ref, new Set());
  watchers.get(ref)!.add(reload);
  if (!source && typeof EventSource !== "undefined") {
    source = new EventSource(API + "events");
    source.onmessage = (event) => {
      let ref = "";
      try {
        ref = JSON.parse(event.data).ref;
      } catch {
        return;
      }
      if (ref.startsWith("pc://tasks/project/")) projects = null;
      watchers.get(ref)?.forEach((fn) => fn());
      // A task changing changes its project's counts too.
      if (ref.startsWith("pc://tasks/task/"))
        for (const [key, fns] of watchers)
          if (key.startsWith("pc://tasks/project/")) fns.forEach((fn) => fn());
    };
  }
  return () => {
    watchers.get(ref)?.delete(reload);
    if (!watchers.get(ref)?.size) watchers.delete(ref);
    if (!watchers.size && source) {
      source.close();
      source = null;
    }
  };
}

let projects: Promise<Project[]> | null = null;
const loadProjects = () => {
  projects ??= call<Project[]>("projects").catch(() => {
    projects = null;
    return [];
  });
  return projects;
};

// Embeds read as part of the host's text, like an embedded note in Glassive: the host's font and size,
// task lines like a Markdown task list, and a card set off by the same 2px accent rule as a quote.
const SHEET = `
  :host { display: block; font: inherit; color: var(--text-normal); }
  :host([size="inline"]) { display: inline; }
  .card { display: flex; gap: 0.5em; align-items: flex-start; margin: 0.2em 0 0.8em;
    padding-inline-start: 20px; border-inline-start: 2px solid var(--color-accent); }
  :host([size="inline"]) .card { display: inline-flex; align-items: baseline; gap: 0.35em; margin: 0; padding: 0; border: 0; }
  .main { flex: 1; min-width: 0; display: grid; gap: 0.1em; }
  .title { all: unset; cursor: pointer; overflow-wrap: anywhere; }
  .title:hover { color: var(--text-accent-hover); text-decoration: underline; }
  .title:focus-visible { outline: 2px solid var(--background-modifier-border-focus); outline-offset: 2px; border-radius: 4px; }
  .done .title, li.done .title { color: var(--text-muted); text-decoration: line-through; }
  .meta { color: var(--text-muted); font-size: 0.8em; display: flex; gap: 0.75em; flex-wrap: wrap; }
  :host([size="inline"]) .meta { display: none; }
  .overdue { color: var(--text-error); }
  /* Centred on the first line of text, whatever the host's font size. */
  .check { flex: none; width: 0.8em; height: 0.8em; margin: calc((1lh - 0.8em) / 2) 0 0; accent-color: var(--interactive-accent); cursor: pointer; }
  :host([size="inline"]) .check { margin: 0; align-self: center; }
  .hash { font-weight: 600; }
  ul { list-style: none; margin: 0.3em 0 0; padding: 0; display: grid; gap: 0.15em; }
  li { display: flex; gap: 0.5em; align-items: flex-start; }
  .muted { color: var(--text-muted); }
`;

function el<T extends HTMLElement = HTMLElement>(
  tag: string,
  props: Record<string, unknown> = {},
  ...children: (Node | string)[]
): T {
  const node = Object.assign(document.createElement(tag), props) as T;
  node.append(...children);
  return node;
}

abstract class Embed extends HTMLElement {
  static observedAttributes = ["ref", "size"];
  protected stop: (() => void) | null = null;
  connectedCallback() {
    if (!this.shadowRoot) this.attachShadow({ mode: "open" });
    this.subscribe();
    this.load();
  }
  disconnectedCallback() {
    this.stop?.();
    this.stop = null;
  }
  attributeChangedCallback(name: string) {
    if (!this.shadowRoot) return;
    if (name === "ref") this.subscribe();
    this.load();
  }
  private subscribe() {
    this.stop?.();
    const ref = this.getAttribute("ref") || "";
    this.stop = ref ? watch(ref, () => this.load()) : null;
  }
  protected abstract kind: string;
  protected get itemId() {
    const match = new RegExp(`^pc://tasks/${this.kind}/([^/?#]+)$`).exec(
      this.getAttribute("ref") || "",
    );
    try {
      return match ? decodeURIComponent(match[1]) : null;
    } catch {
      return null;
    }
  }
  protected abstract load(): Promise<void>;
  protected paint(...nodes: Node[]) {
    this.shadowRoot!.replaceChildren(
      el("style", { textContent: SHEET }),
      ...nodes,
    );
  }
  protected missing(text: string) {
    this.paint(
      el(
        "div",
        { className: "card" },
        el("span", { className: "muted", textContent: text }),
      ),
    );
  }
  /** Ask the shell to open this item in a new column (<pc-embed> passes the event on). */
  protected open(ref = this.getAttribute("ref")) {
    this.dispatchEvent(
      new CustomEvent("pc-open", {
        bubbles: true,
        composed: true,
        detail: { ref },
      }),
    );
  }
  protected checkbox(task: Task, done: (next: Task) => void) {
    const check = el<HTMLInputElement>("input", {
      type: "checkbox",
      className: "check",
      checked: task.completed,
      title: task.completed ? "Mark as not done" : "Complete",
    });
    check.setAttribute(
      "aria-label",
      `${task.completed ? "Restore" : "Complete"} ${task.title}`,
    );
    check.addEventListener("change", async () => {
      check.disabled = true;
      try {
        done(
          await call<Task>(`tasks/${encodeURIComponent(task.id)}`, {
            method: "PATCH",
            body: JSON.stringify({
              version: task.version,
              completed: check.checked,
            }),
          }),
        );
      } catch {
        // 409: it changed elsewhere. Show the current state; the person can try again.
        this.load();
      }
    });
    return check;
  }
}

class TaskEmbed extends Embed {
  protected kind = "task";
  protected async load() {
    const id = this.itemId;
    if (!id) return this.missing("Not a task reference");
    try {
      const [task, list] = await Promise.all([
        call<Task>(`tasks/${encodeURIComponent(id)}`),
        loadProjects(),
      ]);
      this.render(task, list);
    } catch (error) {
      this.missing(
        (error as { status?: number }).status === 404
          ? "Task not found"
          : "Task unavailable",
      );
    }
  }
  private render(task: Task, list: Project[]) {
    const title = el("button", {
      className: "title",
      textContent: task.title,
      type: "button",
    });
    title.addEventListener("click", () => this.open());
    const meta = el("div", { className: "meta" });
    const due = dueLabel(task);
    if (due)
      meta.append(
        el("span", {
          textContent: due,
          className:
            !task.completed && task.due_date! < localDate() ? "overdue" : "",
        }),
      );
    const project = list.find((p) => p.id === task.project_id);
    meta.append(
      el(
        "span",
        {},
        el("span", { className: "hash", textContent: "# " }),
        project?.name || "Inbox",
      ),
    );
    if (project)
      (meta.lastChild as HTMLElement)
        .querySelector(".hash")!
        .setAttribute("style", `color: ${project.color}`);
    if (task.checklist.length)
      meta.append(
        el("span", {
          textContent: `${task.checklist.filter((i) => i.completed).length}/${task.checklist.length}`,
        }),
      );
    const card = el(
      "div",
      { className: `card${task.completed ? " done" : ""}` },
      this.checkbox(task, (next) => this.render(next, list)),
      el("div", { className: "main" }, title, meta),
    );
    this.paint(card);
  }
}

class ProjectEmbed extends Embed {
  protected kind = "project";
  protected async load() {
    const id = this.itemId;
    if (!id) return this.missing("Not a project reference");
    try {
      const [project, open] = await Promise.all([
        call<Project>(`projects/${encodeURIComponent(id)}`),
        call<Task[]>(
          `tasks?project_id=${encodeURIComponent(id)}&completed=false&limit=200`,
        ),
      ]);
      this.render(project, open);
    } catch (error) {
      this.missing(
        (error as { status?: number }).status === 404
          ? "Project not found"
          : "Project unavailable",
      );
    }
  }
  private render(project: Project, open: Task[]) {
    const name = el(
      "button",
      { className: "title", type: "button" },
      el("span", { className: "hash", textContent: "# " }),
      project.name,
    );
    (name.firstChild as HTMLElement).setAttribute(
      "style",
      `color: ${project.color}`,
    );
    name.addEventListener("click", () => this.open());
    const count = el("div", {
      className: "meta",
      textContent: `${open.length} open task${open.length === 1 ? "" : "s"}`,
    });
    const main = el("div", { className: "main" }, name, count);
    if (this.getAttribute("size") === "card" && open.length) {
      const items = el("ul");
      for (const task of open.slice(0, 5)) {
        const title = el("button", {
          className: "title",
          textContent: task.title,
          type: "button",
        });
        title.addEventListener("click", () =>
          this.open(`pc://tasks/task/${task.id}`),
        );
        items.append(
          el(
            "li",
            {},
            this.checkbox(task, () => this.load()),
            title,
          ),
        );
      }
      if (open.length > 5)
        items.append(
          el("li", {
            className: "muted",
            textContent: `and ${open.length - 5} more`,
          }),
        );
      main.append(items);
    }
    this.paint(el("div", { className: "card" }, main));
  }
}

if (!customElements.get("tasks-task"))
  customElements.define("tasks-task", TaskEmbed);
if (!customElements.get("tasks-project"))
  customElements.define("tasks-project", ProjectEmbed);
