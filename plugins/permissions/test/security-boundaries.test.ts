import { expect, test } from "bun:test";
import { classifyToolCall } from "../src/classify.ts";
import { decide } from "../src/decide.ts";
import { envMac } from "./envs.ts";
const env = envMac();
function verdict(command: string, mode: "yolo" | "ask" = "ask") {
  const classification = classifyToolCall("bash", { command }, { env, shellDialect: "bash" });
  return { tier: classification.tier, action: decide(classification, mode, [], env).action };
}
test("HOME expansion cannot bypass root or credential rules", () => {
  for (const target of ['"$HOME"', '${HOME}/', '"${HOME}/"']) {
    expect(verdict(`rm -rf ${target}`)).toEqual({ tier: "forbidden", action: "deny" });
  }
  for (const target of ['"$HOME/.ssh/id_rsa"', '"${HOME}/.ssh/id_rsa"']) {
    expect(verdict(`cat ${target}`)).toEqual({ tier: "dangerous", action: "ask" });
  }
  expect(verdict('cat "${HOME}/project/readme.txt"').action).toBe("allow");
  expect(verdict("rm -rf '$HOME'", "yolo").action).toBe("allow");
});
test("unresolved path reads and recursive deletes ask in guarded modes", () => {
  for (const command of ['cat "$SECRET_FILE"', 'rm -rf "$TARGET"', 'echo / | xargs rm -rf']) {
    expect(verdict(command)).toEqual({ tier: "dangerous", action: "ask" });
  }
});
test("all grep-family tools ask before searching credential roots", () => {
  for (const tool of ['grep', 'rg', 'egrep', 'fgrep', '/usr/bin/rg']) {
    expect(verdict(`${tool} credential ~`)).toEqual({ tier: "dangerous", action: "ask" });
    expect(verdict(`${tool} credential src`).action).toBe("allow");
  }
});
test("find deletion checks filesystem boundaries and outside targets", () => {
  expect(verdict('find / -delete')).toEqual({ tier: "forbidden", action: "deny" });
  expect(verdict('find ~ -delete').action).toBe("deny");
  expect(verdict('find /other -delete').action).toBe("ask");
  expect(verdict('find "$ROOT" -delete').action).toBe("ask");
});
