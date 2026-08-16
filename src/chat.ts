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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** One assembled text completion from the harness LLM seam. transient LLM 错误（限流/网络）退避重试 retries 次后仍失败才上抛。 */
export async function chatText(
  ctx: Context,
  opts: ChatOptions,
  retries = 0,
): Promise<string> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
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
      // harness 语义：适配器/路由错误不抛异常，而是以终止性 finish 块（kind =
      // 'error'/'aborted'）结束流——不检查它，provider 配错会静默返回空串，重试
      // 与引擎的失败自愈全部失效。这里显式转成异常，让 chatText 的退避重试和
      // engine 的失败周期路径真正接手。
      const finish = assembler.finish;
      if (finish.kind === "error" || finish.kind === "aborted") {
        throw new Error(
          `ralph: LLM 流式请求失败（${finish.kind} ${finish.failure.code}）：${finish.failure.message}`,
        );
      }
      return assembler
        .blocks()
        .filter((block): block is TextBlock => block.type === "text")
        .map((block) => block.text)
        .join("")
        .trim();
    } catch (error) {
      lastError = error;
      if (attempt < retries) await sleep(500 * 2 ** attempt);
    }
  }
  throw lastError;
}

/** One completion parsed as the first top-level JSON value. */
export async function chatJson(
  ctx: Context,
  opts: ChatOptions,
  retries = 0,
): Promise<unknown> {
  return extractJson(await chatText(ctx, opts, retries));
}
