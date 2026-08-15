/**
 * LLM adapter for the RALPH nodes. The design doc's `ctx.llm.chat(...)` maps
 * onto the harness seam: `ctx.llm.stream(GenerateOptions)` plus the canonical
 * `BlockAssembler`, with a strict-JSON variant for Handle's file generation.
 */
import type { Context } from "@deepseek-ai/cordis";
import {
  BlockAssembler,
  createUserMessage,
  type Message,
  type TextBlock,
} from "@deepseek-ai/dsh-llm";
import { extractJson } from "./pure.js";

export interface ChatOptions {
  provider: string;
  model: string;
  system?: string;
  prompt: string;
  maxTokens?: number;
}

/** One assembled text completion from the harness LLM seam. */
export async function chatText(ctx: Context, opts: ChatOptions): Promise<string> {
  const messages: Message[] = [
    createUserMessage({
      content: [{ type: "text", text: opts.prompt }],
      source: { kind: "user" },
    }),
  ];
  const stream = ctx.llm.stream({
    provider: opts.provider,
    model: opts.model,
    system: opts.system,
    messages,
    maxTokens: opts.maxTokens,
  });
  const assembler = new BlockAssembler();
  for await (const chunk of stream) {
    assembler.push(chunk);
  }
  return assembler
    .blocks()
    .filter((block): block is TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();
}

/** One completion parsed as the first top-level JSON value. */
export async function chatJson(ctx: Context, opts: ChatOptions): Promise<unknown> {
  return extractJson(await chatText(ctx, opts));
}
