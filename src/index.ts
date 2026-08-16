/**
 * dsh-ralph-loop: the RALPH cognitive-loop plugin for DeepSeek Harness.
 *
 * Registers the `ctx.ralph` service (design doc §2 RalphService) exposing
 * `execute()` for other plugins, wires the `run_ralph_loop` tool so the LLM
 * can trigger sub-loops, and reports cycle lifecycle events on the harness
 * event bus for the dsh Trajectory view.
 */
import { Context, Service } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { runRalphLoop } from "./engine.js";
import {
  DEFAULT_MAX_CYCLES,
  DEFAULT_TEST_TIMEOUT_MS,
  DEFAULT_TOTAL_TIMEOUT_MS,
  MAX_CYCLES_CAP,
} from "./pure.js";
import { RalphSandbox } from "./sandbox.js";
import { registerRalphTools } from "./tools.js";
import type {
  RalphCycleEndEvent,
  RalphCycleStartEvent,
  RalphEndEvent,
  RalphExecuteOptions,
  RalphLearnEvent,
  RalphPluginConfig,
  RalphReflectEvent,
  RalphStartEvent,
  RalphState,
  RalphSuccessEvent,
} from "./types.js";

declare module "@deepseek-ai/cordis" {
  interface Context {
    /** The RALPH loop service: one `execute()` entry for the full loop. */
    ralph: RalphService;
  }
  interface Events {
    /** A loop execution started. */
    "ralph/start"(payload: RalphStartEvent): void;
    /** A new plan→test cycle began. */
    "ralph/cycle-start"(payload: RalphCycleStartEvent): void;
    /** The Reflect node produced an analysis for one cycle. */
    "ralph/reflect"(payload: RalphReflectEvent): void;
    /** The Learn node distilled one negative constraint. */
    "ralph/learn"(payload: RalphLearnEvent): void;
    /** The Assess gate passed; the loop ends successfully. */
    "ralph/success"(payload: RalphSuccessEvent): void;
    /** A cycle ended without passing the gate. */
    "ralph/cycle-end"(payload: RalphCycleEndEvent): void;
    /** The loop terminated (passed or cycle cap exhausted). */
    "ralph/end"(payload: RalphEndEvent): void;
  }
}

/** Plugin config: deployment defaults applied when a call omits the field. */
export interface Config extends RalphPluginConfig {}

const MAX_SAFE_CONFIG_INTEGER = Number.MAX_SAFE_INTEGER;

/** Schema-side numeric contracts shared by config and deadline knobs. */
const positiveInteger = (fallback: number) =>
  z.natural().min(1).max(MAX_SAFE_CONFIG_INTEGER).default(fallback);
const nonNegativeInteger = (fallback: number) =>
  z.natural().max(MAX_SAFE_CONFIG_INTEGER).default(fallback);

function checkedInteger(
  name: string,
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum = MAX_SAFE_CONFIG_INTEGER,
): number {
  const resolved = value ?? fallback;
  if (
    !Number.isSafeInteger(resolved) ||
    resolved < minimum ||
    resolved > maximum
  ) {
    const range = minimum === 0 ? "a non-negative integer" : "a positive integer";
    throw new TypeError(
      `ralph: ${name} must be ${range} <= ${maximum}; got ${String(value)}`,
    );
  }
  return resolved;
}

/**
 * Cordis normally validates `Config` before constructing the service. Keep a
 * second, fail-closed guard here because tests and embedders can instantiate a
 * service directly and thereby bypass the static schema.
 */
function normalizeConfig(config: Config): Config {
  if (config === null || typeof config !== "object" || Array.isArray(config)) {
    throw new TypeError("ralph: config must be an object");
  }
  return {
    ...config,
    maxCycles: checkedInteger(
      "maxCycles",
      config.maxCycles,
      DEFAULT_MAX_CYCLES,
      1,
      MAX_CYCLES_CAP,
    ),
    codegenMaxTokens: checkedInteger(
      "codegenMaxTokens",
      config.codegenMaxTokens,
      0,
      0,
    ),
    testTimeoutMs: checkedInteger(
      "testTimeoutMs",
      config.testTimeoutMs,
      DEFAULT_TEST_TIMEOUT_MS,
      1,
    ),
    totalTimeoutMs: checkedInteger(
      "totalTimeoutMs",
      config.totalTimeoutMs,
      DEFAULT_TOTAL_TIMEOUT_MS,
      1,
    ),
  };
}

/**
 * The RALPH loop as a DeepSeek Harness plugin. Needs the harness `llm` seam
 * for the five nodes, `subprocess` for the sandboxed test command, and
 * `tools` to register `run_ralph_loop`.
 */
export default class RalphService extends Service {
  static inject = ["llm", "tools", "subprocess", "sandbox"];

  // 全部字段带默认值：与 RalphPluginConfig（类型层面全 optional）及 cordis.patch.yml
  // 缺省加载保持一致——schema 必填而 patch/类型 optional 会导致插件加载失败或契约矛盾。
  static Config: z<Config> = z.object({
    maxCycles: z.natural().min(1).max(MAX_CYCLES_CAP).default(DEFAULT_MAX_CYCLES),
    autoReflectOnFailure: z.boolean().default(true),
    verboseLogging: z.boolean().default(false),
    provider: z.string().default(""),
    model: z.string().default(""),
    codegenMaxTokens: nonNegativeInteger(0),
    testTimeoutMs: positiveInteger(DEFAULT_TEST_TIMEOUT_MS),
    sandboxDir: z.string().default(""),
    totalTimeoutMs: positiveInteger(DEFAULT_TOTAL_TIMEOUT_MS),
  });

  private readonly config: Config;

  constructor(ctx: Context, config: Config) {
    super(ctx, "ralph");
    this.config = normalizeConfig(config);
    registerRalphTools(ctx, this.config, (params) =>
      this.execute(params.task, params.testCmd, params.files ?? {}, {
        maxCycles: params.maxCycles,
        provider: params.provider,
        model: params.model,
        signal: params.signal,
      }),
    );
  }

  /**
   * Run one RALPH loop: Plan → Handle → Reflect → Assess → Learn, bounded by
   * the hard `maxCycles` cap. Each call gets a fresh isolated sandbox
   * directory, removed when the loop settles.
   * @param task - the goal to achieve.
   * @param testCmd - shell command that verifies the generated files.
   * @param initialFiles - starting file set (path → content).
   * @param options - per-call overrides of plugin config.
   * @returns the final immutable state snapshot.
   */
  async execute(
    task: string,
    testCmd: string,
    initialFiles: Record<string, string> = {},
    options: RalphExecuteOptions = {},
  ): Promise<RalphState> {
    const safeOptions = {
      ...options,
      maxCycles: options.maxCycles === undefined
        ? undefined
        : checkedInteger("options.maxCycles", options.maxCycles, 1, 1, MAX_CYCLES_CAP),
      deadlineMs: options.deadlineMs === undefined
        ? undefined
        : checkedInteger("options.deadlineMs", options.deadlineMs, 1, 1),
    } satisfies RalphExecuteOptions;
    const sandbox = new RalphSandbox(
      this.ctx.subprocess,
      this.ctx.sandbox,
      this.config.testTimeoutMs,
      this.config.sandboxDir || undefined,
    );
    await sandbox.init();
    try {
      return await runRalphLoop(
        { ctx: this.ctx, sandbox, config: this.config },
        task,
        testCmd,
        initialFiles,
        safeOptions,
      );
    } finally {
      await sandbox.dispose();
    }
  }
}
