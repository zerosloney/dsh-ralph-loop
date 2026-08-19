/**
 * Pure helpers of the RALPH loop: state construction, immutable patching,
 * prompt assembly, and tolerant JSON extraction. No imports — unit-testable
 * and safe to run outside a harness context.
 */
import type { RalphExecutionOutput, RalphState } from "./types.js";

export const DEFAULT_MAX_CYCLES = 5;
export const DEFAULT_TEST_TIMEOUT_MS = 120_000;
/** 单次调用允许的最大周期数上限：每周期 3-4 次 LLM 调用，无上限的 maxCycles 会被
 *  自主 agent 的误调用变成配额黑洞（工具 schema 与引擎双重钳制）。 */
export const MAX_CYCLES_CAP = 20;
/** 整个闭环的总预算（wall clock），防止 llm.stream 挂起或超长循环把工具调用钉死。 */
export const DEFAULT_TOTAL_TIMEOUT_MS = 30 * 60_000;

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

/**
 * Format the captured test output for prompts. Tail-truncated: test frameworks
 * (pytest/jest/go test) print failure summaries at the END of stdout, and the
 * stderr-only view of old code left the loop blind on those stacks.
 */
export function formatTestOutput(
  output: RalphExecutionOutput | null,
  maxChars = 4_000,
): string {
  if (!output) return "初始启动";
  const tail = (s: string): string =>
    s.length <= maxChars ? s : `…${s.slice(-maxChars)}`;
  return `exit=${output.exitCode}\n--- stdout ---\n${tail(output.stdout)}\n--- stderr ---\n${tail(output.stderr)}`;
}

/** Assemble the Plan-node prompt: task, current files, latest outcome, lessons. */
export function planPrompt(state: RalphState): string {
  const uniqueLessons = Array.from(
    new Set(state.lessonsLearned.map((l) => l.trim())),
  ).filter(Boolean);
  const memory =
    uniqueLessons.length > 0
      ? `\n【历史教训/负向约束】:\n${uniqueLessons
          .map((l, i) => `${i + 1}. ${l}`)
          .join("\n")}`
      : "";
  return `任务: ${state.task}\n当前代码: ${JSON.stringify(state.files)}\n上次执行:\n${formatTestOutput(state.executionOutput)}${memory}\n请给出修改方案。`;
}

/**
 * Applies a code patch or replaces content directly. Supports:
 * 1. Direct replacement string
 * 2. Search & replace structured object: { search: string, replace: string }
 * 3. Search/replace marker blocks: <<<<<<< SEARCH ... ======= ... >>>>>>> REPLACE
 */
export function applyContentPatch(
  original: string,
  patchOrContent: unknown,
): string {
  if (typeof patchOrContent === "string") {
    // Check for SEARCH/REPLACE block format
    if (
      patchOrContent.includes("<<<<<<< SEARCH") &&
      patchOrContent.includes("=======") &&
      patchOrContent.includes(">>>>>>> REPLACE")
    ) {
      let result = original;
      const regex =
        /<<<<<<< SEARCH\r?\n([\s\S]*?)\r?\n=======\r?\n([\s\S]*?)\r?\n>>>>>>> REPLACE/g;
      let match: RegExpExecArray | null;
      let applied = false;
      while ((match = regex.exec(patchOrContent)) !== null) {
        const search = match[1];
        const replace = match[2];
        if (result.includes(search)) {
          result = result.replace(search, replace);
          applied = true;
        } else {
          throw new Error(
            `Search block not found in original file: ${search.slice(0, 80)}`,
          );
        }
      }
      if (!applied) {
        throw new Error("No matching search block could be applied");
      }
      return result;
    }
    return patchOrContent;
  }
  if (patchOrContent && typeof patchOrContent === "object") {
    const obj = patchOrContent as Record<string, unknown>;
    if (typeof obj.search === "string" && typeof obj.replace === "string") {
      if (!original.includes(obj.search)) {
        throw new Error(
          `Search block not found in original file: ${obj.search.slice(0, 80)}`,
        );
      }
      return original.replace(obj.search, obj.replace);
    }
  }
  throw new Error("Invalid file content or patch format");
}

/** Handle-node code generation prompt: plan in, strict file-JSON out. */
export function codegenPrompt(plan: string): { system: string; prompt: string } {
  return {
    system:
      "你是一个代码生成器。只输出一个 JSON 对象：键为文件路径，值为完整文件内容或增量补丁（字符串或 {search, replace} 对象）。不要输出任何其他文本、注释或 markdown 围栏。禁止包裹结构：顶层必须直接是 {文件路径: 内容}。",
    prompt: `根据方案: ${plan}，输出代码 JSON: {"path": "content"} 或 {"path": {"search": "old", "replace": "new"}}。
正确: {"src/main.py": "print('hi')"}
错误: {"files": {"src/main.py": "print('hi')"}}（多了包裹层）`,
  };
}

/** Reflect-node prompt: root-cause analysis of the latest failure. */
export function reflectPrompt(state: RalphState): string {
  return `目标: ${state.task}\n上次执行:\n${formatTestOutput(state.executionOutput)}\n请分析失败直接原因。`;
}

/** Learn-node prompt: distill one actionable negative constraint. */
export function learnPrompt(state: RalphState): string {
  return `任务: ${state.task}\n反思: ${state.reflection ?? ""}\n请提炼一条下轮必须遵守的避坑规则:`;
}

/** Deterministic reflect fallback when autoReflectOnFailure is off. */
export function mechanicalReflection(state: RalphState): string {
  const output = formatTestOutput(state.executionOutput, 500);
  return output.length > 500 ? `${output.slice(0, 500)}…` : output;
}
