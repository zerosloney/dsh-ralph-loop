import { test } from "node:test";
import assert from "node:assert/strict";
import { chatText } from "../lib/chat.js";
import { runRalphLoop } from "../lib/engine.js";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function errorFinish() {
  return {
    type: "finish",
    reason: { kind: "error", failure: { code: "TEMP", message: "temporary" } },
  };
}

function stopFinish() {
  return {
    type: "finish",
    reason: { kind: "stop" },
  };
}

function completedTextStream(text) {
  return (async function* () {
    yield { type: "text-delta", index: 0, text };
    yield stopFinish();
  })();
}

function waitingStream(signal, started) {
  let settled = false;
  return {
    [Symbol.asyncIterator]() {
      return this;
    },
    next() {
      started.resolve();
      return new Promise((resolve, reject) => {
        const onAbort = () => {
          if (settled) return;
          settled = true;
          reject(signal.reason);
        };
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
      });
    },
    return() {
      settled = true;
      return Promise.resolve({ done: true });
    },
  };
}

test("chatText pre-cancel rejects the original reason without streaming", async () => {
  const controller = new AbortController();
  const reason = new Error("pre-cancelled");
  controller.abort(reason);
  let streamCalls = 0;
  const ctx = {
    llm: {
      stream() {
        streamCalls += 1;
        throw new Error("stream must not be called");
      },
    },
  };

  await assert.rejects(
    chatText(ctx, { provider: "test", model: "test", prompt: "prompt" }, 1, controller.signal),
    (error) => error === reason,
  );
  assert.equal(streamCalls, 0);
});

test("chatText forwards signal to an in-progress stream and does not retry after abort", async () => {
  const controller = new AbortController();
  const reason = new Error("cancelled during stream");
  const started = deferred();
  let streamCalls = 0;
  let receivedSignal;
  const ctx = {
    llm: {
      stream(options) {
        streamCalls += 1;
        receivedSignal = options.signal;
        return waitingStream(options.signal, started);
      },
    },
  };

  const running = chatText(
    ctx,
    { provider: "test", model: "test", prompt: "prompt" },
    2,
    controller.signal,
  );
  await started.promise;
  assert.strictEqual(receivedSignal, controller.signal);
  controller.abort(reason);

  await assert.rejects(running, (error) => error === reason);
  assert.equal(streamCalls, 1);
});

test("chatText aborts retry backoff before another stream call", async () => {
  const controller = new AbortController();
  const reason = new Error("cancelled during retry backoff");
  const firstFailure = deferred();
  let streamCalls = 0;
  const ctx = {
    llm: {
      stream() {
        streamCalls += 1;
        return (async function* () {
          yield errorFinish();
          firstFailure.resolve();
        })();
      },
    },
  };

  const running = chatText(
    ctx,
    { provider: "test", model: "test", prompt: "prompt" },
    2,
    controller.signal,
  );
  await firstFailure.promise;
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort(reason);

  await assert.rejects(running, (error) => error === reason);
  assert.equal(streamCalls, 1);
});

function loopContext(streamFactory) {
  const events = [];
  let streamCalls = 0;
  return {
    events,
    get streamCalls() {
      return streamCalls;
    },
    ctx: {
      llm: {
        stream(options) {
          streamCalls += 1;
          return streamFactory(options);
        },
      },
      emit(name, payload) {
        events.push({ name, payload });
      },
      logger: { info() {} },
    },
  };
}

function fakeSandbox() {
  let runBashCalls = 0;
  return {
    get runBashCalls() {
      return runBashCalls;
    },
    hasWritten() {
      return false;
    },
    async writeFile() {},
    async runBash() {
      runBashCalls += 1;
      return { stdout: "", stderr: "", exitCode: 1 };
    },
  };
}

function passingSandbox() {
  let runBashCalls = 0;
  return {
    get runBashCalls() {
      return runBashCalls;
    },
    hasWritten() {
      return false;
    },
    async writeFile() {},
    async runBash() {
      runBashCalls += 1;
      return { stdout: "", stderr: "", exitCode: 0 };
    },
  };
}

test("runRalphLoop pre-cancel emits no lifecycle end", async () => {
  const controller = new AbortController();
  const reason = new Error("pre-cancelled loop");
  controller.abort(reason);
  const harness = loopContext(() => {
    throw new Error("stream must not be called");
  });
  const sandbox = fakeSandbox();

  await assert.rejects(
    runRalphLoop(
      { ctx: harness.ctx, sandbox, config: { provider: "test", model: "test", maxCycles: 1 } },
      "task",
      "test",
      {},
      { signal: controller.signal },
    ),
    (error) => error === reason,
  );
  assert.equal(harness.events.length, 0);
  assert.equal(harness.streamCalls, 0);
  assert.equal(sandbox.runBashCalls, 0);
});

