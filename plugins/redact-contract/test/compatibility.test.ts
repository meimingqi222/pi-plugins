import { expect, test } from "bun:test";
import { isCompatibleRedactService } from "../src/index.ts";
import { installRedactBridge as goal } from "../../goal/src/redact.ts";
import { installRedactBridge as permissions } from "../../permissions/src/redact.ts";
import { installRedactBridge as jev } from "../../jev-compact/src/redact.ts";
import { installRedactBridge as morph } from "../../morph-search/src/redact.ts";
import { isRedactService as publisher } from "../../redact/src/service.ts";

function bus() {
  let handler: (value: unknown) => void = () => {};
  return { pi: { events: { on: (_: string, callback: typeof handler) => { handler = callback; }, emit: () => {} } } as never, announce: (value: unknown) => handler(value) };
}

test("all consumers negotiate the same v1 and v2 service shapes", () => {
  const methods = { redactJson: () => "redacted", redactString: (value: string) => value };
  const cases = [
    { value: { ...methods, version: 1 }, accepted: true },
    { value: { ...methods, version: 2, isEnabled: () => true, patternCount: 1 }, accepted: true },
    { value: { ...methods, version: 2 }, accepted: false },
    { value: { ...methods, version: 3, isEnabled: () => true }, accepted: false },
    { value: { version: 2, isEnabled: () => true }, accepted: false },
  ];
  for (const { value, accepted } of cases) {
    expect(isCompatibleRedactService(value)).toBe(accepted);
    const a = bus(); const get = goal(a.pi); a.announce(value); expect(!!get()).toBe(accepted);
    const b = bus(); const p = permissions(b.pi); b.announce(value); expect(!!p.service()).toBe(accepted);
    const c = bus(); const j = jev(c.pi); c.announce(value); expect(!!j.service()).toBe(accepted);
    const d = bus(); const m = morph(d.pi); d.announce(value); expect(m.redact<string>("original") === "redacted").toBe(accepted);
  }
  expect(publisher({ ...methods, version: 2, isEnabled: () => true, patternCount: 1 })).toBe(true);
  expect(publisher({ ...methods, version: 1 })).toBe(false);
});
