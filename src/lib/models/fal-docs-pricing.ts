import { appendFileSync, existsSync, mkdirSync, readFileSync, truncateSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  FalUnitSemanticsFileSchema,
  FalUnitSemanticsSchema,
  type FalUnitSemantics,
} from "../../types/fal-unit-semantics";
import type { FalPriceRecord } from "../../types/fal-catalog";
import type { PagePriceDrift } from "../../types/models";

export const FAL_UNIT_SEMANTICS_FILE = fileURLToPath(new URL("./fal-unit-semantics.json", import.meta.url));
export function falUnitSemanticsPath(): string {
  return process.env.AGENTBROS_FAL_UNIT_SEMANTICS ?? FAL_UNIT_SEMANTICS_FILE;
}
export function loadFalUnitSemantics(file = falUnitSemanticsPath()): ReadonlyMap<string, FalUnitSemantics> {
  return new Map(
    FalUnitSemanticsFileSchema.parse(JSON.parse(readFileSync(file, "utf8"))).records.map((row) => [row.endpoint, row]),
  );
}
export function falDocsPricingChanged(
  price: Pick<FalPriceRecord, "unit" | "unitPrice"> | undefined,
  semantics?: FalUnitSemantics,
): boolean {
  return (
    !semantics ||
    !semantics.apiSnapshot ||
    !price ||
    price.unit !== semantics.apiSnapshot.unit ||
    price.unitPrice !== semantics.apiSnapshot.unitPrice
  );
}

