import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface HostWork {
  kind: "subagent" | "workflow" | "bash" | "goal";
  id: string;
  title: string;
  status: string;
  description: string;
  activity?: string;
  metric?: string;
}

export interface HostWorkContext {
  mode?: string;
  ui?: { notify(message: string, type?: "info" | "warning" | "error"): void };
}

const labels: Record<HostWork["kind"], string> = { subagent: "Subagent", workflow: "Workflow", bash: "Bash", goal: "Goal" };

function field(text: string, limit = 240): string {
  return text.replace(/[\x00-\x1f\x7f-\x9f]/gu, " ").replace(/\s+/gu, " ").trim().slice(0, limit);
}

/** Plain text remains useful when a host has no custom renderer. Five fixed lines are version 1. */
export function formatHostWork(work: HostWork): string {
  return [`[${labels[work.kind]} ${field(work.id, 100)}] ${field(work.status, 40)}`, field(work.title), field(work.description), field(work.activity ?? ""), field(work.metric ?? "")].join("\n");
}

interface Pending {
  work: HostWork;
  ctx: HostWorkContext;
  content: string;
  last?: string;
  nextAt: number;
  timer?: ReturnType<typeof setTimeout>;
}

export interface HostWorkReporter {
  publish(work: HostWork, ctx: HostWorkContext): void;
  clear(): void;
}

export function createHostWorkReporter(
  pi: Pick<ExtensionAPI, "sendMessage">,
  options: { intervalMs?: number; transport?: "message" | "notify" } = {},
): HostWorkReporter {
  const records = new Map<string, Pending>();
  const interval = options.intervalMs ?? 2_000;

  function flush(pending: Pending): void {
    pending.timer = undefined;
    if (pending.last === pending.content) return;
    const transport = options.transport ?? (process.env.PI_RPC_PROGRESS_TRANSPORT === "notify" ? "notify" : "message");
    try {
      if (transport === "notify" && pending.ctx.ui) {
        pending.ctx.ui.notify(pending.content, pending.work.status === "failed" ? "warning" : "info");
      } else {
        pi.sendMessage({ customType: "pi-work-status", content: pending.content, display: true, details: { version: 1, ...pending.work } }, { triggerTurn: false });
      }
      pending.last = pending.content;
      pending.nextAt = Date.now() + interval;
    } catch { /* Progress cannot fail execution; the next change retries. */ }
  }

  return {
    publish(work: HostWork, ctx: HostWorkContext): void {
      if (ctx.mode !== "rpc") return;
      const key = `${work.kind}:${work.id}`;
      let pending = records.get(key);
      if (!pending) {
        pending = { work, ctx, content: "", nextAt: 0 };
        records.set(key, pending);
      }
      pending.work = { ...work };
      pending.ctx = ctx;
      pending.content = formatHostWork(work);
      if (pending.last === pending.content && !pending.timer) return;
      const active = ["running", "active", "verifying"].includes(work.status);
      if (!active || pending.nextAt <= Date.now()) {
        if (pending.timer) clearTimeout(pending.timer);
        flush(pending);
      } else if (!pending.timer) {
        pending.timer = setTimeout(() => flush(pending!), pending.nextAt - Date.now());
        pending.timer.unref?.();
      }
    },
    clear(): void {
      for (const pending of records.values()) if (pending.timer) clearTimeout(pending.timer);
      records.clear();
    },
  };
}
