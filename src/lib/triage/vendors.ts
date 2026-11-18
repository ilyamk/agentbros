import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { CliErrorObject } from "../cli";
import {
  modelFamily,
  TriageConfigSchema,
  UsageSchema,
  type JudgeSlot,
  type TriageConfig,
  type Usage,
} from "../../types/triage";
import { checkCaps, readLedger, reserveSpend, settleSpend } from "./ledger";
import type { JudgePrompt } from "./prompt";

const MAX_OUTPUT_TOKENS = 2048;
export type JudgeResult = { usage: Usage | null; costUsd: number } & (
  { json: unknown; abstain?: never } | { abstain: string; json?: never }
);
export interface Judge {
  judge(prompt: Pick<JudgePrompt, "system" | "user" | "schema">): Promise<JudgeResult>;
}

export function loadConfig(root = process.cwd()): TriageConfig {
  return TriageConfigSchema.parse(JSON.parse(readFileSync(path.join(root, "contrib/triage.json"), "utf8")));
}

export function priceFor(config: TriageConfig, slot: JudgeSlot): TriageConfig["pricing"][string] {
  const price = config.pricing[slot.model];
  const free = slot.provider === "openrouter" && slot.model.endsWith(":free");
  if (
    slot.model.includes("<") ||
    !price ||
    !Number.isFinite(price.inputUsdPerMtok) ||
    !Number.isFinite(price.outputUsdPerMtok) ||
    (free
      ? price.inputUsdPerMtok < 0 || price.outputUsdPerMtok < 0
      : price.inputUsdPerMtok <= 0 || price.outputUsdPerMtok <= 0)
  )
    throw new CliErrorObject({
      code: "VALIDATION",
      message: `Unknown triage price or unset model for ${slot.label} (${slot.model}); set pricing per Mtok in contrib/triage.json.`,
    });
  return price;
}

function costOf(config: TriageConfig, slot: JudgeSlot, usage: Usage): number {
  const price = priceFor(config, slot);
  return (usage.inputTokens * price.inputUsdPerMtok + usage.outputTokens * price.outputUsdPerMtok) / 1_000_000;
}

/** A conservative byte-based planning bound, including schema and protocol overhead. */
export function quoteCall(
  config: TriageConfig,
  slot: JudgeSlot,
  prompt: Pick<JudgePrompt, "system" | "user" | "schema">,
): number {
  const reasoning = slot.provider === "openrouter" && slot.reasoningEffort && slot.reasoningEffort !== "none";
  return costOf(config, slot, {
    inputTokens: Buffer.byteLength(JSON.stringify(prompt)) + 4096,
    outputTokens: MAX_OUTPUT_TOKENS * (reasoning ? 2 : 1),
  });
}

export function preflightJudges(
  config: TriageConfig,
  file: string,
  runId: string,
  prompts: Pick<JudgePrompt, "system" | "user" | "schema">[],
  env: NodeJS.ProcessEnv = process.env,
  prIdentity?: string,
): number {
  if (!config.enabled) return 0;
  checkCaps(config, readLedger(file), runId, 0, new Date(), prIdentity);
  let quote = 0;
  for (const slot of config.judges) {
    priceFor(config, slot);
    if (!env.TRIAGE_RECORDINGS && !env[`TRIAGE_${slot.provider.toUpperCase()}_API_KEY`])
      throw new CliErrorObject({
        code: "MISSING_API_KEY",
        message: `Export TRIAGE_${slot.provider.toUpperCase()}_API_KEY before judging.`,
      });
    quote += prompts.reduce((sum, prompt) => sum + quoteCall(config, slot, prompt), 0);
  }
  checkCaps(config, readLedger(file), runId, quote, new Date(), prIdentity);
  return quote;
}

const object = z.record(z.string(), z.unknown());
function decode(slot: JudgeSlot, raw: unknown): { text?: string; usage: Usage | null; costUsd?: number } {
  const data = object.parse(raw);
  const values = object.parse(data.usage);
  let text: string | undefined;
  let usage: unknown = { inputTokens: values.input_tokens, outputTokens: values.output_tokens };
  let costUsd: number | undefined;
  if (slot.provider === "anthropic") {
    if (data.stop_reason === "end_turn")
      text = z
        .array(object)
        .parse(data.content)
        .filter((item) => item.type === "text")
        .map((item) => z.string().parse(item.text))
        .join("");
  } else if (slot.provider === "openrouter") {
    usage = { inputTokens: values.prompt_tokens, outputTokens: values.completion_tokens };
    if (typeof values.cost === "number" && Number.isFinite(values.cost) && values.cost >= 0) costUsd = values.cost;
    const choice = z.array(object).parse(data.choices)[0];
    const message = object.parse(choice?.message);
    if (
      typeof data.model === "string" &&
      modelFamily({ provider: "openrouter", model: data.model }) === modelFamily(slot) &&
      choice?.finish_reason === "stop" &&
      !message.refusal &&
      typeof message.content === "string"
    )
      text = message.content;
  } else {
    if (data.status === "completed") {
      const content = z
        .array(object)
        .parse(data.output)
        .flatMap((item) => (item.type === "message" ? z.array(object).parse(item.content) : []));
      if (!content.some((item) => item.type === "refusal"))
        text = content
          .filter((item) => item.type === "output_text")
          .map((item) => z.string().parse(item.text))
          .join("");
    }
  }
  const parsed = UsageSchema.safeParse(usage);
  return { text, usage: parsed.success ? parsed.data : null, costUsd };
}

