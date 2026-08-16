import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { RalphSandbox } from "../lib/sandbox.js";

function reader(text = "") {
  return {
    readFrom() {
      return { text, lossy: false };
    },
  };
}

function handle(done) {
  return {
    done,
    collected: {
      stdout: reader(),
      stderr: reader(),
    },
  };
}

function fakeSandbox({ prefix = ["fake-sandbox"], error, enforcement = "full" } = {}) {
  const calls = [];
  return {
    calls,
    confine(argv, policy) {
      calls.push({ argv: [...argv], policy });
      if (error) throw error;
      return {
        argv: [...prefix, ...argv],
        enforcement,
        denialSignatures: [],
        runnerFailureRules: [],
      };
    },
  };
}

function shellArgv(command) {
  return process.platform === "win32"
    ? [process.env.ComSpec ?? "cmd.exe", "/d", "/s", "/c", command]
    : ["/bin/sh", "-c", command];
}

test("confines the exact platform shell argv and spawns only confined argv", async () => {
  const sandboxProvider = fakeSandbox();
  let spawnSpec;
  const subprocess = {
    spawn(spec) {
      spawnSpec = spec;
      return handle(Promise.resolve({ exitCode: 0, signal: null }));
    },
  };
  const sandbox = new RalphSandbox(subprocess, sandboxProvider, 1_000);

  await sandbox.init();
  try {
    const command = "echo sandbox-test";
    const result = await sandbox.runBash(command);

    assert.equal(result.exitCode, 0);
    assert.equal(sandboxProvider.calls.length, 1);
    assert.deepEqual(sandboxProvider.calls[0].argv, shellArgv(command));
    assert.equal(sandboxProvider.calls[0].policy.mode, "workspace-write");
    assert.equal(sandboxProvider.calls[0].policy.workspaceRoot, sandbox.dir);
    assert.deepEqual(spawnSpec.argv, ["fake-sandbox", ...shellArgv(command)]);
    assert.notDeepEqual(spawnSpec.argv, shellArgv(command));
    assert.equal(spawnSpec.cwd, sandbox.dir);
  } finally {
    await sandbox.dispose();
  }
});

test("confine failure is fail-closed and never calls subprocess", async () => {
  const sandboxProvider = fakeSandbox({ error: new Error("sandbox unavailable") });
  let spawnCalls = 0;
  const subprocess = {
    spawn() {
      spawnCalls += 1;
      throw new Error("unexpected unconfined spawn");
    },
  };
  const sandbox = new RalphSandbox(subprocess, sandboxProvider, 1_000);

  await sandbox.init();
  try {
    await assert.rejects(
      () => sandbox.runBash("echo must-not-run"),
      /sandbox unavailable/,
    );
    assert.equal(spawnCalls, 0);
  } finally {
    await sandbox.dispose();
  }
});

test("pre-cancel rejects before confine or subprocess", async () => {
  const controller = new AbortController();
  const reason = new Error("pre-cancelled");
  controller.abort(reason);
  const sandboxProvider = fakeSandbox();
  let spawnCalls = 0;
  const subprocess = {
    spawn() {
      spawnCalls += 1;
      throw new Error("unexpected spawn");
    },
  };
  const sandbox = new RalphSandbox(subprocess, sandboxProvider, 1_000);

  await sandbox.init();
  try {
    await assert.rejects(
      () => sandbox.runBash("echo must-not-run", controller.signal),
      (error) => error === reason,
    );
    assert.equal(sandboxProvider.calls.length, 0);
    assert.equal(spawnCalls, 0);
  } finally {
    await sandbox.dispose();
  }
});

test("partial enforcement is fail-closed and never calls subprocess", async () => {
  const sandboxProvider = fakeSandbox({ enforcement: "partial" });
  let spawnCalls = 0;
  const subprocess = {
    spawn() {
      spawnCalls += 1;
      throw new Error("unexpected partial sandbox spawn");
    },
  };
  const sandbox = new RalphSandbox(subprocess, sandboxProvider, 1_000);

  await sandbox.init();
  try {
    await assert.rejects(
      () => sandbox.runBash("echo must-not-run"),
      /enforcement is partial/,
    );
    assert.equal(spawnCalls, 0);
  } finally {
    await sandbox.dispose();
  }
});

