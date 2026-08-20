/**
 * The RALPH five-phase state machine: Plan → Handle → Reflect → Assess →
 * Learn, looped until the Assess gate passes or the hard cycle cap is hit.
 * Every phase patches an immutable state copy; lifecycle events go to the
 * harness event bus (design doc §2 全链路可观测性).
 */
import type { Context } from "@deepseek-ai/cordis";
import { chatJson, chatText } from "./chat.js";
import {
  DEFAULT_MAX_CYCLES,
  DEFAULT_TOTAL_TIMEOUT_MS,
  MAX_CYCLES_CAP,
  applyContentPatch,
  codegenPrompt,
  initialState,
  learnPrompt,
  mechanicalReflection,
  patchState,
  planPrompt,
  reflectPrompt,
} from "./pure.js";
import type { RalphSandbox } from "./sandbox.js";
import type {
  RalphExecuteOptions,
  RalphPluginConfig,
  RalphState,
} from "./types.js";

const MAX_TIMER_DELAY_MS = 2_147_483_647;

export interface EngineDeps {
  ctx: Context;
  sandbox: RalphSandbox;
  config: RalphPluginConfig;
}

export async function runRalphLoop(
  deps: EngineDeps,
  task: string,
  testCmd: string,
  initialFiles: Record<string, string>,
  options: RalphExecuteOptions = {},
): Promise<RalphState> {
  const { ctx, sandbox, config } = deps;
  const callerSignal = options.signal;
  callerSignal?.throwIfAborted();

  // 防御 0/负数覆盖：至少执行 1 个周期；上限钳到 MAX_CYCLES_CAP——工具参数与插件
  // 配置都不可信，每周期 3-4 次 LLM 调用，无上限即配额黑洞（schema 层另有一道 maximum）。
  const maxCycles = Math.min(
    MAX_CYCLES_CAP,
    Math.max(1, options.maxCycles ?? config.maxCycles ?? DEFAULT_MAX_CYCLES),
  );
  // 总预算：覆盖任意来源（配置或调用方），到点优雅终止（isPassed 保持 false），
  // 防止 llm.stream 挂起或超长循环把工具调用钉死。
  const deadlineMs = Math.max(
    0,
    options.deadlineMs ?? config.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS,
  );
  const deadline = Date.now() + deadlineMs;
  // 空串与配置 schema 的 '' = 未设置 约定一致：per-call 传 '' 视为未提供，
  // 回退插件配置；两者皆空才在下方报 no LLM route。
  const provider = options.provider || config.provider;
  const model = options.model || config.model;
  if (!provider || !model) {
    throw new Error(
      "ralph: no LLM route configured; set provider/model in plugin config or per-call options",
    );
  }

  const deadlineController = new AbortController();
  const deadlineReason = new Error("ralph: total deadline exceeded");
  const signal = callerSignal === undefined
    ? deadlineController.signal
    : AbortSignal.any([callerSignal, deadlineController.signal]);
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  let endEmitted = false;
  let timeoutFinalized = false;
  const emitEnd = (state: RalphState): void => {
    if (endEmitted) return;
    endEmitted = true;
    ctx.emit("ralph/end", { state });
  };

  let state = initialState(task, testCmd, initialFiles);
  const finishTimedOut = (): RalphState => {
    timeoutFinalized = true;
    state = patchState(state, { timedOut: true });
    verbose(ctx, config, `total deadline reached after ${state.cycle} cycle(s)`);
    callerSignal?.throwIfAborted();
    emitEnd(state);
    return state;
  };
  const armDeadlineTimer = (): void => {
    const remaining = deadline - Date.now();
    if (remaining <= 0 || Number.isNaN(remaining)) {
      deadlineController.abort(deadlineReason);
      return;
    }
    deadlineTimer = setTimeout(
      () => {
        deadlineTimer = undefined;
        armDeadlineTimer();
      },
      Math.min(remaining, MAX_TIMER_DELAY_MS),
    );
  };

  try {
    armDeadlineTimer();

    ctx.emit("ralph/start", { task, state });
    signal.throwIfAborted();

    while (!state.isPassed && state.cycle < maxCycles) {
      signal.throwIfAborted();
      if (deadlineController.signal.aborted || Date.now() > deadline) {
        if (callerSignal?.aborted) callerSignal.throwIfAborted();
        if (!deadlineController.signal.aborted) deadlineController.abort(deadlineReason);
        return finishTimedOut();
      }
      state = patchState(state, { cycle: state.cycle + 1 });
      ctx.emit("ralph/cycle-start", { cycle: state.cycle, state });
      signal.throwIfAborted();
      verbose(ctx, config, `cycle ${state.cycle}/${maxCycles} start`);

      // Plan: next concrete code-change scheme, constrained by accumulated lessons.
      signal.throwIfAborted();
      const plan = await chatText(ctx, {
        provider,
        model,
        prompt: planPrompt(state),
      }, 1, signal);
      signal.throwIfAborted();
      state = patchState(state, { plan });
      verbose(ctx, config, `plan: ${plan.slice(0, 200)}`);

      // Handle: generate the full file set, write it into the sandbox, run the test.
      signal.throwIfAborted();
      state = await nodeHandle(
        ctx,
        sandbox,
        provider,
        model,
        state,
        config.codegenMaxTokens,
        signal,
      );
      signal.throwIfAborted();
      verbose(
        ctx,
        config,
        `execution exit=${state.executionOutput?.exitCode} stderr=${(state.executionOutput?.stderr ?? "").slice(0, 300)}`,
      );

      // Reflect: root-cause the latest outcome.
      signal.throwIfAborted();
      const reflection = await nodeReflect(ctx, provider, model, state, config, signal);
      signal.throwIfAborted();
      state = patchState(state, { reflection });
      ctx.emit("ralph/reflect", { cycle: state.cycle, reflection });
      signal.throwIfAborted();
      verbose(ctx, config, `reflect: ${reflection.slice(0, 200)}`);

      // Assess: objective gate — exit code 0 only.
      signal.throwIfAborted();
      state = patchState(state, { isPassed: nodeAssess(state) });
      signal.throwIfAborted();

      if (state.isPassed) {
        ctx.emit("ralph/success", { cycle: state.cycle, state });
        signal.throwIfAborted();
        verbose(ctx, config, `cycle ${state.cycle} passed`);
        break;
      }

      // Learn: distill one negative constraint for the next cycle.
      // 预算检查放在 Learn 前：Reflect 之后若已超时，省掉最后一次模型调用直接收口。
      signal.throwIfAborted();
      if (deadlineController.signal.aborted || Date.now() > deadline) {
        if (callerSignal?.aborted) callerSignal.throwIfAborted();
        if (!deadlineController.signal.aborted) deadlineController.abort(deadlineReason);
        return finishTimedOut();
      }
      signal.throwIfAborted();
      const lesson = await nodeLearn(ctx, provider, model, state, signal);
      signal.throwIfAborted();
      if (lesson) {
        state = patchState(state, {
          lessonsLearned: [...state.lessonsLearned, lesson],
        });
        ctx.emit("ralph/learn", { cycle: state.cycle, lesson });
        signal.throwIfAborted();
      }
      ctx.emit("ralph/cycle-end", { cycle: state.cycle, state });
      signal.throwIfAborted();
    }

    if (deadlineController.signal.aborted) return finishTimedOut();
    signal.throwIfAborted();
    emitEnd(state);
    return state;
  } catch (error) {
    if (callerSignal?.aborted) callerSignal.throwIfAborted();
    if (deadlineController.signal.aborted) {
      if (timeoutFinalized) throw error;
      return finishTimedOut();
    }
    throw error;
  } finally {
    if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
  }
}

