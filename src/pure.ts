/**
 * Pure helpers of the RALPH loop: state construction, immutable patching,
 * prompt assembly, and tolerant JSON extraction. No imports — unit-testable
 * and safe to run outside a harness context.
 */
import type { RalphState } from "./types.js";

export const DEFAULT_MAX_CYCLES = 5;
export const DEFAULT_TEST_TIMEOUT_MS = 120_000;

export function initialState(
  task: string,
  testCmd: string,
  files: Record<string, string>,
): RalphState {
  return {
    task,
    files: { ...files },
    testCmd,
    executionOutput: null,
    reflection: null,
    lessonsLearned: [],
    plan: null,
    isPassed: false,
    cycle: 0,
  };
}

/** Immutable patch: returns a new state with the given fields replaced. */
export function patchState(
  state: RalphState,
  patch: Partial<Omit<RalphState, "task" | "testCmd">>,
): RalphState {
  // Every snapshot owns its file map, so a later patch can never rewrite an
  // already-emitted state (event-sourced replay requires stable snapshots).
  return { ...state, files: { ...state.files }, ...patch };
}

/**
 * Extract the first top-level JSON value from model output. Tolerates
 * markdown code fences, prose around the payload, and leading/trailing junk.
 * @throws when no balanced JSON value is found.
 */
export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidates = [fenced ?? "", text].filter((c) => c.trim().length > 0);
  for (const candidate of candidates) {
    const trimmed = candidate.trim();
    try {
      return JSON.parse(trimmed);
    } catch {
      // fall through to brace scanning
    }
    const start = trimmed.search(/[\[{]/);
    if (start >= 0) {
      try {
        return JSON.parse(balancedSlice(trimmed, start));
      } catch {
        // try the next candidate
      }
    }
  }
  throw new Error(`ralph: no JSON value found in model output`);
}

/** Slice `text` from `start` through the matching closing bracket, string-aware. */
function balancedSlice(text: string, start: number): string {
  const open = text[start];
  const close = open === "[" ? "]" : "}";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return text.slice(start);
}

/** Assemble the Plan-node prompt: task, current files, latest error, lessons. */
export function planPrompt(state: RalphState): string {
  const memory =
    state.lessonsLearned.length > 0
      ? `\n【历史教训/负向约束】:\n${state.lessonsLearned
          .map((l, i) => `${i + 1}. ${l}`)
          .join("\n")}`
      : "";
  return `任务: ${state.task}\n当前代码: ${JSON.stringify(state.files)}\n错误: ${state.executionOutput?.stderr || "初始启动"}${memory}\n请给出修改方案。`;
}

/** Handle-node code generation prompt: plan in, strict file-JSON out. */
export function codegenPrompt(plan: string): { system: string; prompt: string } {
  return {
    system:
      "你是一个代码生成器。只输出一个 JSON 对象：键为文件路径，值为完整文件内容。不要输出任何其他文本、注释或 markdown 围栏。",
    prompt: `根据方案: ${plan}，输出完整代码 JSON: {"path": "content"}`,
  };
}

/** Reflect-node prompt: root-cause analysis of the latest failure. */
export function reflectPrompt(state: RalphState): string {
  return `目标: ${state.task}\n错误: ${state.executionOutput?.stderr ?? ""}\n请分析失败直接原因。`;
}

/** Learn-node prompt: distill one actionable negative constraint. */
export function learnPrompt(state: RalphState): string {
  return `任务: ${state.task}\n反思: ${state.reflection ?? ""}\n请提炼一条下轮必须遵守的避坑规则:`;
}

/** Deterministic reflect fallback when autoReflectOnFailure is off. */
export function mechanicalReflection(state: RalphState): string {
  const stderr = (state.executionOutput?.stderr ?? "").trim();
  return stderr.length > 500 ? `stderr 片段: ${stderr.slice(0, 500)}…` : `stderr: ${stderr}`;
}
