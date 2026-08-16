/**
 * Tool Bridge (design doc §2): registers `run_ralph_loop` so the harness LLM
 * can trigger a RALPH sub-loop autonomously. The returned state carries the
 * verified file set and accumulated negative constraints for the caller to
 * apply or report.
 */
import type { Context } from "@deepseek-ai/cordis";
import type { ContentBlock } from "@deepseek-ai/dsh-llm";
import { defineTool, type JsonValue } from "@deepseek-ai/dsh-tools";
import type { RalphExecuteOptions, RalphPluginConfig, RalphState } from "./types.js";

export interface RalphToolParams {
  task: string;
  testCmd: string;
  files?: Record<string, string>;
  maxCycles?: number;
  provider?: string;
  model?: string;
  /** Caller-owned cancellation forwarded from the Harness tool execution. */
  signal?: AbortSignal;
}

export type RalphRunner = (params: RalphToolParams) => Promise<RalphState>;

/**
 * Model-facing limits. The service result is deliberately not passed through
 * these limits; they only protect the tool/LLM context boundary.
 */
const TOOL_MAX_FILE_COUNT = 32;
const TOOL_MAX_FILE_CHARS = 16_000;
const TOOL_MAX_TOTAL_FILE_CHARS = 64_000;
const TOOL_MAX_PLAN_CHARS = 8_000;
const TOOL_MAX_REFLECTION_CHARS = 8_000;
const TOOL_MAX_LESSON_COUNT = 32;
const TOOL_MAX_LESSON_CHARS = 4_000;
const TOOL_MAX_TOTAL_LESSON_CHARS = 32_000;
const TOOL_MAX_EXECUTION_OUTPUT_CHARS = 8_000;
const FILE_OMISSION_MARKER_KEY = "__dsh_ralph_tool_omitted_files__";

function jsonContent(value: unknown): ContentBlock[] {
  return [{ type: "text", text: JSON.stringify(value, null, 2) }];
}

const toJson = (value: unknown): JsonValue => value as unknown as JsonValue;

/**
 * Tool-boundary view of the final state: generated files, phase text, lessons,
 * and stdout/stderr are bounded so one large loop result can't blow up the LLM
 * context. The full state stays available to service-level callers via
 * `ctx.ralph.execute()`.
 */
function truncationMarker(originalLength: number): string {
  return `[dsh-ralph tool output truncated; originalLength=${originalLength}]`;
}

/** Keep the marker within the limit so every returned field is bounded. */
function truncateText(
  text: string,
  maxChars: number,
  direction: "head" | "tail" = "head",
): string {
  if (text.length <= maxChars) return text;
  const marker = truncationMarker(text.length);
  const keep = Math.max(0, maxChars - marker.length);
  if (direction === "tail") {
    return `${marker}${text.slice(-keep)}`.slice(0, maxChars);
  }
  return `${text.slice(0, keep)}${marker}`.slice(0, maxChars);
}

function omissionMarker(
  kind: "files" | "lessons",
  originalCount: number,
  omittedCount: number,
): string {
  return `[dsh-ralph tool output omitted ${kind}; originalCount=${originalCount}; omittedCount=${omittedCount}]`;
}

function uniqueFileMarkerKey(files: Record<string, string>): string {
  let key = FILE_OMISSION_MARKER_KEY;
  let suffix = 2;
  while (Object.hasOwn(files, key)) {
    key = `${FILE_OMISSION_MARKER_KEY}_${suffix}`;
    suffix += 1;
  }
  return key;
}

/**
 * Summarize generated files without changing the service-level state. A
 * reserved marker entry keeps omission visible while preserving the `files`
 * object shape expected by tool callers.
 */
function summarizeFiles(files: Record<string, string>): Record<string, string> {
  const entries = Object.entries(files);
  if (entries.length === 0) return {};

  const originalTotalChars = entries.reduce((total, [, content]) => total + content.length, 0);
  const mayNeedOmissionMarker =
    entries.length > TOOL_MAX_FILE_COUNT || originalTotalChars > TOOL_MAX_TOTAL_FILE_CHARS;
  const markerReservation = mayNeedOmissionMarker
    ? omissionMarker("files", entries.length, entries.length).length
    : 0;
  const totalLimit = Math.max(0, TOOL_MAX_TOTAL_FILE_CHARS - markerReservation);
  const actualFileLimit = entries.length > TOOL_MAX_FILE_COUNT
    ? TOOL_MAX_FILE_COUNT - 1
    : TOOL_MAX_FILE_COUNT;

  const summarized: Record<string, string> = {};
  let totalChars = 0;
  let nextIndex = 0;
  for (; nextIndex < entries.length && Object.keys(summarized).length < actualFileLimit; nextIndex += 1) {
    const [path, content] = entries[nextIndex];
    const remaining = totalLimit - totalChars;
    if (remaining <= 0) break;
    const contentLimit = Math.min(TOOL_MAX_FILE_CHARS, remaining);
    if (content.length > contentLimit && contentLimit < truncationMarker(content.length).length) {
      break;
    }
    const summary = truncateText(content, contentLimit);
    if (summary.length > remaining) break;
    summarized[path] = summary;
    totalChars += summary.length;
  }

  const omittedCount = entries.length - nextIndex;
  if (omittedCount > 0) {
    const marker = omissionMarker("files", entries.length, omittedCount);
    // markerReservation is based on the largest possible omitted count and
    // therefore leaves enough room for this entry in the total budget.
    summarized[uniqueFileMarkerKey(files)] = marker;
  }
  return summarized;
}

