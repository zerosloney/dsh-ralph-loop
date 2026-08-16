/**
 * The RALPH sandbox: one isolated working directory per execution (design
 * doc §5 沙箱环境纯净度). File preparation stays in the private directory;
 * the test command is wrapped by the harness `ctx.sandbox` provider before it
 * reaches the `ctx.subprocess` seam (tree-scoped termination, collect-mode
 * output, deadline via abort signal). The provider only confines process file
 * effects; it is not a network or credential isolation boundary.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  SandboxPolicy,
  SandboxProvider,
} from "@deepseek-ai/dsh-sandbox";
import type { SubprocessRuntime } from "@deepseek-ai/dsh-subprocess";
import { DEFAULT_TEST_TIMEOUT_MS } from "./pure.js";
import type { RalphExecutionOutput } from "./types.js";

const MAX_TIMER_DELAY_MS = 2_147_483_647;

export class RalphSandbox {
  private dirPath: string | null = null;
  /** 已成功写入本沙箱的文件路径（原始相对路径），供"跳过未变更"的精确判断。 */
  private readonly written = new Set<string>();
  private readonly subprocess: SubprocessRuntime;
  private readonly sandbox: SandboxProvider;
  private readonly testTimeoutMs: number;
  private readonly baseDir: string;

  constructor(
    subprocess: SubprocessRuntime,
    sandbox: SandboxProvider,
    testTimeoutMs: number = DEFAULT_TEST_TIMEOUT_MS,
    baseDir?: string,
  ) {
    this.subprocess = subprocess;
    this.sandbox = sandbox;
    this.testTimeoutMs = testTimeoutMs;
    this.baseDir = path.resolve(baseDir ?? tmpdir());
  }

  /** Allocate and create the sandbox working directory. */
  async init(): Promise<void> {
    this.dirPath = await mkdtemp(path.join(this.baseDir, "dsh-ralph-"));
  }

  /** The sandbox working directory (call {@link init} first). */
  get dir(): string {
    if (!this.dirPath) throw new Error("ralph: sandbox not initialized");
    return this.dirPath;
  }

  /** Write one file inside the sandbox, refusing absolute/traversal paths. */
  async writeFile(filePath: string, content: string): Promise<void> {
    const target = this.resolve(filePath);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");
    this.written.add(filePath);
  }

  /** 该文件是否已写入本沙箱。 */
  hasWritten(filePath: string): boolean {
    return this.written.has(filePath);
  }

  /** Run the test command in the sandbox, capturing stdout/stderr/exit code. */
  async runBash(
    command: string,
    externalSignal?: AbortSignal,
  ): Promise<RalphExecutionOutput> {
    const controller = new AbortController();
    const deadline = Date.now() + this.testTimeoutMs;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const armTimeout = (): void => {
      const remaining = deadline - Date.now();
      if (remaining <= 0 || Number.isNaN(remaining)) {
        controller.abort();
        return;
      }
      timer = setTimeout(
        () => {
          timer = undefined;
          armTimeout();
        },
        Math.min(remaining, MAX_TIMER_DELAY_MS),
      );
    };
    const timeoutResult = (handle?: {
      collected?: {
        stdout?: { readFrom(fromByte: number): { text: string } };
        stderr?: { readFrom(fromByte: number): { text: string } };
      };
    }): RalphExecutionOutput => ({
      stdout: handle?.collected?.stdout?.readFrom(0).text ?? "",
      stderr: handle?.collected?.stderr?.readFrom(0).text ?? "",
      exitCode: -1,
    });

    armTimeout();
    try {
      externalSignal?.throwIfAborted();
      const innerArgv =
        process.platform === "win32"
          ? [process.env.ComSpec ?? "cmd.exe", "/d", "/s", "/c", command]
          : ["/bin/sh", "-c", command];
      const signal = externalSignal === undefined
        ? controller.signal
        : AbortSignal.any([controller.signal, externalSignal]);
      externalSignal?.throwIfAborted();
      if (controller.signal.aborted) return timeoutResult();
      const policy: SandboxPolicy = {
        mode: "workspace-write",
        workspaceRoot: this.dir,
      };
      // `confine` is fail-closed: a provider error must prevent spawn, and the
      // original argv must never be handed to the subprocess seam unwrapped.
      const confined = this.sandbox.confine(innerArgv, policy);
      externalSignal?.throwIfAborted();
      if (controller.signal.aborted) return timeoutResult();
      if (confined.enforcement !== "full") {
        throw new Error(
          `ralph: sandbox enforcement is ${confined.enforcement}; refusing to run the command`,
        );
      }
      const handle = this.subprocess.spawn({
        argv: confined.argv,
        cwd: this.dir,
        stdio: {
          stdin: "ignore",
          stdout: { maxBytes: 1_000_000 },
          stderr: { maxBytes: 1_000_000 },
        },
        graceMs: 2_000,
        signal,
      });
      let outcome;
      try {
        outcome = await handle.done;
      } catch (error) {
        externalSignal?.throwIfAborted();
        if (controller.signal.aborted) return timeoutResult(handle);
        // spawn 级失败（ENOENT 等）使 done reject。按 seam 契约，超时 abort 走
        // SIGTERM→graceMs→SIGKILL 升级、done 仍 resolve（exitCode 为 null/-1），
        // 不会走到这里；本分支仅为 spawn 失败兜底，统一转为一次失败周期自愈。
        return {
          stdout: handle.collected.stdout?.readFrom(0).text ?? "",
          stderr: `RALPH 测试命令失败: ${(error as Error).message}`,
          exitCode: -1,
        };
      }
      externalSignal?.throwIfAborted();
      if (controller.signal.aborted) return timeoutResult(handle);
      return {
        stdout: handle.collected.stdout?.readFrom(0).text ?? "",
        stderr: handle.collected.stderr?.readFrom(0).text ?? "",
        exitCode: outcome.exitCode ?? -1,
      };
    } finally {
      // spawn 同步抛错或 done reject 都确保定时器被清，避免残留至超时触发。
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /** Remove the sandbox directory and everything in it. */
  async dispose(): Promise<void> {
    if (this.dirPath) {
      await rm(this.dirPath, { recursive: true, force: true });
      this.dirPath = null;
    }
  }

  private resolve(filePath: string): string {
    const normalized = path.normalize(filePath);
    if (path.isAbsolute(normalized) || normalized.startsWith("..")) {
      throw new Error(`ralph: refusing unsafe sandbox path: ${filePath}`);
    }
    // Win32 保留设备名（含带扩展形式）与尾点/尾空格段：写入会 EINVAL 或被静默
    // 重定向到设备，与穿越路径同等拒绝。
    if (
      /[. ]$/.test(normalized) ||
      /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(normalized)
    ) {
      throw new Error(`ralph: refusing unsafe sandbox path: ${filePath}`);
    }
    return path.join(this.dir, normalized);
  }
}
