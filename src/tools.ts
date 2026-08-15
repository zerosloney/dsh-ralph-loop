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
}

export type RalphRunner = (params: RalphToolParams) => Promise<RalphState>;

function jsonContent(value: unknown): ContentBlock[] {
  return [{ type: "text", text: JSON.stringify(value, null, 2) }];
}

const toJson = (value: unknown): JsonValue => value as unknown as JsonValue;

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
      max_cycles: { type: "integer", description: "Override the hard cycle cap." },
      provider: { type: "string", description: "LLM provider route; defaults to plugin config." },
      model: { type: "string", description: "LLM model id; defaults to plugin config." },
    },
    output: {
      schema: { type: "json" },
      render: (_args: Record<string, unknown>, value: unknown): ContentBlock[] =>
        jsonContent(value),
    },
    async execute(args) {
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
      };
      const state = await run({
        task: args.task,
        testCmd: args.test_cmd,
        files,
        ...options,
      });
      return toJson(state);
    },
  }));
}
