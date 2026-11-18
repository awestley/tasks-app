import { useEffect, useState } from "react";
import { Sparkles } from "lucide-react";
import { api } from "./api";

type AgentAction = {
  server: string;
  tool: string;
  input: string;
  ok: boolean;
  result: string;
};
type AgentRun = {
  id: string;
  status: "queued" | "running" | "done" | "failed";
  instruction: string;
  summary: string;
  actions: AgentAction[];
  error: string | null;
};

let availability: Promise<{ available: boolean; servers: string[] }> | null =
  null;

// Asks the server's agent to work on this task, then shows what it changed.
export function AgentPanel({
  taskId,
  changed,
}: {
  taskId: string;
  changed: () => void;
}) {
  const [config, setConfig] = useState<{ servers: string[] } | null>(null);
  const [run, setRun] = useState<AgentRun | null>(null);
  const [instruction, setInstruction] = useState("");
  const [error, setError] = useState("");
  const active = run?.status === "queued" || run?.status === "running";
  useEffect(() => {
    availability ??= api<{ available: boolean; servers: string[] }>("/agent");
    availability
      .then((value) => {
        if (!value.available) return;
        setConfig(value);
        return api<AgentRun[]>(`/tasks/${taskId}/agent-runs`).then((runs) =>
          setRun(runs[0] || null),
        );
      })
      .catch(() => {});
  }, [taskId]);
  useEffect(() => {
    if (!active || !run) return;
    const timer = setInterval(async () => {
      try {
        const next = await api<AgentRun>(`/agent-runs/${run.id}`);
        setRun(next);
        if (next.status === "done") changed();
      } catch (e) {
        setError((e as Error).message);
      }
    }, 2000);
    return () => clearInterval(timer);
  }, [active, run, changed]);
  if (!config) return null;
  async function start() {
    setError("");
    try {
      setRun(
        await api<AgentRun>(`/tasks/${taskId}/agent-runs`, "POST", {
          instruction: instruction.trim(),
        }),
      );
      setInstruction("");
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <section className="checklist-editor agent-panel" aria-label="Agent">
      <div className="checklist-heading">
        <h3>Flesh out</h3>
        <span>
          {config.servers.length ? `Uses ${config.servers.join(", ")}` : ""}
        </span>
      </div>
      <div className="checklist-item">
        <input
          type="text"
          aria-label="Instruction for the agent"
          placeholder="Optional instruction"
          value={instruction}
          maxLength={2000}
          disabled={active}
          onChange={(e) => setInstruction(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              if (!active) start();
            }
          }}
        />
        <button
          type="button"
          className="secondary"
          disabled={active}
          onClick={start}
        >
          <Sparkles size={15} /> {active ? "Working..." : "Flesh out"}
        </button>
      </div>
      {run && !active && (
        <div className="agent-result" role="status">
          {run.status === "failed" && <p className="error-text">{run.error}</p>}
          {run.summary && <p className="agent-summary">{run.summary}</p>}
          {run.actions.length > 0 && (
            <details>
              <summary>{run.actions.length} steps</summary>
              <ol>
                {run.actions.map((action, index) => (
                  <li key={index} className={action.ok ? "" : "error-text"}>
                    {action.server}: {action.tool}
                  </li>
                ))}
              </ol>
            </details>
          )}
        </div>
      )}
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
