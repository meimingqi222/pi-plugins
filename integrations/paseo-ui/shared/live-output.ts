import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { liveLogSchema } from "./work-status.ts";

export const liveOutputSchema = z.object({
  state: z.enum(["waiting", "available"]),
  revision: z.string(),
  prompt: z.string().optional(),
  promptTruncated: z.boolean().optional(),
  earlierDataOmitted: z.boolean(),
  totalBlocks: z.number().optional(),
  blocks: z.array(z.object({
    id: z.string().min(1),
    kind: z.enum(["assistant", "thinking", "tool", "error", "note"]),
    text: z.string(), name: z.string().optional(), live: z.boolean().optional(),
    result: z.string().optional(), isError: z.boolean().optional(),
  })),
});
export type LiveOutput = z.output<typeof liveOutputSchema>;
export const liveOutputRpc = defineRpc({ name: "subagent-live-output", input: z.object({ log: liveLogSchema, all: z.boolean().optional() }), output: liveOutputSchema });
