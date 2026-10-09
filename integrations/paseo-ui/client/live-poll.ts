import type { LiveOutput } from "../shared/live-output.ts";

/** One request at a time; navigation invalidates even a request already in flight. */
export function pollLiveOutput(read: () => Promise<LiveOutput>, update: (value: LiveOutput) => void, failed: (error: unknown) => void, interval = 750): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  async function tick() {
    try {
      const value = await read();
      if (!stopped) update(value);
    } catch (error) { if (!stopped) failed(error); }
    finally { if (!stopped) timer = setTimeout(tick, interval); }
  }
  void tick();
  return () => { stopped = true; clearTimeout(timer); };
}
