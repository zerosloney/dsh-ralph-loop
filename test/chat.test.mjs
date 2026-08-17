import { test } from "node:test";
import assert from "node:assert/strict";
import { chatJson, chatText } from "../lib/chat.js";

function stream(text, finishKind) {
  return (async function* () {
    yield { type: "text-delta", index: 0, text };
    yield { type: "finish", reason: { kind: finishKind } };
  })();
}

function ctx(text, finishKind) {
  return { llm: { stream: () => stream(text, finishKind) } };
}

test("chatText marks max-tokens truncation in the returned text", async () => {
  const text = await chatText(
    ctx('{"result.txt": "ab', "max-tokens"),
    { provider: "test", model: "test", prompt: "p" },
  );

  assert.ok(text.startsWith('{"result.txt": "ab'));
  assert.ok(text.includes("truncated by the max-tokens cap"));
});

test("chatJson reports max-tokens truncation distinctly from malformed JSON", async () => {
  await assert.rejects(
    () => chatJson(ctx('{"result.txt": "ab', "max-tokens"), { provider: "test", model: "test", prompt: "p" }),
    /truncated by the max-tokens cap/,
  );
});

test("chatJson parses complete JSON even when the finish says max-tokens", async () => {
  // 上限恰好命中在收尾处：JSON 本身完整，标记不得造成假失败。
  const parsed = await chatJson(
    ctx('{"result.txt": "ok"}', "max-tokens"),
    { provider: "test", model: "test", prompt: "p" },
  );

  assert.deepEqual(parsed, { "result.txt": "ok" });
});

test("chatJson retries a transient error finish once", async () => {
  let calls = 0;
  const harness = {
    llm: {
      stream() {
        calls += 1;
        if (calls !== 1) return stream('{"ok": 1}', "stop");
        return (async function* () {
          yield { type: "text-delta", index: 0, text: "partial" };
          yield {
            type: "finish",
            reason: { kind: "error", failure: { code: "TEMP", message: "temporary" } },
          };
        })();
      },
    },
  };

  const parsed = await chatJson(
    harness,
    { provider: "test", model: "test", prompt: "p" },
    1,
  );

  assert.deepEqual(parsed, { ok: 1 });
  assert.equal(calls, 2);
});

test("chatJson does not retry a max-tokens truncation", async () => {
  let calls = 0;
  const harness = {
    llm: {
      stream() {
        calls += 1;
        return stream('{"result.txt": "ab', "max-tokens");
      },
    },
  };

  await assert.rejects(
    () => chatJson(harness, { provider: "test", model: "test", prompt: "p" }, 1),
    /truncated by the max-tokens cap/,
  );
  assert.equal(calls, 1);
});
