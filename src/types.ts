/** One captured test-command execution. */
export interface RalphExecutionOutput {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Immutable snapshot of the RALPH state machine. Every phase returns a
 * patched copy (`patchState`); no phase mutates its input.
 */
export interface RalphState {
  /** The original task/goal the loop is solving. */
  task: string;
  /** Working set of generated files: path → content. */
  files: Record<string, string>;
  /** Shell command that verifies the current files. */
  testCmd: string;
  /** Latest test run; null before the first Handle. */
  executionOutput: RalphExecutionOutput | null;
  /** Reflect-node output (root-cause analysis, or "验证通过"). */
  reflection: string | null;
  /** Accumulated negative constraints extracted by Learn. */
  lessonsLearned: string[];
  /** Plan-node output for the current cycle. */
  plan: string | null;
  /** Assess-node verdict; true only when the gate passed. */
  isPassed: boolean;
  /** Completed cycle count. */
  cycle: number;
  /** True when the loop stopped due to the total deadline rather than gate/cycle-cap. */
  timedOut?: boolean;
}

/** Plugin configuration (all fields optional; engine defaults apply). */
export interface RalphPluginConfig {
  /** Hard upper bound on plan→test cycles. Default 5. */
  maxCycles?: number;
  /** Run the LLM reflection node on test failure; false keeps a deterministic stderr excerpt. Default true. */
  autoReflectOnFailure?: boolean;
  /** Emit per-phase log lines through the harness logger. Default false. */
  verboseLogging?: boolean;
  /** LLM provider route for the RALPH nodes. Required at execution time. */
  provider?: string;
  /** LLM model id for the RALPH nodes. Required at execution time. */
  model?: string;
  /** Handle 节点代码生成的 maxTokens 硬上限。0/缺省 = 不设（provider 默认）。
   *  设小可防单轮生成失控，代价是截断的 JSON 会走失败周期自愈（多耗一轮）。 */
  codegenMaxTokens?: number;
  /** Per-test-command deadline in ms. Default 120000. */
  testTimeoutMs?: number;
  /** Sandbox base directory; defaults to a fresh OS temp dir per execution. */
  sandboxDir?: string;
  /** Total wall-clock budget for one full loop in ms. Default 1800000 (30min). */
  totalTimeoutMs?: number;
}

/** Per-execute overrides layered over plugin config. */
export interface RalphExecuteOptions {
  maxCycles?: number;
  provider?: string;
  model?: string;
  /** Total wall-clock budget override for this execution (ms). */
  deadlineMs?: number;
  /** Caller-owned cooperative cancellation for this execution. */
  signal?: AbortSignal;
}

export interface RalphStartEvent {
  task: string;
  state: RalphState;
}

export interface RalphCycleStartEvent {
  cycle: number;
  state: RalphState;
}

export interface RalphReflectEvent {
  cycle: number;
  reflection: string;
}

export interface RalphLearnEvent {
  cycle: number;
  lesson: string;
}

export interface RalphSuccessEvent {
  cycle: number;
  state: RalphState;
}

export interface RalphCycleEndEvent {
  cycle: number;
  state: RalphState;
}

export interface RalphEndEvent {
  state: RalphState;
}