export function createJudge(
  slot: JudgeSlot,
  options: {
    config: TriageConfig;
    ledger: string;
    runId: string;
    prIdentity?: string;
    scope?: "pr" | "audit";
    env?: NodeJS.ProcessEnv;
    fetch?: typeof fetch;
  },
): Judge {
  const { config, ledger, runId } = options;
  const env = options.env ?? process.env;
  let recording = 0;
  return {
    async judge(prompt) {
      if (!config.enabled) return { abstain: "triage disabled", usage: null, costUsd: 0 };
      const quote = quoteCall(config, slot, prompt);
      const key = env[`TRIAGE_${slot.provider.toUpperCase()}_API_KEY`];
      if (!env.TRIAGE_RECORDINGS && !key)
        throw new CliErrorObject({ code: "MISSING_API_KEY", message: `Missing ${slot.provider} triage key.` });
      const id = reserveSpend(ledger, config, runId, slot, quote, new Date(), options.prIdentity, options.scope);
      let usage: Usage | null = null;
      let costUsd = quote;
      try {
        let raw: unknown;
        if (env.TRIAGE_RECORDINGS) {
          const index = config.judges.findIndex((judge) => judge.label === slot.label);
          const file = path.join(env.TRIAGE_RECORDINGS, `${index}-${slot.label}-${++recording}.json`);
          raw = JSON.parse(readFileSync(file, "utf8"));
          // Only recordings support this substitution; missing/mismatched canaries stay untouched.
          raw = JSON.parse(
            JSON.stringify(raw).replaceAll(
              "__CANARY__",
              "canary" in prompt
                ? String(prompt.canary)
                : (/Echo this canary unchanged: ([a-f0-9]+)/.exec(prompt.system)?.[1] ?? ""),
            ),
          );
        } else {
          const price = priceFor(config, slot);
          const body =
            slot.provider === "anthropic"
              ? {
                  model: slot.model,
                  max_tokens: MAX_OUTPUT_TOKENS,
                  system: prompt.system,
                  messages: [{ role: "user", content: prompt.user }],
                  output_config: { format: { type: "json_schema", schema: prompt.schema } },
                }
              : slot.provider === "openai"
                ? {
                    model: slot.model,
                    max_output_tokens: MAX_OUTPUT_TOKENS,
                    instructions: prompt.system,
                    input: [{ role: "user", content: prompt.user }],
                    text: { format: { type: "json_schema", name: "triage", strict: true, schema: prompt.schema } },
                    store: false,
                  }
                : {
                    model: slot.model,
                    messages: [
                      { role: "system", content: prompt.system },
                      { role: "user", content: prompt.user },
                    ],
                    max_tokens: MAX_OUTPUT_TOKENS,
                    response_format: {
                      type: "json_schema",
                      json_schema: { name: "triage", strict: true, schema: prompt.schema },
                    },
                    provider: {
                      require_parameters: true,
                      data_collection: slot.dataCollection ?? "deny",
                      allow_fallbacks: true,
                      ...(!slot.model.endsWith(":free")
                        ? { max_price: { prompt: price.inputUsdPerMtok, completion: price.outputUsdPerMtok } }
                        : {}),
                    },
                    ...(slot.reasoningEffort ? { reasoning: { effort: slot.reasoningEffort } } : {}),
                  };
          const url =
            slot.provider === "anthropic"
              ? "https://api.anthropic.com/v1/messages"
              : slot.provider === "openai"
                ? "https://api.openai.com/v1/responses"
                : "https://openrouter.ai/api/v1/chat/completions";
          const response = await (options.fetch ?? fetch)(url, {
            method: "POST",
            headers:
              slot.provider === "anthropic"
                ? { "content-type": "application/json", "x-api-key": key!, "anthropic-version": "2023-06-01" }
                : { "content-type": "application/json", Authorization: `Bearer ${key!}` },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(60_000),
          });
          if (!response.ok)
            return {
              abstain: `Provider HTTP ${response.status}; reservation retained, no automatic retry.`,
              usage,
              costUsd,
            };
          raw = await response.json();
        }
        const decoded = decode(slot, raw);
        usage = decoded.usage;
        if (usage) {
          costUsd = decoded.costUsd ?? costOf(config, slot, usage);
          settleSpend(ledger, id, costUsd, usage);
        }
        if (!usage) return { abstain: "Provider usage missing or invalid; reservation retained.", usage, costUsd };
        if (costUsd > quote)
          return {
            abstain: "Provider usage exceeded the reserved planning bound; inspect billing before another run.",
            usage,
            costUsd,
          };
        if (!decoded.text)
          return {
            abstain: "Provider refused, substituted a model family or returned incomplete output.",
            usage,
            costUsd,
          };
        try {
          return { json: JSON.parse(decoded.text), usage, costUsd };
        } catch {
          return { abstain: "Provider output was not JSON.", usage, costUsd };
        }
      } catch {
        return {
          abstain:
            "Provider response unavailable or malformed; no automatic retry. Unsettled reservations remain charged.",
          usage,
          costUsd,
        };
      }
    },
  };
}
