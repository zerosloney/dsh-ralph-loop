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
  // 防御 0/负数覆盖：至少执行 1 个周期；上限钳到 MAX_CYCLES_CAP——工具参数与插件
  // 配置都不可信，每周期 3-4 次 LLM 调用，无上限即配额黑洞（schema 层另有一道 maximum）。
  const maxCycles = Math.min(
    MAX_CYCLES_CAP,
    Math.max(1, options.maxCycles ?? config.maxCycles ?? DEFAULT_MAX_CYCLES),
  );
  // 总预算：覆盖任意来源（配置或调用方），到点优雅终止（isPassed 保持 false），
  // 防止 llm.stream 挂起或超长循环把工具调用钉死。
  const deadline = Date.now() + Math.max(
    0,
    options.deadlineMs ?? config.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS,
  );
  const provider = options.provider ?? config.provider;
  const model = options.model ?? config.model;
  if (!provider || !model) {
    throw new Error(
      "ralph: no LLM route configured; set provider/model in plugin config or per-call options",
    );
  }

  let state = initialState(task, testCmd, initialFiles);
  ctx.emit("ralph/start", { task, state });

  while (!state.isPassed && state.cycle < maxCycles) {
    if (Date.now() > deadline) {
      state = patchState(state, { timedOut: true });
      verbose(ctx, config, `total deadline reached after ${state.cycle} cycle(s)`);
      break;
    }
    state = patchState(state, { cycle: state.cycle + 1 });
    ctx.emit("ralph/cycle-start", { cycle: state.cycle, state });
    verbose(ctx, config, `cycle ${state.cycle}/${maxCycles} start`);

    // Plan: next concrete code-change scheme, constrained by accumulated lessons.
    const plan = await chatText(ctx, {
      provider,
      model,
      prompt: planPrompt(state),
    }, 1);
    state = patchState(state, { plan });
    verbose(ctx, config, `plan: ${plan.slice(0, 200)}`);

    // Handle: generate the full file set, write it into the sandbox, run the test.
    state = await nodeHandle(ctx, sandbox, provider, model, state, config.codegenMaxTokens);
    verbose(
      ctx,
      config,
      `execution exit=${state.executionOutput?.exitCode} stderr=${(state.executionOutput?.stderr ?? "").slice(0, 300)}`,
    );

    // Reflect: root-cause the latest outcome.
    const reflection = await nodeReflect(ctx, provider, model, state, config);
    state = patchState(state, { reflection });
    ctx.emit("ralph/reflect", { cycle: state.cycle, reflection });
    verbose(ctx, config, `reflect: ${reflection.slice(0, 200)}`);

    // Assess: objective gate — exit code 0 only.
    state = patchState(state, { isPassed: nodeAssess(state) });

    if (state.isPassed) {
      ctx.emit("ralph/success", { cycle: state.cycle, state });
      verbose(ctx, config, `cycle ${state.cycle} passed`);
      break;
    }

    // Learn: distill one negative constraint for the next cycle.
    // 预算检查放在 Learn 前：Reflect 之后若已超时，省掉最后一次模型调用直接收口。
    if (Date.now() > deadline) {
      state = patchState(state, { timedOut: true });
      verbose(ctx, config, `total deadline reached after ${state.cycle} cycle(s)`);
      break;
    }
    const lesson = await nodeLearn(ctx, provider, model, state);
    if (lesson) {
      state = patchState(state, {
        lessonsLearned: [...state.lessonsLearned, lesson],
      });
      ctx.emit("ralph/learn", { cycle: state.cycle, lesson });
    }
    ctx.emit("ralph/cycle-end", { cycle: state.cycle, state });
  }

  ctx.emit("ralph/end", { state });
  return state;
}

/** Handle: generate complete file JSON, write all files, run the test command. */
async function nodeHandle(
  ctx: Context,
  sandbox: RalphSandbox,
  provider: string,
  model: string,
  state: RalphState,
  codegenMaxTokens?: number,
): Promise<RalphState> {
  const { system, prompt } = codegenPrompt(state.plan ?? "");
  let updatedFiles: Record<string, string> = { ...state.files };
  try {
    // codegenMaxTokens>0 时给 Handle 节点设硬上限（防单轮生成失控）；截断的 JSON
    // 会走失败周期自愈，不中断 loop。
    const generated = await chatJson(ctx, {
      provider,
      model,
      system,
      prompt,
      maxTokens: codegenMaxTokens && codegenMaxTokens > 0
        ? codegenMaxTokens
        : undefined,
    });
    const entries = generated && typeof generated === "object"
      ? generated as Record<string, unknown>
      : {};
    for (const [filePath, content] of Object.entries(entries)) {
      if (typeof content !== "string") continue;
      updatedFiles[filePath] = content;
    }
  } catch (error) {
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
    for (const [filePath, content] of Object.entries(updatedFiles)) {
      // 仅当文件已写入沙箱且内容未变才跳过；首次执行沙箱为空，initialFiles 必须写入，
      // 否则 testCmd 会引用缺失文件（R7 最初实现的回归）。
      if (sandbox.hasWritten(filePath) && state.files[filePath] === content)
        continue;
      await sandbox.writeFile(filePath, content);
    }
  } catch (error) {
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
  const result = await sandbox.runBash(state.testCmd);
  return patchState(state, { files: updatedFiles, executionOutput: result });
}

/** Reflect: pass verdict is mechanical; failure analysis is LLM (or deterministic). */
async function nodeReflect(
  ctx: Context,
  provider: string,
  model: string,
  state: RalphState,
  config: RalphPluginConfig,
): Promise<string> {
  if (state.executionOutput?.exitCode === 0) return "验证通过";
  if (config.autoReflectOnFailure !== false) {
    return chatText(ctx, { provider, model, prompt: reflectPrompt(state) }, 1);
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
): Promise<string> {
  const lesson = await chatText(ctx, { provider, model, prompt: learnPrompt(state) }, 1);
  return lesson.trim();
}

function verbose(ctx: Context, config: RalphPluginConfig, message: string): void {
  if (config.verboseLogging) ctx.logger.info(`[ralph] ${message}`);
}
