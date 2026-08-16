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

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(signal?.reason);
    };
    timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

function isAbortError(error: unknown): boolean {
  if (error === null || typeof error !== "object") return false;
  const candidate = error as { name?: unknown; code?: unknown };
  return candidate.name === "AbortError" || candidate.code === "ABORT_ERR";
}

/** One assembled text completion from the harness LLM seam. transient LLM 错误（限流/网络）退避重试 retries 次后仍失败才上抛。 */
export async function chatText(
  ctx: Context,
  opts: ChatOptions,
  retries = 0,
  signal?: AbortSignal,
): Promise<string> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    signal?.throwIfAborted();
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
        signal,
      });
      signal?.throwIfAborted();
      const assembler = new BlockAssembler();
      for await (const chunk of stream) {
        signal?.throwIfAborted();
        assembler.push(chunk);
      }
      signal?.throwIfAborted();
      // harness 语义：适配器/路由错误不抛异常，而是以终止性 finish 块（kind =
      // 'error'/'aborted'）结束流——不检查它，provider 配错会静默返回空串，重试
      // 与引擎的失败自愈全部失效。普通 error 转成异常交给退避重试和失败周期；
      // aborted 保留中止语义，不进入重试。
      const finish = assembler.finish;
      if (finish.kind === "aborted") {
        signal?.throwIfAborted();
        const abortError = new Error(
          `ralph: LLM 流式请求已中止（${finish.failure.code}）：${finish.failure.message}`,
        );
        abortError.name = "AbortError";
        throw abortError;
      }
      if (finish.kind === "error") {
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
      signal?.throwIfAborted();
      if (isAbortError(error)) throw error;
      lastError = error;
      if (attempt < retries) await sleep(500 * 2 ** attempt, signal);
    }
  }
  throw lastError;
}

/** One completion parsed as the first top-level JSON value. */
export async function chatJson(
  ctx: Context,
  opts: ChatOptions,
  retries = 0,
  signal?: AbortSignal,
): Promise<unknown> {
  const text = await chatText(ctx, opts, retries, signal);
  signal?.throwIfAborted();
  return extractJson(text);
}
