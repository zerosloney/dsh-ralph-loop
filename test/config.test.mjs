import { test } from "node:test";
import assert from "node:assert/strict";
import RalphService from "../lib/index.js";

function validContext() {
  return {
    reflect: { provide() {} },
    tools: { register() {} },
    subprocess: {},
  };
}

const positiveFields = [
  "maxCycles",
  "testTimeoutMs",
  "totalTimeoutMs",
];

test("Config({}) supplies finite integer defaults", () => {
  const config = RalphService.Config({});

  assert.equal(config.maxCycles, 5);
  assert.equal(config.codegenMaxTokens, 0);
  assert.equal(config.testTimeoutMs, 120_000);
  assert.equal(config.totalTimeoutMs, 1_800_000);
  for (const name of positiveFields) {
    assert.equal(Number.isSafeInteger(config[name]), true);
    assert.ok(config[name] > 0);
  }
});

test("Config accepts boundary-valid numeric values", () => {
  const config = RalphService.Config({
    maxCycles: 1,
    codegenMaxTokens: 0,
    testTimeoutMs: 1,
    totalTimeoutMs: 1,
  });

  assert.equal(config.maxCycles, 1);
  assert.equal(config.codegenMaxTokens, 0);
  assert.equal(config.testTimeoutMs, 1);
  assert.equal(config.totalTimeoutMs, 1);
});

test("Config rejects non-finite, fractional, zero, and negative positive fields", () => {
  for (const name of positiveFields) {
    for (const value of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      assert.throws(
        () => RalphService.Config({ [name]: value }),
        /expected|number|multiple|>=|<=/i,
        `${name}=${String(value)} should be rejected`,
      );
    }
  }
  assert.throws(() => RalphService.Config({ maxCycles: 21 }), /<= 20|expected/i);
  assert.throws(() => RalphService.Config({ codegenMaxTokens: -1 }), /expected|>=/i);
  assert.doesNotThrow(() => RalphService.Config({ codegenMaxTokens: 0 }));
});

test("direct construction revalidates config after schema bypass", () => {
  for (const name of ["maxCycles", "codegenMaxTokens", "testTimeoutMs", "totalTimeoutMs"]) {
    const value = name === "codegenMaxTokens" ? -1 : Number.NaN;
    assert.throws(
      () => new RalphService(validContext(), { [name]: value }),
      new RegExp(name),
      `${name} should be rejected by the constructor guard`,
    );
  }

  assert.doesNotThrow(() => new RalphService(validContext(), {}));
});

test("execute revalidates numeric overrides before sandbox allocation", async () => {
  const service = new RalphService(validContext(), {});

  await assert.rejects(
    () => service.execute("task", "test", {}, { maxCycles: 0 }),
    /options\.maxCycles/,
  );
  await assert.rejects(
    () => service.execute("task", "test", {}, { maxCycles: Number.NaN }),
    /options\.maxCycles/,
  );
  await assert.rejects(
    () => service.execute("task", "test", {}, { deadlineMs: -1 }),
    /options\.deadlineMs/,
  );
  await assert.rejects(
    () => service.execute("task", "test", {}, { deadlineMs: 0 }),
    /options\.deadlineMs/,
  );
  await assert.rejects(
    () => service.execute("task", "test", {}, { deadlineMs: Number.POSITIVE_INFINITY }),
    /options\.deadlineMs/,
  );
});