/** Only explicit model tariffs are recognised. Parsing without an observation date uses an epoch sentinel. */
export function parseFalPricingSection(
  markdown: string,
  endpoint: string,
  observedAsOf = "1970-01-01",
  options: { apiUnit?: string; defaultMode?: string } = {},
): FalUnitSemantics | null {
  const section = /^##[ \t]+Pricing[ \t]*\r?\n([\s\S]*?)(?=^#{1,2}[ \t]+|(?![\s\S]))/im.exec(markdown)?.[1];
  if (!section) return null;
  const quote = section
    .split(/\r?\n|(?<=[.!?])\s+(?=[A-Z])/)
    .filter((line) => !/serverless|\bgpus?\b|\$\d+(?:\.\d+)?\s*\/\s*h\b/i.test(line))
    .join("\n")
    .trim();
  if (!quote) return null;
  const text = quote
    .replace(/\*\*|__/g, "")
    .replace(/×/g, "x")
    .replace(/(\d+)\s+p\b/gi, "$1p");
  const row: FalUnitSemantics = {
    endpoint,
    meaning: "ambiguous",
    evidence: { url: `https://fal.ai/models/${endpoint}/llms.txt`, quote, observedAsOf },
  };
  const ambiguous = (reason: string) => FalUnitSemanticsSchema.parse({ ...row, meaning: "ambiguous", reason });
  const repeated = /^-\s*Price:\s*\$\d+(?:\.\d+)? per ([^\n]+)\s*$/im.exec(text);
  if (repeated && options.apiUnit && repeated[1]!.trim().toLowerCase() === options.apiUnit.toLowerCase())
    return ambiguous("Page repeats the API unit");
  const examples = [...text.matchAll(/(?:For example[^\n]*|^A\s+\d[^\n]*(?:costs|runs)[^\n]*)/gim)].map((m) => m[0]);
  const exampleFree = text.replace(/For example[^\n]*|^A\s+\d[^\n]*(?:costs|runs)[^\n]*/gim, "");
  const reciprocal = /For\s+\$\d+(?:\.\d+)?\s*[,]?\s+you can[^\n]*?(?:\.(?=\s|$)|$)/gim;
  let tariff = exampleFree.replace(reciprocal, "").trim();
  // Token forecasts are a public approximation only. Curated registry formulae keep priority.
  if (/roughly/i.test(tariff) && /tokens/i.test(tariff)) {
    tariff = tariff.split(/Your request will cost[^\n]*tokens|Actual cost calculations/i)[0]!.trim();
    row.approximate = true;
  }
  const audioRegular = /^\$\d+(?:\.\d+)? per second through[^\n]*standard \$(\d+(?:\.\d+)?) per second[^\n]*then/i.exec(
    tariff,
  );
  if (audioRegular && /per second of generated audio/i.test(tariff)) {
    tariff = `$${audioRegular[1]} per second of generated audio${/per sample/i.test(tariff) ? ", per sample" : ""}`;
    row.reason = "Promotional prices omitted; regular tariff used";
  }
  let promoRegular: number[] | undefined;
  if (/promo|discount/i.test(tariff)) {
    const regular = /\(regular price:\s*([^)]+)\)/i.exec(tariff);
    if (regular) {
      promoRegular = [...regular[1]!.matchAll(/\$(\d+(?:\.\d+)?)/g)].map((m) => Number(m[1]));
      tariff = tariff
        .slice(0, regular.index)
        .replace(/^Limited-time promo[\s\S]*?:\s*/i, "")
        .trim();
    } else {
      const regularStart = /Regular rates of|From [^\n]+standard rates are/i.exec(tariff);
      if (!regularStart) return ambiguous("Promotional schedule has no identifiable regular tariff");
      tariff = tariff.slice(regularStart.index);
      // A parallel list states the rates and resolutions respectively.
      const parallel = /standard rates are ([\s\S]+?) per second at ([\s\S]+?), respectively/i.exec(tariff);
      if (parallel) {
        const rates = [...parallel[1]!.matchAll(/\$(\d+(?:\.\d+)?)/g)],
          resolutions = resolutionsIn(parallel[2]!);
        if (rates.length !== resolutions.length) return ambiguous("Incomplete regular tariff");
        tariff = rates.map((m, i) => `$${m[1]} per second at ${resolutions[i]}`).join("; ");
      }
    }
    row.reason = "Promotional prices omitted; regular tariff used";
  }
  if (/precise mode/i.test(tariff) && /creative mode/i.test(tariff)) {
    if (options.defaultMode?.toLowerCase() !== "precise")
      return ambiguous("Mode tariff requires an identifiable schema default");
    tariff = tariff.split(/Creative mode/i)[0]!;
    row.reason = "Schema default precise mode tariff";
  } else if (/\b(?:TURBO|BALANCED|QUALITY)\b/.test(tariff)) {
    const mode = options.defaultMode?.toUpperCase();
    if (!mode) return ambiguous("Mode tariff requires an identifiable schema default");
    const rate = [...tariff.matchAll(/\$(\d+(?:\.\d+)?)\s+(?:with|per megapixel in)\s+(TURBO|BALANCED|QUALITY)/g)].find(
      (m) => m[2] === mode,
    );
    if (!rate) return ambiguous("No tariff for schema default mode");
    tariff = `$${rate[1]} per ${/per megapixel/i.test(tariff) ? "megapixel of output image" : "image"}`;
    row.reason = `Schema default ${mode} mode tariff`;
  }
  const firstRate = /\$(\d+(?:\.\d+)?)(?![\de]|,\d|\.\d)/.exec(tariff);
  if (firstRate && Number(firstRate[1]) > 0) row.unitPrice = Number(firstRate[1]);
  if (/per megapixel of (?:generated )?video data\s*\(width\s*x\s*height\s*x\s*frames\)/i.test(tariff))
    row.meaning = "video-megapixel";
  else if (/per\s+(\d+)\s+frames?\b/i.test(tariff)) {
    row.meaning = "frames";
    row.framesPerUnit = Number(/per\s+(\d+)\s+frames?\b/i.exec(tariff)![1]);
  } else if (
    /per\s+(?:megapixel of (?:the )?output image|output[- ]image megapixel)\b/i.test(tariff) ||
    /^Your request will cost \$\d+(?:\.\d+)? per megapixel\./i.test(tariff)
  )
    row.meaning = "output-megapixel";
  else if (/per\s+(?:input video second|second of (?:the )?input video)\b/i.test(tariff))
    row.meaning = "input-video-second";
  else if (/per\s+(?:output audio second|second of (?:generated|output) audio)\b/i.test(tariff))
    row.meaning = "output-audio-second";
  else if (/per\s+(?:1000|1,000)\s+(?:input\s+)?characters\b/i.test(tariff)) row.meaning = "input-kilo-characters";
  else if (
    /per minute of input audio|per\s+(?:input audio\s+)?minutes?\b(?!\s+of\s+(?:generated|output))/i.test(tariff)
  )
    row.meaning = "input-audio-minute";
  else if (/per\s+(?:output\s+)?image\b/i.test(tariff)) row.meaning = "output-image";
  else if (/per\s+(?:request|generation)\b/i.test(tariff)) row.meaning = "request";
  else if (
    /for every second of (?:\w+ )?video you generate|per\s+(?:generated[- ]second|(?:output )?video second|second of (?:generated(?: draft)?|output) video)\b|per second of video generated/i.test(
      tariff,
    )
  )
    row.meaning = "generated-second";
  if (/per second of output and per sample|per second of generated audio, per sample/i.test(tariff)) {
    row.meaning = "output-audio-second";
    row.perSample = true;
  }
  if (/rounded up(?:wards)?|up to full minutes/i.test(tariff)) row.roundUp = true;
  const base =
    /For (\d+(?:\.\d+)?)\s*s video your request will cost\s*\$(\d+(?:\.\d+)?)\.\s*For every additional second you will be charged\s*\$(\d+(?:\.\d+)?)/i.exec(
      tariff,
    );
  if (base) {
    row.meaning = "generated-second";
    row.baseSeconds = Number(base[1]);
    row.baseUsd = Number(base[2]);
    row.extraUsdPerSecond = Number(base[3]);
  }
  const tiers: NonNullable<FalUnitSemantics["tiers"]> = [];
  const covered = new Set<number>();
  const cover = (m: RegExpMatchArray) => {
    for (const amount of m[0].matchAll(/\$/g)) covered.add(m.index! + amount.index);
  };
  if (base) cover(base);
  const add = (resolution: string, rate: number) =>
    tiers.push({ when: { resolution: normaliseResolution(resolution) }, usdPerUnit: rate });
  // Resolution x audio is one complete grid, rather than two competing sets of tiers.
  if (/without audio\s*\/\s*with audio/i.test(tariff)) {
    for (const m of tariff.matchAll(/(\d+p|[248]K):\s*\$(\d+(?:\.\d+)?)\s*\/\s*\$(\d+(?:\.\d+)?)/gi)) {
      cover(m);
      tiers.push(
        { when: { resolution: normaliseResolution(m[1]!), generateAudio: false }, usdPerUnit: Number(m[2]) },
        { when: { resolution: normaliseResolution(m[1]!), generateAudio: true }, usdPerUnit: Number(m[3]) },
      );
    }
  } else {
    // Price first, optionally inheriting the per-second unit from the preceding clause.
    for (const m of tariff.matchAll(
      /\$(\d+(?:\.\d+)?)(?![\de]|,\d|\.\d)\s*(?:(?:\/second|per (?:video |generated )?second(?: of generated video)?)\s*)?(?:(?:at|for)\s+)?((?:\d+p|[248]K)(?:\s*(?:and|or|\/)\s*(?:\d+p|[248]K))*)/gi,
    )) {
      cover(m);
      for (const resolution of resolutionsIn(m[2]!)) add(resolution, Number(m[1]));
    }
    // Resolution first: "For 720p ... $0.10 per second", including $x/second.
    for (const m of tariff.matchAll(
      /(?:for\s+(?:every second of\s+)?)?(\d+p|[248]K)(?:\s+video)?(?:\s+you generated)?\s*(?:,\s*)?(?:your request will cost|you will be charged|costs|video you will be charged)?\s*(?:roughly\s*)?\$(\d+(?:\.\d+)?)(?:\s*(?:\/second|per second(?: of generated video)?))?/gi,
    )) {
      if ([...m[0].matchAll(/\$/g)].some((amount) => covered.has(m.index + amount.index))) continue;
      cover(m);
      add(m[1]!, Number(m[2]));
    }
    const multiplier = /cost will be (\d+(?:\.\d+)?)x for ([^.!\n]+)/i.exec(tariff);
    if (multiplier && tiers.length)
      for (const resolution of resolutionsIn(multiplier[2]!))
        add(resolution, tiers[0]!.usdPerUnit * Number(multiplier[1]));
    const surcharge =
      /(?:additional|extra|surcharge(?: of)?)\s*\$(\d+(?:\.\d+)?)\s+per\s+second\s+(?:with|for)\s+audio/i.exec(tariff);
    for (const m of tariff.matchAll(
      /\$(\d+(?:\.\d+)?)\s*(?:per\s+(?:generated\s+)?second\s+(with|without)\s+audio|\(audio (off|on)\))/gi,
    )) {
      if (surcharge && m.index >= surcharge.index && m.index < surcharge.index + surcharge[0].length) continue;
      cover(m);
      tiers.push({
        when: { generateAudio: m[2]?.toLowerCase() === "with" || m[3]?.toLowerCase() === "on" },
        usdPerUnit: Number(m[1]),
      });
    }
    const voice = /if voice control is used while generating audio you will be charged\s*\$(\d+(?:\.\d+)?)/i.exec(
      tariff,
    );
    if (voice && tiers.some((t) => t.when.generateAudio === true)) {
      cover(voice);
      for (const tier of tiers) if (tier.when.generateAudio === true) tier.when.voiceControl = false;
      tiers.push({ when: { generateAudio: true, voiceControl: true }, usdPerUnit: Number(voice[1]) });
    }
    if (surcharge && row.unitPrice && /without audio/i.test(tariff)) {
      cover(surcharge);
      tiers.push({ when: { generateAudio: true }, usdPerUnit: row.unitPrice + Number(surcharge[1]) });
    }
  }
  const clipDuration = /^For\s+(\d+(?:\.\d+)?)\s*s video your request will cost/i.exec(tariff);
  if (clipDuration && tiers.length && !base) {
    row.clips = tiers.map((tier) => ({
      durationSec: Number(clipDuration[1]),
      resolution: tier.when.resolution,
      usd: tier.usdPerUnit,
    }));
    row.meaning = "generated-second";
  } else if (tiers.length && /per\s+(?:video |generated )?second|\/second|For every second/i.test(tariff)) {
    row.tiers = tiers;
    row.meaning = /per second of input video|billed on the duration of your input video/i.test(tariff)
      ? "input-video-second"
      : "generated-second";
  } else if (tiers.length) return ambiguous("Conditional amounts do not identify a per-second or per-clip tariff");
  if (!tiers.length && row.meaning === "generated-second" && resolutionsIn(tariff).length === 1)
    row.tiers = [{ when: { resolution: resolutionsIn(tariff)[0]! }, usdPerUnit: row.unitPrice! }];
  if (
    tiers.some((t) => t.when.resolution) &&
    /(?:with|without)\s+audio/i.test(tariff) &&
    !tiers.every((t) => t.when.generateAudio !== undefined)
  )
    return ambiguous("Combined resolution and audio conditions require explicit complete tiers");
  if (row.clips && new Set(row.clips.map((clip) => `${clip.durationSec}:${clip.resolution}`)).size !== row.clips.length)
    return ambiguous("Overlapping clip tariff conditions");
  const conditions = row.tiers?.map((tier) => JSON.stringify(tier.when));
  if (conditions && new Set(conditions).size !== conditions.length)
    return ambiguous("Overlapping page tariff conditions");
  if (promoRegular) {
    const distinct = [...new Set(tiers.map((t) => t.usdPerUnit))];
    if (tiers.length && distinct.length === promoRegular.length)
      for (const tier of tiers) tier.usdPerUnit = promoRegular[distinct.indexOf(tier.usdPerUnit)]!;
    else if (!tiers.length && promoRegular.length === 1) row.unitPrice = promoRegular[0];
    else return ambiguous("Incomplete regular promotional tariff");
    if (row.tiers) row.unitPrice = row.tiers[0]!.usdPerUnit;
  }
  const amounts = [...tariff.matchAll(/\$(\d+(?:\.\d+)?)(?![\de]|,\d|\.\d)/g)];
  if (
    amounts.length !== [...tariff.matchAll(/\$/g)].length ||
    !row.unitPrice ||
    (tiers.length || base ? amounts.some((m) => !covered.has(m.index)) : amounts.length > 1) ||
    /compute|processing time|depending on|starting (?:at|from)|\bfrom\s+\$|\bIf input video|HDR|extra .{0,20}charge|overlapping windows|multiplier is added|selected model|reference input charges|reference inputs beyond|billable input tokens|tokens are also charged|\b(?:[2-9]|\d{2,})-second minimum|billed in whole seconds|minimum charge|output duration plus|input plus output|double the standard|outputs will be charged/i.test(
      tariff,
    )
  )
    return ambiguous("No single explicit billable quantity or complete tariff");
  if (row.framesPerUnit !== undefined && row.framesPerUnit <= 0) {
    delete row.framesPerUnit;
    return ambiguous("Frame block must be positive");
  }
  for (const example of examples) {
    if (row.meaning === "ambiguous" || row.reason?.includes("Promotional") || row.reason?.includes("Schema default"))
      continue;
    const failure = checkFalPricingExample(row, example);
    const total = /(?:cost(?:s)?|total cost)(?:\s+will be|\s+is)?\s*\$(\d+(?:\.\d+)?)/i.exec(example);
    if (total) row.example = { text: example.trim(), usd: Number(total[1]!.replace(/\.$/, "")) };
    if (failure) return ambiguous(failure);
  }
  if (row.meaning === "ambiguous") row.reason ??= "Pricing text does not identify the billable quantity";
  return FalUnitSemanticsSchema.parse(row);
}