/** Handle: generate complete file JSON, write all files, run the test command. */
async function nodeHandle(
  ctx: Context,
  sandbox: RalphSandbox,
  provider: string,
  model: string,
  state: RalphState,
  codegenMaxTokens?: number,
  signal?: AbortSignal,
): Promise<RalphState> {
  signal?.throwIfAborted();
  const { system, prompt } = codegenPrompt(state.plan ?? "");
  let updatedFiles: Record<string, string> = { ...state.files };
  try {
    // codegenMaxTokens>0 时给 Handle 节点设硬上限（防单轮生成失控）；截断的 JSON
    // 会走失败周期自愈（chatJson 把截断原因显式写进失败反馈），不中断 loop。
    // retries=1 与 Plan/Reflect/Learn 对齐：瞬时网络错误退避一次而非烧掉整个失败
    // 周期；截断/解析错误发生在 chatText 之外，不会被这里重试（确定性失败重试
    // 无意义）。
    const generated = await chatJson(ctx, {
      provider,
      model,
      system,
      prompt,
      maxTokens: codegenMaxTokens && codegenMaxTokens > 0
        ? codegenMaxTokens
        : undefined,
    }, 1, signal);
    signal?.throwIfAborted();
    const entries = generated && typeof generated === "object"
      ? generated as Record<string, unknown>
      : {};
    let appliedEntries = 0;
    for (const [filePath, content] of Object.entries(entries)) {
      if (typeof content !== "string" && (typeof content !== "object" || content === null)) continue;
      const original = state.files[filePath] ?? "";
      try {
        const updated = applyContentPatch(original, content);
        updatedFiles[filePath] = updated;
        appliedEntries += 1;
      } catch (patchErr) {
        throw new Error(`文件 "${filePath}" 补丁应用失败: ${(patchErr as Error).message}`);
      }
    }
    // 形状完全不对（空对象/非对象顶层）时若继续，会用旧文件跑测试，Reflect
    // 看不到任何"JSON 形状错了"的反馈，白烧一个周期——按解析失败进入自愈。
    if (appliedEntries === 0) {
      throw new Error("generated JSON has no valid file entries or patches");
    }
  } catch (error) {
    signal?.throwIfAborted();
    if (isAbortError(error)) throw error;
    // Generation/parse failure is a failed cycle: feed it through Reflect/Learn
    // so the loop self-heals instead of throwing.
    return patchState(state, {
      executionOutput: {
        stdout: "",
        stderr: `RALPH 方案解析失败: ${(error as Error).message}`,
        exitCode: 1,
      },
    });
  }
  try {
    signal?.throwIfAborted();
    for (const [filePath, content] of Object.entries(updatedFiles)) {
      // 仅当文件已写入沙箱且内容未变才跳过；首次执行沙箱为空，initialFiles 必须写入，
      // 否则 testCmd 会引用缺失文件（R7 最初实现的回归）。
      if (sandbox.hasWritten(filePath) && state.files[filePath] === content)
        continue;
      await sandbox.writeFile(filePath, content);
    }
  } catch (error) {
    signal?.throwIfAborted();
    if (isAbortError(error)) throw error;
    // 路径违规/写盘失败与解析失败同语义：作为一次失败循环进入 Reflect/Learn 自愈，
    // 而非中止整个 loop（与"路径守卫拒绝"设计意图一致）。
    return patchState(state, {
      executionOutput: {
        stdout: "",
        stderr: `RALPH 写入失败: ${(error as Error).message}`,
        exitCode: 1,
      },
    });
  }
  signal?.throwIfAborted();
  const result = await sandbox.runBash(state.testCmd, signal);
  signal?.throwIfAborted();
  return patchState(state, { files: updatedFiles, executionOutput: result });
}