test("runRalphLoop phase abort skips Reflect/Learn and normal end", async () => {
  const controller = new AbortController();
  const reason = new Error("cancelled in plan");
  const started = deferred();
  let receivedSignal;
  const harness = loopContext((options) => {
    receivedSignal = options.signal;
    assert.notStrictEqual(options.signal, controller.signal);
    return waitingStream(options.signal, started);
  });
  const sandbox = fakeSandbox();

  const running = runRalphLoop(
    { ctx: harness.ctx, sandbox, config: { provider: "test", model: "test", maxCycles: 1 } },
    "task",
    "test",
    {},
    { signal: controller.signal },
  );
  await started.promise;
  controller.abort(reason);

  await assert.rejects(running, (error) => error === reason);
  assert.ok(harness.events.some((event) => event.name === "ralph/start"));
  assert.ok(harness.events.some((event) => event.name === "ralph/cycle-start"));
  assert.ok(!harness.events.some((event) => event.name === "ralph/end"));
  assert.ok(!harness.events.some((event) => event.name === "ralph/reflect"));
  assert.ok(!harness.events.some((event) => event.name === "ralph/learn"));
  assert.equal(harness.streamCalls, 1);
  assert.equal(receivedSignal.aborted, true);
  assert.equal(sandbox.runBashCalls, 0);
});

test("runRalphLoop deadline aborts a hanging LLM and closes normally", async () => {
  const started = deferred();
  let receivedSignal;
  const harness = loopContext((options) => {
    receivedSignal = options.signal;
    return waitingStream(options.signal, started);
  });
  const sandbox = fakeSandbox();

  const running = runRalphLoop(
    {
      ctx: harness.ctx,
      sandbox,
      config: { provider: "test", model: "test", maxCycles: 1, totalTimeoutMs: 20 },
    },
    "task",
    "test",
    {},
  );
  await started.promise;

  const state = await running;
  assert.equal(state.timedOut, true);
  assert.equal(state.isPassed, false);
  assert.equal(state.plan, null);
  assert.equal(receivedSignal.aborted, true);
  assert.equal(harness.streamCalls, 1);
  assert.equal(sandbox.runBashCalls, 0);
  assert.equal(
    harness.events.filter((event) => event.name === "ralph/end").length,
    1,
  );
  assert.ok(!harness.events.some((event) => event.name === "ralph/reflect"));
  assert.ok(!harness.events.some((event) => event.name === "ralph/learn"));
  assert.ok(!harness.events.some((event) => event.name === "ralph/cycle-end"));
});

test("runRalphLoop clears its deadline timer after normal completion", async () => {
  const receivedSignals = [];
  let streamCalls = 0;
  const harness = loopContext(() => {
    const text = streamCalls++ === 0 ? "plan" : '{"result.txt":"ok"}';
    return completedTextStream(text);
  });
  const originalStream = harness.ctx.llm.stream;
  harness.ctx.llm.stream = (options) => {
    receivedSignals.push(options.signal);
    return originalStream(options);
  };
  const sandbox = passingSandbox();

  const state = await runRalphLoop(
    {
      ctx: harness.ctx,
      sandbox,
      config: { provider: "test", model: "test", maxCycles: 1, totalTimeoutMs: 100 },
    },
    "task",
    "test",
    {},
  );

  assert.equal(state.isPassed, true);
  assert.equal(state.timedOut, undefined);
  assert.equal(sandbox.runBashCalls, 1);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.ok(receivedSignals.length >= 2);
  assert.ok(receivedSignals.every((signal) => signal.aborted === false));
  assert.equal(
    harness.events.filter((event) => event.name === "ralph/end").length,
    1,
  );
});

test("large deadline is re-armed without timer overflow", async () => {
  const controller = new AbortController();
  const reason = new Error("caller cancelled large deadline");
  const started = deferred();
  const harness = loopContext((options) => waitingStream(options.signal, started));
  const sandbox = fakeSandbox();

  const running = runRalphLoop(
    {
      ctx: harness.ctx,
      sandbox,
      config: {
        provider: "test",
        model: "test",
        maxCycles: 1,
        totalTimeoutMs: Number.MAX_SAFE_INTEGER,
      },
    },
    "task",
    "test",
    {},
    { signal: controller.signal },
  );
  await started.promise;
  await new Promise((resolve) => setTimeout(resolve, 10));
  controller.abort(reason);

  await assert.rejects(running, (error) => error === reason);
  assert.equal(harness.events.some((event) => event.name === "ralph/end"), false);
  assert.equal(sandbox.runBashCalls, 0);
});
