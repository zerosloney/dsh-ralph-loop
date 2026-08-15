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
  const maxCycles = options.maxCycles ?? config.maxCycles ?? DEFAULT_MAX_CYCLES;
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
    state = patchState(state, { cycle: state.cycle + 1 });
    ctx.emit("ralph/cycle-start", { cycle: state.cycle, state });
    verbose(ctx, config, `cycle ${state.cycle}/${maxCycles} start`);

    // Plan: next concrete code-change scheme, constrained by accumulated lessons.
    const plan = await chatText(ctx, {
      provider,
      model,
      prompt: planPrompt(state),
    });
    state = patchState(state, { plan });
    verbose(ctx, config, `plan: ${plan.slice(0, 200)}`);

    // Handle: generate the full file set, write it into the sandbox, run the test.
    state = await nodeHandle(ctx, sandbox, provider, model, state);
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
): Promise<RalphState> {
  const { system, prompt } = codegenPrompt(state.plan ?? "");
  let updatedFiles: Record<string, string> = { ...state.files };
  try {
    const generated = await chatJson(ctx, { provider, model, system, prompt });
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
  for (const [filePath, content] of Object.entries(updatedFiles)) {
    await sandbox.writeFile(filePath, content);
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
    return chatText(ctx, { provider, model, prompt: reflectPrompt(state) });
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
  const lesson = await chatText(ctx, { provider, model, prompt: learnPrompt(state) });
  return lesson.trim();
}

function verbose(ctx: Context, config: RalphPluginConfig, message: string): void {
  if (config.verboseLogging) ctx.logger.info(`[ralph] ${message}`);
}
