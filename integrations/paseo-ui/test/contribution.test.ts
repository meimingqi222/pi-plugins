import { expect, mock, test } from "bun:test";

/**
 * Paseo's app client validates every transformer target against a closed
 * allowlist and throws on anything else, which fails the whole client
 * contribution. The list below mirrors `TIMELINE_ITEM_TYPES` in
 * `packages/app/src/plugins/evaluate.ts`; it is the oracle this test pins
 * against, so re-verify it against the installed app before widening it.
 */
const HOST_ITEM_TYPES = new Set([
  "user_message",
  "assistant_message",
  "reasoning",
  "tool_call",
  "todo",
  "error",
  "compaction",
]);

mock.module("react-native", () => ({ View: () => null, Text: () => null, Pressable: () => null, ScrollView: () => null, Switch: () => null }));
mock.module("@getpaseo/plugin/client/react-native", () => ({ Icon: () => null }));
const { default: contribute } = await import("../index.client.tsx");

/** Mirrors the app's contribution host: rejects unknown targets, records the rest. */
function fakeHost() {
  const targets: string[] = [];
  const renderers: string[] = [];
  const screens: string[] = [];
  let render: ((props: never) => { props: { onOpen?: () => void } }) | undefined;
  const opened: unknown[] = [];
  const client = {
    addScreen(contribution: { id: string }) { screens.push(contribution.id); return () => {}; },
    openScreen(input: unknown) { opened.push(input); },
    addTimelineTransformer(contribution: { id: string; query: { itemType: string } }) {
      if (!HOST_ITEM_TYPES.has(contribution.query.itemType)) {
        throw new Error(`Timeline transformer ${contribution.id} has invalid item type: ${contribution.query.itemType}`);
      }
      targets.push(`${contribution.id}:${contribution.query.itemType}`);
      return () => {};
    },
    addTimelineRenderer(contribution: { kind: string; version: number; Component: typeof render }) {
      render = contribution.Component;
      renderers.push(`${contribution.kind}/${contribution.version}`);
      return () => {};
    },
  };
  return { client, targets, renderers, screens, opened, render: (props: unknown) => render!(props as never) };
}

test("the Paseo app client accepts every timeline transformer this companion registers", () => {
  const host = fakeHost();
  expect(() => contribute(host.client as never)).not.toThrow();
  expect(host.targets).toEqual(["pi-work-message:assistant_message", "pi-work-status-row:tool_call", "pi-task-inspection:tool_call"]);
  expect(host.renderers).toEqual(["pi-work-status/1"]);
  expect(host.screens).toEqual(["subagent-output"]);
});

test("clicking a live card opens the plugin screen with its log and parent conversation", () => {
  const host = fakeHost();
  contribute(host.client as never);
  const liveLog = "session-sa001.jsonl";
  host.render({ item: { data: { liveLog, id: "call", title: "Explore" } }, agentId: "parent" }).props.onOpen!();
  expect(host.opened).toEqual([{ screenId: "subagent-output", params: { log: liveLog, id: "call", title: "Explore", agentId: "parent" } }]);
  expect(host.render({ item: { data: { id: "old" } }, agentId: "parent" }).props.onOpen).toBeUndefined();
});
