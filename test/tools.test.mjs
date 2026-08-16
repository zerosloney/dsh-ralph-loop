import { test } from "node:test";
import assert from "node:assert/strict";
import { registerRalphTools } from "../lib/tools.js";

function captureTool(run) {
  const registered = [];
  registerRalphTools({ tools: { register(tool) { registered.push(tool); } } }, {}, run);
  assert.equal(registered.length, 1);
  return registered[0];
}

function state(overrides = {}) {
  return {
    task: "task",
    files: { "small.txt": "ok" },
    testCmd: "npm test",
    executionOutput: { stdout: "ok", stderr: "", exitCode: 0 },
    reflection: "passed",
    lessonsLearned: ["keep it simple"],
    plan: "plan",
    isPassed: true,
    cycle: 1,
    ...overrides,
  };
}

test("run_ralph_loop bounds large fields and marks truncation/omission", async () => {
  const fullState = state({
    files: {
      "large.txt": "f".repeat(20_000),
      "second.txt": "s".repeat(50_000),
      "third.txt": "t".repeat(50_000),
    },
    executionOutput: {
      stdout: "o".repeat(10_000),
      stderr: "e".repeat(10_000),
      exitCode: 1,
    },
    plan: "p".repeat(10_000),
    reflection: "r".repeat(10_000),
    lessonsLearned: Array.from({ length: 40 }, (_, index) => `lesson-${index}-${"l".repeat(4_000)}`),
  });
  const before = structuredClone(fullState);
  const tool = captureTool(async () => fullState);

  const result = await tool.execute({ task: "task", test_cmd: "npm test" });

  assert.deepEqual(fullState, before, "tool projection must not mutate service state");
  assert.ok(Object.keys(result.files).length <= 32);
  assert.ok(Object.values(result.files).every((content) => content.length <= 16_000));
  assert.ok(
    Object.values(result.files).reduce((total, content) => total + content.length, 0) <= 64_000,
  );
  assert.ok(Object.values(result.files).some((content) => content.includes("originalLength=20000")));

  assert.ok(result.plan.length <= 8_000);
  assert.match(result.plan, /originalLength=10000/);
  assert.ok(result.reflection.length <= 8_000);
  assert.match(result.reflection, /originalLength=10000/);
  assert.ok(result.lessonsLearned.length <= 32);
  assert.ok(result.lessonsLearned.every((lesson) => lesson.length <= 4_000));
  assert.ok(
    result.lessonsLearned.reduce((total, lesson) => total + lesson.length, 0) <= 32_000,
  );
  assert.ok(result.lessonsLearned.some((lesson) => lesson.includes("omitted lessons")));
  assert.ok(result.executionOutput.stdout.length <= 8_000);
  assert.ok(result.executionOutput.stderr.length <= 8_000);
  assert.match(result.executionOutput.stdout, /originalLength=10000/);
  assert.match(result.executionOutput.stderr, /originalLength=10000/);
});

test("run_ralph_loop marks exact file-count omission and preserves JSON shape", async () => {
  const files = Object.fromEntries(
    Array.from({ length: 40 }, (_, index) => [`file-${index}.txt`, `file-${index}`]),
  );
  const fullState = state({ files });
  const tool = captureTool(async () => fullState);
  const result = await tool.execute({ task: "task", test_cmd: "npm test" });

  assert.equal(typeof result.files, "object");
  assert.equal(Object.keys(result.files).length, 32);
  const marker = Object.values(result.files).find((content) => content.includes("omitted files"));
  assert.ok(marker);
  assert.match(marker, /originalCount=40/);
  assert.match(marker, /omittedCount=9/);
});

test("run_ralph_loop leaves bounded values and input unchanged when no limit applies", async () => {
  const fullState = state();
  const tool = captureTool(async () => fullState);
  const result = await tool.execute({ task: "task", test_cmd: "npm test" });

  assert.deepEqual(result, fullState);
  assert.notStrictEqual(result.files, fullState.files);
  assert.notStrictEqual(result.lessonsLearned, fullState.lessonsLearned);
  assert.deepEqual(fullState, state());
});

test("run_ralph_loop forwards the tool execution signal to the runner", async () => {
  const controller = new AbortController();
  let receivedSignal;
  const tool = captureTool(async (params) => {
    receivedSignal = params.signal;
    return state();
  });

  await tool.execute(
    { task: "task", test_cmd: "npm test" },
    { signal: controller.signal },
  );

  assert.strictEqual(receivedSignal, controller.signal);
});
