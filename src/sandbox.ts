/**
 * The RALPH sandbox: one isolated working directory per execution (design
 * doc §5 沙箱环境纯净度). The harness has no `ctx.sandbox` service, so the
 * doc's `writeFile`/`runBash` map onto `node:fs` writes inside the private
 * directory plus the `ctx.subprocess` seam for the test command (tree-scoped
 * termination, collect-mode output, deadline via abort signal).
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SubprocessRuntime } from "@deepseek-ai/dsh-subprocess";
import { DEFAULT_TEST_TIMEOUT_MS } from "./pure.js";
import type { RalphExecutionOutput } from "./types.js";

export class RalphSandbox {
  private dirPath: string | null = null;
  /** 已成功写入本沙箱的文件路径（原始相对路径），供"跳过未变更"的精确判断。 */
  private readonly written = new Set<string>();
  private readonly subprocess: SubprocessRuntime;
  private readonly testTimeoutMs: number;
  private readonly baseDir: string;

  constructor(
    subprocess: SubprocessRuntime,
    testTimeoutMs: number = DEFAULT_TEST_TIMEOUT_MS,
    baseDir?: string,
  ) {
    this.subprocess = subprocess;
    this.testTimeoutMs = testTimeoutMs;
    this.baseDir = baseDir ?? tmpdir();
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
  async runBash(command: string): Promise<RalphExecutionOutput> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.testTimeoutMs);
    try {
      const argv =
        process.platform === "win32"
          ? [process.env.ComSpec ?? "cmd.exe", "/d", "/s", "/c", command]
          : ["/bin/sh", "-c", command];
      const handle = this.subprocess.spawn({
        argv,
        cwd: this.dir,
        stdio: {
          stdin: "ignore",
          stdout: { maxBytes: 1_000_000 },
          stderr: { maxBytes: 1_000_000 },
        },
        graceMs: 2_000,
        signal: controller.signal,
      });
      let outcome;
      try {
        outcome = await handle.done;
      } catch (error) {
        // spawn 级失败（ENOENT 等）使 done reject。按 seam 契约，超时 abort 走
        // SIGTERM→graceMs→SIGKILL 升级、done 仍 resolve（exitCode 为 null/-1），
        // 不会走到这里；本分支仅为 spawn 失败兜底，统一转为一次失败周期自愈。
        return {
          stdout: handle.collected.stdout?.readFrom(0).text ?? "",
          stderr: `RALPH 测试命令失败: ${(error as Error).message}`,
          exitCode: -1,
        };
      }
      return {
        stdout: handle.collected.stdout?.readFrom(0).text ?? "",
        stderr: handle.collected.stderr?.readFrom(0).text ?? "",
        exitCode: outcome.exitCode ?? -1,
      };
    } finally {
      // spawn 同步抛错或 done reject 都确保定时器被清，避免残留至超时触发。
      clearTimeout(timer);
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