function normaliseResolution(resolution: string): string {
  return resolution.replace(/\s/g, "").replace(/k$/i, "K");
}
function resolutionsIn(text: string): string[] {
  return [...text.matchAll(/\b(?:\d+p|[248]K)\b/gi)].map((m) => normaliseResolution(m[0]));
}

/** Verify every stated total, including both sides of an audio example and displayed rounding. */
export function checkFalPricingExample(row: FalUnitSemantics, example = row.example?.text): string | undefined {
  if (!example) return undefined;
  const dimensions = /(\d+)\s*x\s*(\d+)/i.exec(example.replace(/×/g, "x"));
  const frames = /(\d+)\s+frames?\b/i.exec(example);
  const seconds = /\b(\d+(?:\.\d+)?)(?:-(\d+(?:\.\d+)?))?(?:-second|\s*(?:s\b|seconds?\b))/i.exec(example);
  const input: FalUnitPriceInput = {
    ...(seconds ? { durationSec: Number(seconds[1]), inputVideoDurationSec: Number(seconds[1]) } : {}),
    resolution: resolutionsIn(example)[0],
  };
  const audio =
    /(?:with audio|audio on)/i.test(example) && !/without audio/i.test(example)
      ? true
      : /without audio|audio off/i.test(example)
        ? false
        : undefined;
  input.generateAudio = audio;
  input.voiceControl = /with audio on and voice control/i.test(example);
  const totals = [...example.matchAll(/\$([\d]+(?:\.[\d]+)?)(?![\de]|,\d|\.\d)/g)];
  if (!totals.length) return "Example total or its quantity cannot be verified";
  for (let i = 0; i < totals.length; i++) {
    const total = totals[i]!,
      suffix = example.slice(total.index + total[0].length, totals[i + 1]?.index);
    const audioSetting = /^\s*(without audio|with audio)/i.exec(suffix)?.[1];
    const prefix = example.slice(totals[i - 1] ? totals[i - 1]!.index + totals[i - 1]![0].length : 0, total.index);
    const resolutions = resolutionsIn(example);
    const resolution =
      /^\s*at\s+(\d+p|[248]K)/i.exec(suffix)?.[1] ??
      resolutionsIn(prefix).at(-1) ??
      (/respectively/i.test(example)
        ? row.tiers?.[i]?.when.resolution
        : (resolutions[0] ?? (row.tiers?.length === 1 ? row.tiers[0]?.when.resolution : undefined)));
    let quantity: number | undefined;
    if (row.meaning === "video-megapixel" && dimensions && frames)
      quantity = (Number(dimensions[1]) * Number(dimensions[2]) * Number(frames[1])) / 1e6;
    if (row.meaning === "frames" && frames) quantity = Number(frames[1]) / row.framesPerUnit!;
    if (row.meaning === "output-image") quantity = Number(/\b(\d+)\s+images?\b/i.exec(example)?.[1]);
    if (row.meaning === "output-megapixel")
      quantity = dimensions
        ? (Number(dimensions[1]) * Number(dimensions[2])) / 1e6
        : Number(/\b(\d+(?:\.\d+)?)\s*(?:MP|megapixels?)\b/i.exec(example)?.[1]);
    if (row.meaning === "request") quantity = Number(/\b(\d+)\s+requests?\b/i.exec(example)?.[1]);
    if (row.meaning === "input-kilo-characters")
      quantity = Math.ceil(Number(/\b([\d,]+)\s+characters?\b/i.exec(example)?.[1]?.replaceAll(",", "")) / 1000);
    if (row.meaning === "input-audio-minute")
      quantity = Number(/\b(\d+(?:\.\d+)?)\s+minutes?\b/i.exec(prefix.split(/,|and/).at(-1) ?? prefix)?.[1]);
    let expected: number | undefined;
    if (quantity !== undefined) expected = (row.roundUp ? Math.ceil(quantity) : quantity) * row.unitPrice!;
    else {
      const result = estimateFalUnitPrice(row, row.unitPrice!, {
        ...input,
        ...(seconds?.[2]
          ? { durationSec: Number(seconds[i === 0 ? 1 : 2]), inputVideoDurationSec: Number(seconds[i === 0 ? 1 : 2]) }
          : {}),
        resolution,
        ...(audioSetting ? { generateAudio: audioSetting.toLowerCase() === "with audio" } : {}),
      });
      if ("usd" in result) expected = result.usd;
    }
    if (expected === undefined || !Number.isFinite(expected) || Math.abs(expected - Number(total[1])) > 0.005000001)
      return "Example total does not match the parsed formula or its quantity cannot be verified";
  }
  return undefined;
}

