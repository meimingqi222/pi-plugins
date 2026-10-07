import { z } from "zod";

export const workStatusSchema = z.object({
  kind: z.enum(["Subagent", "Workflow", "Bash", "Goal"]),
  id: z.string().min(1).max(100),
  title: z.string().max(240),
  status: z.enum(["running", "completed", "failed", "aborted", "exited", "timedout", "killed", "interrupted", "active", "paused", "verifying", "complete", "budget_limited", "blocked", "no_progress"]),
  description: z.string().max(240),
  activity: z.string().max(240),
  metric: z.string().max(240),
});

export type WorkStatus = z.output<typeof workStatusSchema>;

/** Only complete, bounded status messages are claimed; unrelated chat stays native. */
export function parseWorkStatus(text: string): WorkStatus | undefined {
  if (text.length > 1_200) return;
  const lines = text.split("\n");
  if (lines.length !== 5) return;
  const header = /^\[(Subagent|Workflow|Bash|Goal) ([A-Za-z0-9._:-]+)\] ([a-z_]+)$/u.exec(lines[0]!);
  if (!header) return;
  const result = workStatusSchema.safeParse({ kind: header[1], id: header[2], status: header[3], title: lines[1], description: lines[2], activity: lines[3], metric: lines[4] });
  return result.success ? result.data : undefined;
}
