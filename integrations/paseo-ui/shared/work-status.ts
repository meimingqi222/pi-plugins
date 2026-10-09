import { z } from "zod";

// Only raw execution evidence names, never host-session files or arbitrary paths.
export const liveLogSchema = z.string().max(220).regex(/^[A-Za-z0-9._-]+-sa(?:[0-9]+|-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\.jsonl$/u);

export const workStatusSchema = z.object({
  kind: z.enum(["Subagent", "Workflow", "Bash", "Goal"]),
  id: z.string().min(1).max(100),
  title: z.string().max(240),
  status: z.enum(["running", "completed", "failed", "aborted", "exited", "timedout", "killed", "interrupted", "active", "paused", "verifying", "complete", "budget_limited", "blocked", "no_progress"]),
  description: z.string().max(240),
  activity: z.string().max(240),
  metric: z.string().max(240),
  liveLog: liveLogSchema.optional(),
});

export type WorkStatus = z.output<typeof workStatusSchema>;

/** Only complete, bounded status messages are claimed; unrelated chat stays native. */
export function parseWorkStatus(text: string): WorkStatus | undefined {
  if (text.length > 1_500) return;
  const lines = text.split("\n");
  if (lines.length !== 5 && lines.length !== 6) return;
  const reference = lines.length === 6 ? /^\[Pi transcript: ([^\]]+)\]$/u.exec(lines[5]!) : undefined;
  if (lines.length === 6 && !reference) return;
  const header = /^\[(Subagent|Workflow|Bash|Goal) ([A-Za-z0-9._:-]+)\] ([a-z_]+)$/u.exec(lines[0]!);
  if (!header) return;
  if (reference && header[1] !== "Subagent") return;
  const result = workStatusSchema.safeParse({ kind: header[1], id: header[2], status: header[3], title: lines[1], description: lines[2], activity: lines[3], metric: lines[4], ...(reference ? { liveLog: reference[1] } : {}) });
  return result.success ? result.data : undefined;
}