/** Reflect: pass verdict is mechanical; failure analysis is LLM (or deterministic). */
async function nodeReflect(
  ctx: Context,
  provider: string,
  model: string,
  state: RalphState,
  config: RalphPluginConfig,
  signal?: AbortSignal,
): Promise<string> {
  if (state.executionOutput?.exitCode === 0) return "验证通过";
  if (config.autoReflectOnFailure !== false) {
    return chatText(ctx, { provider, model, prompt: reflectPrompt(state) }, 1, signal);
  }
  return mechanicalReflection(state);
}

/** Assess: the objective gate — exit code 0 and nothing else. */
function nodeAssess(state: RalphState): boolean {
  return state.executionOutput?.exitCode === 0;
}

/** Learn: one actionable negative constraint from the latest reflection. */
async function nodeLearn(
  ctx: Context,
  provider: string,
  model: string,
  state: RalphState,
  signal?: AbortSignal,
): Promise<string> {
  const lesson = await chatText(ctx, { provider, model, prompt: learnPrompt(state) }, 1, signal);
  return lesson.trim();
}

function isAbortError(error: unknown): boolean {
  if (error === null || typeof error !== "object") return false;
  const candidate = error as { name?: unknown; code?: unknown };
  return candidate.name === "AbortError" || candidate.code === "ABORT_ERR";
}

function verbose(ctx: Context, config: RalphPluginConfig, message: string): void {
  if (config.verboseLogging) ctx.logger.info(`[ralph] ${message}`);
}
