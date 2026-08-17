import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractJson,
  patchState,
  initialState,
  formatTestOutput,
  mechanicalReflection,
  planPrompt,
  codegenPrompt,
  learnPrompt,
  MAX_CYCLES_CAP,
} from "../lib/pure.js";

test("extractJson: 围栏/裸 JSON/散文环绕都能提取", () => {
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
  assert.deepEqual(extractJson('结果是 {"a": 1} 就这样'), { a: 1 });
  assert.deepEqual(extractJson('```\n[1,2,3]\n```'), [1, 2, 3]);
});

test("extractJson: 字符串内的括号不影响平衡扫描", () => {
  assert.deepEqual(extractJson('{"s":"a}b{c","n":1}'), { s: "a}b{c", n: 1 });
  assert.deepEqual(extractJson('{"s":"\\"quoted\\"","n":1}'), { s: '"quoted"', n: 1 });
});

test("extractJson: 无 JSON 时抛错", () => {
  assert.throws(() => extractJson("什么都没有"), /no JSON value/);
});

test("patchState: 不可变 + files 深拷贝", () => {
  const state = initialState("t", "echo", { a: "1" });
  const patched = patchState(state, { plan: "p" });
  assert.equal(state.plan, null);
  assert.equal(patched.plan, "p");
  // 快照的 files 独立：后续 patch 不污染已发出的快照
  const patched2 = patchState(patched, { files: { a: "2" } });
  assert.deepEqual(patched.files, { a: "1" });
  assert.deepEqual(patched2.files, { a: "2" });
  assert.equal(state.files.a, "1");
});

test("formatTestOutput: 尾部截断保留失败摘要", () => {
  const long = "x".repeat(5000);
  const output = { stdout: long, stderr: "stderr-tail", exitCode: 1 };
  const formatted = formatTestOutput(output, 1000);
  assert.ok(formatted.includes("stderr-tail"));
  assert.ok(formatted.includes("…"));
  assert.ok(formatted.includes("exit=1"));
  assert.equal(formatTestOutput(null), "初始启动");
});

test("mechanicalReflection: 确定性 stderr 摘录（零模型调用路径）", () => {
  const output = { stdout: "out", stderr: "boom: division by zero", exitCode: 1 };
  const state = initialState("t", "echo", {});
  const withOutput = patchState(state, { executionOutput: output });
  const reflection = mechanicalReflection(withOutput);
  assert.ok(reflection.includes("boom: division by zero"));
});

test("提示词携带任务/输出/教训", () => {
  const state = initialState("写一个排序", "npm test", {});
  const withFail = patchState(state, {
    executionOutput: { stdout: "", stderr: "assert failed", exitCode: 1 },
    lessonsLearned: ["不要用 eval"],
  });
  const plan = planPrompt(withFail);
  assert.ok(plan.includes("写一个排序"));
  assert.ok(plan.includes("assert failed"));
  assert.ok(plan.includes("不要用 eval"));
  const { system, prompt } = codegenPrompt("方案");
  assert.ok(system.includes("JSON"));
  assert.ok(prompt.includes("方案"));
  assert.ok(learnPrompt(withFail).includes("避坑"));
});

test("codegen 提示词携带包裹结构反例（预防零有效条目周期）", () => {
  const { system, prompt } = codegenPrompt("方案");
  const combined = `${system}\n${prompt}`;
  // 两种最常见的错误形状都有显式反例
  assert.ok(combined.includes('{"files"'));
  assert.ok(combined.includes('{"content"'));
  // 值必须是纯字符串的正例约束
  assert.ok(system.includes("纯字符串"));
  assert.ok(prompt.includes("正确"));
});

test("MAX_CYCLES_CAP 与工具 schema 的 1-20 钳制一致", () => {
  assert.equal(MAX_CYCLES_CAP, 20);
});