export type FalDocsFetch = (
  url: string,
  init: { method: string; signal: AbortSignal },
) => Promise<{ ok: boolean; status: number; headers: { get(name: string): string | null }; text(): Promise<string> }>;
const CheckpointSchema = z
  .object({ date: z.iso.date(), endpoint: z.string(), record: FalUnitSemanticsSchema.nullable() })
  .strict()
  .refine(
    (row) => row.record === null || row.endpoint === row.record.endpoint,
    "Checkpoint endpoint differs from record",
  );
/** Free public GETs, with per-endpoint checkpoints; failures retain previous evidence. */
export async function syncFalDocsPricing(
  endpoints: readonly string[],
  fetchImpl: FalDocsFetch,
  options: {
    now: Date;
    checkpointFile?: string;
    resume?: boolean;
    concurrency?: number;
    previous?: ReadonlyMap<string, FalUnitSemantics>;
    prices?: ReadonlyMap<string, FalPriceRecord>;
    defaultModes?: ReadonlyMap<string, string>;
    sleep?: (ms: number) => Promise<void>;
  },
) {
  const date = options.now.toISOString().slice(0, 10),
    records = new Map(options.previous),
    completed = new Map<string, FalUnitSemantics | null>();
  const failed: { endpoint: string; reason: string }[] = [],
    unpriced: string[] = [];
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const concurrency = options.concurrency ?? 2;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16)
    throw new RangeError("Concurrency must be between 1 and 16");
  if (options.resume && options.checkpointFile && existsSync(options.checkpointFile)) {
    const contents = readFileSync(options.checkpointFile, "utf8"),
      complete = contents.slice(0, contents.lastIndexOf("\n") + 1);
    if (contents !== complete) truncateSync(options.checkpointFile, Buffer.byteLength(complete));
    for (const line of complete.split("\n").filter(Boolean)) {
      const row = CheckpointSchema.parse(JSON.parse(line));
      if (
        row.date === date &&
        (row.record === null ||
          !options.prices ||
          !falDocsPricingChanged(options.prices.get(row.endpoint), row.record ?? undefined))
      )
        completed.set(row.endpoint, row.record);
    }
  }
  const queue = [...new Set(endpoints)].sort();
  for (const endpoint of queue) FalUnitSemanticsSchema.shape.endpoint.parse(endpoint);
  let cursor = 0,
    requests = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
      while (cursor < queue.length) {
        const endpoint = queue[cursor++]!;
        try {
          let record = completed.get(endpoint);
          if (!completed.has(endpoint)) {
            for (let attempt = 0; attempt < 3; attempt++) {
              try {
                requests++;
                const response = await fetchImpl(`https://fal.ai/models/${endpoint}/llms.txt`, {
                  method: "GET",
                  signal: AbortSignal.timeout(30000),
                });
                if (!response.ok) {
                  if ((response.status !== 429 && response.status < 500) || attempt === 2)
                    throw new Error("Page unavailable");
                  const retry = response.headers.get("retry-after");
                  const delay =
                    retry && Number.isFinite(Number(retry))
                      ? Number(retry) * 1000
                      : retry && Number.isFinite(Date.parse(retry))
                        ? Date.parse(retry) - options.now.valueOf()
                        : 1000 * 2 ** attempt;
                  await sleep(Math.min(60000, Math.max(1000, delay)));
                  continue;
                }
                record = parseFalPricingSection(await response.text(), endpoint, date, {
                  apiUnit: options.prices?.get(endpoint)?.unit,
                  defaultMode: options.defaultModes?.get(endpoint),
                });
                const price = options.prices?.get(endpoint);
                if (record && price) record.apiSnapshot = { unit: price.unit, unitPrice: price.unitPrice };
                break;
              } catch {
                if (attempt === 2) throw new Error("Page failed");
                await sleep(1000 * 2 ** attempt);
              }
            }
            if (options.checkpointFile) {
              mkdirSync(path.dirname(options.checkpointFile), { recursive: true });
              appendFileSync(options.checkpointFile, `${JSON.stringify({ date, endpoint, record: record ?? null })}\n`);
            }
          }
          if (record) records.set(endpoint, record);
          else {
            records.delete(endpoint);
            unpriced.push(endpoint);
          }
        } catch {
          failed.push({
            endpoint,
            reason: "Public pricing page failed (network, rate limit or invalid response); previous evidence retained",
          });
        }
      }
    }),
  );
  return {
    version: 1 as const,
    syncedAt: failed.length ? null : date,
    records: [...records.values()].sort((a, b) => a.endpoint.localeCompare(b.endpoint)),
    partial: failed.length > 0,
    failed: failed.sort((a, b) => a.endpoint.localeCompare(b.endpoint)),
    unpriced: unpriced.sort(),
    requests,
  };
}