function summarizeLessons(lessons: string[]): string[] {
  if (lessons.length === 0) return [];

  const originalTotalChars = lessons.reduce((total, lesson) => total + lesson.length, 0);
  const mayNeedOmissionMarker =
    lessons.length > TOOL_MAX_LESSON_COUNT || originalTotalChars > TOOL_MAX_TOTAL_LESSON_CHARS;
  const markerReservation = mayNeedOmissionMarker
    ? omissionMarker("lessons", lessons.length, lessons.length).length
    : 0;
  const totalLimit = Math.max(0, TOOL_MAX_TOTAL_LESSON_CHARS - markerReservation);
  const actualLessonLimit = lessons.length > TOOL_MAX_LESSON_COUNT
    ? TOOL_MAX_LESSON_COUNT - 1
    : TOOL_MAX_LESSON_COUNT;

  const summarized: string[] = [];
  let totalChars = 0;
  let nextIndex = 0;
  for (; nextIndex < lessons.length && summarized.length < actualLessonLimit; nextIndex += 1) {
    const remaining = totalLimit - totalChars;
    if (remaining <= 0) break;
    const lessonLimit = Math.min(TOOL_MAX_LESSON_CHARS, remaining);
    if (lessons[nextIndex].length > lessonLimit && lessonLimit < truncationMarker(lessons[nextIndex].length).length) {
      break;
    }
    const summary = truncateText(lessons[nextIndex], lessonLimit);
    if (summary.length > remaining) break;
    summarized.push(summary);
    totalChars += summary.length;
  }

  const omittedCount = lessons.length - nextIndex;
  if (omittedCount > 0) {
    summarized.push(omissionMarker("lessons", lessons.length, omittedCount));
  }
  return summarized;
}

function summarizeStateForTool(state: RalphState): RalphState {
  const executionOutput = state.executionOutput
    ? {
        ...state.executionOutput,
        stdout: truncateText(
          state.executionOutput.stdout,
          TOOL_MAX_EXECUTION_OUTPUT_CHARS,
          "tail",
        ),
        stderr: truncateText(
          state.executionOutput.stderr,
          TOOL_MAX_EXECUTION_OUTPUT_CHARS,
          "tail",
        ),
      }
    : null;
  return {
    ...state,
    files: summarizeFiles(state.files),
    executionOutput,
    reflection: state.reflection === null
      ? null
      : truncateText(state.reflection, TOOL_MAX_REFLECTION_CHARS),
    lessonsLearned: summarizeLessons(state.lessonsLearned),
    plan: state.plan === null ? null : truncateText(state.plan, TOOL_MAX_PLAN_CHARS),
  };
}

export function registerRalphTools(
  ctx: Context,
  _config: RalphPluginConfig,
  run: RalphRunner,
): void {
  ctx.tools.register(defineTool({
    name: "run_ralph_loop",
    description:
      "Run the RALPH self-healing loop in an isolated sandbox: Plan → write files → run the test command → Reflect → Assess → Learn, up to max_cycles. Returns the final state: verified files, test output, reflection, and accumulated negative constraints.",
    parameters: {
      task: { type: "string", required: true, description: "The goal the loop must achieve." },
      test_cmd: { type: "string", required: true, description: "Shell command that verifies the generated code (must exit 0 to pass)." },
      files: { type: "object", additionalProperties: true, description: "Initial files as { path: content }." },
      // DSL 只支持 enum/const 做值约束（minimum/maximum 会抛 unsupported schema），
      // 1-20 的钳制用 enum 机器校验；引擎侧 MAX_CYCLES_CAP 再兜一层。
      max_cycles: { type: "integer", enum: Array.from({ length: 20 }, (_, i) => i + 1), description: "Override the hard cycle cap (allowed 1-20)." },
      provider: { type: "string", description: "LLM provider route; defaults to plugin config." },
      model: { type: "string", description: "LLM model id; defaults to plugin config." },
    },
    output: {
      schema: { type: "json" },
      render: (_args: Record<string, unknown>, value: unknown): ContentBlock[] =>
        jsonContent(value),
    },
    async execute(args, exec) {
      const files = args.files
        ? Object.fromEntries(
            Object.entries(args.files).filter(
              (entry): entry is [string, string] => typeof entry[1] === "string",
            ),
          )
        : undefined;
      const options: RalphExecuteOptions = {
        maxCycles: args.max_cycles,
        provider: args.provider,
        model: args.model,
        signal: exec?.signal,
      };
      const state = await run({
        task: args.task,
        testCmd: args.test_cmd,
        files,
        ...options,
      });
      return toJson(summarizeStateForTool(state));
    },
  }));
}
