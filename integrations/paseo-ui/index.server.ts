import type { PluginServerContext } from "@getpaseo/plugin/server";
import { liveOutputRpc } from "./shared/live-output.ts";
import { readLiveOutput } from "./server/live-output.ts";

export default function contribute(server: PluginServerContext) {
  server.handle(liveOutputRpc, input => readLiveOutput(input));
  return () => {};
}