/** The page can clarify an API unit, but cannot change its dimensional meaning. */
export function falSemanticsAgree(unit: string, row: FalUnitSemantics): boolean {
  const value = unit.trim().toLowerCase();
  if (row.meaning === "ambiguous") return false;
  if (row.clips && ["videos", "video", "video segments"].includes(value)) return true;
  if (["unit", "units"].includes(value)) return true;
  if (["second", "seconds"].includes(value))
    return ["generated-second", "input-video-second", "output-audio-second"].includes(row.meaning);
  if (["megapixel", "megapixels"].includes(value)) return ["output-megapixel", "video-megapixel"].includes(row.meaning);
  if (["minute", "minutes"].includes(value)) return row.meaning === "input-audio-minute";
  if (["1000 characters", "1k characters"].includes(value)) return row.meaning === "input-kilo-characters";
  if (["request", "requests"].includes(value)) return row.meaning === "request";
  if (["image", "images", "generation", "generations"].includes(value))
    return row.meaning === "output-image" || (row.meaning === "request" && value.startsWith("generation"));
  const frames = /^(\d+) frames?$/.exec(value);
  return (
    row.meaning === "frames" &&
    (frames ? Number(frames[1]) === row.framesPerUnit : /^frames?$/.test(value) && row.framesPerUnit === 1)
  );
}
export function falPagePriceDrift(row: FalUnitSemantics, apiRate: number): string | undefined {
  const rates = [
    ...new Set(
      [
        row.unitPrice,
        row.extraUsdPerSecond,
        ...(row.clips?.map((clip) => clip.usd) ?? []),
        ...(row.tiers?.map((tier) => tier.usdPerUnit) ?? []),
      ].filter((rate): rate is number => rate !== undefined),
    ),
  ];
  return rates.length && !rates.some((rate) => Math.abs(rate - apiRate) < 1e-9)
    ? `Page/API price drift: page ${rates.map((rate) => `$${rate}`).join(" / ")}, API $${apiRate}; ${row.clips || row.baseSeconds !== undefined || pageScenarioRate(row) || (row.tiers?.length ?? 0) > 1 ? "page scenario tariff used for planning" : "higher rate used for planning"}`
    : undefined;
}
/** A promotional or schema-default page rate that deliberately replaces the API rate (no higher-rate rule). */
function pageScenarioRate(row: FalUnitSemantics): boolean {
  return Boolean(
    row.validUntil ||
    row.tiers?.some((tier) => tier.validUntil) ||
    row.reason?.includes("Promotional prices omitted") ||
    (row.reason?.includes("Schema default") && row.unitPrice),
  );
}
export type FalUnitPriceInput = {
  durationSec?: number;
  inputVideoDurationSec?: number;
  inputAudioSec?: number;
  inputCharacters?: number;
  width?: number;
  height?: number;
  images?: number;
  samples?: number;
  resolution?: string;
  generateAudio?: boolean;
  voiceControl?: boolean;
  /** The endpoint takes no resolution input: a page tariff naming one resolution applies without one. */
  resolutionFixed?: boolean;
};
/** Shared scenario/request formula; no dimensions, durations or conditional tiers are guessed. */
export function estimateFalUnitPrice(
  row: FalUnitSemantics,
  apiRate: number,
  input: FalUnitPriceInput,
  fps?: number,
  now = new Date(),
): { usd: number; formula: string; approximate: boolean; priceDrift?: PagePriceDrift } | { reason: string } {
  const drift = falPagePriceDrift(row, apiRate);
  let rate = apiRate;
  // The page's own per-unit rate for this request; with known drift, planning uses the higher of it and the API's.
  let pageRate = pageScenarioRate(row) ? undefined : row.unitPrice;
  let pageDerived = Boolean(row.approximate);
  if ((row.reason?.includes("Promotional prices omitted") || row.reason?.includes("Schema default")) && row.unitPrice) {
    rate = row.unitPrice;
    pageDerived ||= Math.abs(rate - apiRate) > 1e-9;
  }
  const quote = row.evidence.quote.split(/For more details,/i)[0]!.trim();
  const evidence = (formula: string) =>
    `${formula}${drift ? `; ${drift}` : ""}${row.reason ? `; ${row.reason}` : ""}; ${row.evidence.url}; ${quote}; observed ${row.evidence.observedAsOf}`;
  const currentRate = (tariff: { usdPerUnit: number; validUntil?: string; regularUsdPerUnit?: number }) => {
    const expiry = tariff.validUntil ?? row.validUntil;
    const expired =
      expiry && (expiry.length === 10 ? now.toISOString().slice(0, 10) > expiry : now.valueOf() >= Date.parse(expiry));
    return expired ? (tariff.regularUsdPerUnit ?? row.regularUsdPerUnit) : tariff.usdPerUnit;
  };
  if (row.clips) {
    const matches = row.clips.filter(
      (clip) =>
        clip.durationSec === input.durationSec &&
        (clip.resolution === undefined || clip.resolution === input.resolution),
    );
    if (
      !matches.length &&
      row.clips.some((clip) => clip.resolution) &&
      !row.clips.some((clip) => clip.resolution === input.resolution)
    )
      return { reason: `no page tariff for ${input.resolution ?? "unspecified resolution"}` };
    if (matches.length !== 1) return { reason: `No page clip tariff for exactly ${input.durationSec} seconds` };
    return {
      usd: matches[0]!.usd,
      formula: evidence(
        `1 clip of exactly ${input.durationSec}s at ${input.resolution ?? "fixed resolution"} × $${matches[0]!.usd}`,
      ),
      approximate: true,
    };
  }
  if (row.baseSeconds !== undefined && row.baseUsd !== undefined && row.extraUsdPerSecond !== undefined) {
    if (input.durationSec === undefined || input.durationSec < row.baseSeconds)
      return { reason: `Base tariff requires at least ${row.baseSeconds} seconds` };
    return {
      usd: row.baseUsd + (input.durationSec - row.baseSeconds) * row.extraUsdPerSecond,
      formula: evidence(
        `$${row.baseUsd} for ${row.baseSeconds}s + (${input.durationSec} - ${row.baseSeconds}) extra seconds × $${row.extraUsdPerSecond}`,
      ),
      approximate: true,
    };
  }
  // Without a resolution input, a page naming exactly one resolution is pricing that endpoint's only output.
  const pageResolutions = [...new Set(row.tiers?.flatMap((tier) => tier.when.resolution ?? []) ?? [])];
  const resolution =
    input.resolution ?? (input.resolutionFixed && pageResolutions.length === 1 ? pageResolutions[0] : undefined);
  if (row.tiers) {
    const matches = row.tiers.filter(
      (tier) =>
        (tier.when.resolution === undefined || tier.when.resolution === resolution) &&
        (tier.when.generateAudio === undefined || tier.when.generateAudio === input.generateAudio) &&
        (tier.when.voiceControl === undefined || tier.when.voiceControl === (input.voiceControl ?? false)),
    );
    if (
      !matches.length &&
      row.tiers.some((tier) => tier.when.resolution) &&
      !row.tiers.some((tier) => tier.when.resolution === resolution)
    )
      return { reason: `no page tariff for ${resolution ?? "unspecified resolution"}` };
    if (matches.length !== 1) return { reason: "Pricing needs an unambiguous resolution/audio tier" };
    const selected = currentRate(matches[0]!);
    if (selected === undefined) return { reason: "Expired page promotion has no regular tariff" };
    rate = selected;
    if (pageRate !== undefined) pageRate = selected;
    pageDerived ||= Math.abs(rate - apiRate) > 1e-9;
  } else if (row.validUntil) {
    const selected = currentRate({ ...row, usdPerUnit: row.unitPrice ?? apiRate });
    if (selected === undefined) return { reason: "Expired page promotion has no regular tariff" };
    rate = selected;
    pageDerived ||= Math.abs(rate - apiRate) > 1e-9;
  }
  // Like for like: a page with one rate (or one tier) prices the same scenario as the API's single rate, so the higher
  // wins. A page split into scenario tiers (audio on/off, resolutions) cannot be matched to the API's one figure:
  // the requested scenario's page tier is used and the drift is only reported.
  const comparable = !row.tiers || row.tiers.length === 1;
  const priceDrift: PagePriceDrift | undefined =
    drift && pageRate !== undefined
      ? { pageUsdPerUnit: pageRate, apiUsdPerUnit: apiRate, used: comparable ? Math.max(pageRate, apiRate) : pageRate }
      : undefined;
  if (priceDrift) rate = priceDrift.used;
  let quantity: number | undefined,
    formula = "",
    approximate = Boolean(drift) || pageDerived;
  switch (row.meaning) {
    case "generated-second":
    case "output-audio-second":
      quantity = input.durationSec;
      formula = `${quantity} generated seconds`;
      break;
    case "input-video-second":
      quantity = input.inputVideoDurationSec;
      formula = `${quantity} input video seconds`;
      break;
    case "input-audio-minute":
      quantity = input.inputAudioSec === undefined ? undefined : input.inputAudioSec / 60;
      formula = `${input.inputAudioSec} input audio seconds / 60`;
      break;
    case "input-kilo-characters":
      quantity = input.inputCharacters === undefined ? undefined : Math.max(1, Math.ceil(input.inputCharacters / 1000));
      formula = `max(1, ceil(${input.inputCharacters} characters / 1000))`;
      break;
    case "output-image":
      quantity = input.images ?? 1;
      formula = `${quantity} output images`;
      break;
    case "request":
      quantity = 1;
      formula = "1 request";
      break;
    case "output-megapixel":
      quantity = input.width && input.height ? ((input.width * input.height) / 1e6) * (input.images ?? 1) : undefined;
      formula = `${input.width} × ${input.height} / 1e6 × ${input.images ?? 1} images`;
      approximate = true;
      break;
    case "frames":
    case "video-megapixel": {
      const frameRate = fps ?? 24;
      const frames = input.durationSec === undefined ? undefined : input.durationSec * frameRate;
      const frameFormula = `${frameRate} fps × ${input.durationSec} seconds${fps === undefined ? " (assumed 24 fps)" : " (schema default fps)"}`;
      if (row.meaning === "frames") {
        quantity = frames === undefined ? undefined : frames / row.framesPerUnit!;
        formula = `${frameFormula} / ${row.framesPerUnit} frames per unit`;
      } else {
        quantity =
          frames !== undefined && input.width && input.height ? (input.width * input.height * frames) / 1e6 : undefined;
        formula = `${input.width} × ${input.height} × (${frameFormula}) / 1e6 video megapixels`;
      }
      approximate = true;
      break;
    }
    case "ambiguous":
      return { reason: row.reason ?? "Ambiguous model-page pricing" };
  }
  if (quantity === undefined || !Number.isFinite(quantity) || quantity <= 0)
    return { reason: `Missing positive measured quantity for ${row.meaning}` };
  if (row.roundUp) {
    quantity = Math.ceil(quantity);
    formula = `ceil(${formula})`;
  }
  if (row.perSample) {
    if (input.samples === undefined || !Number.isInteger(input.samples) || input.samples <= 0)
      return { reason: "Missing positive sample count" };
    quantity *= input.samples;
    formula += ` × ${input.samples} samples`;
  }
  const usd = quantity * rate;
  if (!Number.isFinite(usd) || usd <= 0) return { reason: "Price exceeds numeric precision" };
  return {
    usd,
    formula: evidence(
      `${formula} × $${rate}${row.tiers ? ` (${resolution ?? "fixed resolution"}${input.generateAudio === undefined ? "" : input.generateAudio ? ", audio on" : ", audio off"})` : ""}`,
    ),
    approximate,
    ...(priceDrift ? { priceDrift } : {}),
  };
}