test("external abort reaches the combined subprocess signal", async () => {
  const sandboxProvider = fakeSandbox();
  let spawnSpec;
  let resolveDone;
  const subprocess = {
    spawn(spec) {
      spawnSpec = spec;
      return handle(new Promise((resolve) => {
        resolveDone = resolve;
      }));
    },
  };
  const sandbox = new RalphSandbox(subprocess, sandboxProvider, 5_000);
  const controller = new AbortController();

  await sandbox.init();
  try {
    const running = sandbox.runBash("echo abortable", controller.signal);
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(spawnSpec.signal.aborted, false);
    assert.notStrictEqual(spawnSpec.signal, controller.signal);
    const reason = new Error("cancelled while running");
    controller.abort(reason);
    assert.equal(spawnSpec.signal.aborted, true);

    resolveDone({ exitCode: 0, signal: null });
    await assert.rejects(running, (error) => error === reason);
  } finally {
    await sandbox.dispose();
  }
});

test("large test timeout is re-armed without timer overflow", async () => {
  const sandboxProvider = fakeSandbox();
  let spawnSpec;
  let resolveDone;
  const subprocess = {
    spawn(spec) {
      spawnSpec = spec;
      return handle(new Promise((resolve) => {
        resolveDone = resolve;
      }));
    },
  };
  const sandbox = new RalphSandbox(subprocess, sandboxProvider, Number.MAX_SAFE_INTEGER);
  const controller = new AbortController();

  await sandbox.init();
  try {
    const running = sandbox.runBash("echo large-timeout", controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.equal(spawnSpec.signal.aborted, false);
    const reason = new Error("cancelled after large timeout remained armed");
    controller.abort(reason);
    resolveDone({ exitCode: 0, signal: null });
    await assert.rejects(running, (error) => error === reason);
  } finally {
    await sandbox.dispose();
  }
});

test("internal timeout also aborts the combined subprocess signal", async () => {
  const sandboxProvider = fakeSandbox();
  let spawnSpec;
  let resolveDone;
  const subprocess = {
    spawn(spec) {
      spawnSpec = spec;
      return handle(new Promise((resolve) => {
        resolveDone = resolve;
      }));
    },
  };
  const sandbox = new RalphSandbox(subprocess, sandboxProvider, 10);

  await sandbox.init();
  try {
    const running = sandbox.runBash("echo timeout", new AbortController().signal);
    await new Promise((resolve) => setTimeout(resolve, 30));

    assert.equal(spawnSpec.signal.aborted, true);
    resolveDone({ exitCode: 0, signal: null });
    const result = await running;
    assert.equal(result.exitCode, -1);
  } finally {
    await sandbox.dispose();
  }
});

test("dispose removes the temporary working directory", async () => {
  const sandbox = new RalphSandbox({}, fakeSandbox());

  await sandbox.init();
  const directory = sandbox.dir;
  await sandbox.writeFile("result.txt", "done");
  assert.equal(existsSync(directory), true);

  await sandbox.dispose();

  assert.equal(existsSync(directory), false);
});

test("relative baseDir yields an absolute workspaceRoot", async () => {
  const absoluteBase = await mkdtemp(path.join(process.cwd(), "dsh-ralph-relative-"));
  const relativeBase = path.relative(process.cwd(), absoluteBase);
  const sandboxProvider = fakeSandbox();
  const subprocess = {
    spawn() {
      return handle(Promise.resolve({ exitCode: 0, signal: null }));
    },
  };
  const sandbox = new RalphSandbox(subprocess, sandboxProvider, 1_000, relativeBase);

  await sandbox.init();
  try {
    await sandbox.runBash("echo absolute-root");
    assert.equal(path.isAbsolute(sandbox.dir), true);
    assert.equal(path.isAbsolute(sandboxProvider.calls[0].policy.workspaceRoot), true);
  } finally {
    await sandbox.dispose();
    await rm(absoluteBase, { recursive: true, force: true });
  }
});
