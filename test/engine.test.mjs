import { test } from "node:test";
import assert from "node:assert/strict";
import { runRalphLoop } from "../lib/engine.js";

function promptText(options) {
  const blocks = options?.messages?.[0]?.content;
  if (!Array.isArray(blocks)) return "";
  return blocks
    .filter((block) => block?.type === "text")
    .map((block) => block.text)
    .join("");
}

/** llm.stream 按调用次序脚本化：第 i 次调用返回 scripts[i] 的完整文本流。 */
function scriptedHarness(scripts) {
  const events = [];
  const prompts = [];
  let calls = 0;
  return {
    events,
    prompts,
    ctx: {
      llm: {
        stream(options) {
          const text = scripts[Math.min(calls, scripts.length - 1)];
          calls += 1;
          prompts.push(promptText(options));
          return (async function* () {
            yield { type: "text-delta", index: 0, text };
            yield { type: "finish", reason: { kind: "stop" } };
          })();
        },
      },
      emit(name, payload) {
        events.push({ name, payload });
      },
      logger: { info() {} },
    },
  };
}

/** 沙箱 fake：runBash 依次返回脚本化退出码，记录写入的文件。 */
function scriptSandbox(exitCodes) {
  let runBashCalls = 0;
  const writtenFiles = [];
  return {
    get runBashCalls() {
      return runBashCalls;
    },
    writtenFiles,
    hasWritten(filePath) {
      return writtenFiles.includes(filePath);
    },
    async writeFile(filePath) {
      writtenFiles.push(filePath);
    },
    async runBash() {
      const exitCode = exitCodes[Math.min(runBashCalls, exitCodes.length - 1)];
      runBashCalls += 1;
      return { stdout: "", stderr: "", exitCode };
    },
  };
}

test("形状错误的 codegen 作为失败周期自愈：反馈进入 Reflect/Learn，下一轮通过", async () => {
  const harness = scriptedHarness([
    "plan-1",
    '{"result.txt": {"content": "nested value"}}',
    "reflection-1",
    "lesson-1",
    "plan-2",
    '{"result.txt": "ok"}',
  ]);
  const sandbox = scriptSandbox([0]);

  const state = await runRalphLoop(
    { ctx: harness.ctx, sandbox, config: { provider: "test", model: "test" } },
    "task",
    "test",
    {},
  );

  assert.equal(state.isPassed, true);
  assert.equal(state.cycle, 2);
  assert.deepEqual(state.files, { "result.txt": "ok" });
  assert.deepEqual(state.lessonsLearned, ["lesson-1"]);
  assert.equal(state.reflection, "验证通过");
  // 形状错误的周期不写文件、不跑测试：测试只在第 2 轮执行了 1 次
  assert.equal(sandbox.runBashCalls, 1);
  assert.deepEqual(sandbox.writtenFiles, ["result.txt"]);
  // 解析失败的 stderr 确实进入了模型提示词（Reflect 与下一轮 Plan）
  assert.ok(harness.prompts.some((prompt) => prompt.includes("RALPH 方案解析失败")));
  assert.deepEqual(
    harness.events.map((event) => event.name),
    [
      "ralph/start",
      "ralph/cycle-start",
      "ralph/reflect",
      "ralph/learn",
      "ralph/cycle-end",
      "ralph/cycle-start",
      "ralph/reflect",
      "ralph/success",
      "ralph/end",
    ],
  );
});

test("maxCycles 耗尽：返回累积 lessons 的最终快照（isPassed=false）", async () => {
  const harness = scriptedHarness([
    "plan-1", '{"a.txt": "1"}', "reflection-1", "lesson-1",
    "plan-2", '{"a.txt": "2"}', "reflection-2", "lesson-2",
  ]);
  const sandbox = scriptSandbox([1]);

  const state = await runRalphLoop(
    { ctx: harness.ctx, sandbox, config: { provider: "test", model: "test", maxCycles: 2 } },
    "task",
    "test",
    {},
  );

  assert.equal(state.isPassed, false);
  assert.equal(state.cycle, 2);
  assert.equal(state.executionOutput.exitCode, 1);
  assert.equal(state.files["a.txt"], "2");
  assert.deepEqual(state.lessonsLearned, ["lesson-1", "lesson-2"]);
  assert.equal(sandbox.runBashCalls, 2);
  const names = harness.events.map((event) => event.name);
  assert.equal(names.filter((name) => name === "ralph/end").length, 1);
  assert.ok(!names.includes("ralph/success"));
  // Learn 的教训回流到下一轮 Plan 提示词
  assert.ok(harness.prompts.some((prompt) => prompt.includes("lesson-1")));
});

test("autoReflectOnFailure=false：失败反思零模型调用（确定性 stderr 摘录）", async () => {
  const harness = scriptedHarness(["plan-1", '{"a.txt": "1"}', "lesson-1"]);
  const sandbox = scriptSandbox([1]);

  const state = await runRalphLoop(
    {
      ctx: harness.ctx,
      sandbox,
      config: {
        provider: "test",
        model: "test",
        maxCycles: 1,
        autoReflectOnFailure: false,
      },
    },
    "task",
    "test",
    {},
  );

  assert.equal(state.isPassed, false);
  assert.ok(state.reflection.includes("exit=1"));
  assert.deepEqual(state.lessonsLearned, ["lesson-1"]);
  // plan + codegen + learn = 3 次模型调用，反思被确定性路径跳过
  assert.equal(harness.prompts.length, 3);
});
