import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { createHiggsfieldClient } from "../providers/higgsfield/client";

export const HiggsfieldRestylePresetsSchema = z
  .object({
    asOf: z.iso.date(),
    presets: z.array(z.object({ id: z.uuid(), name: z.string().min(1) }).strict()).min(1),
  })
  .strict()
  .refine(
    (value) => new Set(value.presets.map((preset) => preset.id)).size === value.presets.length,
    "Preset IDs must be unique.",
  );
export type HiggsfieldRestylePresets = z.infer<typeof HiggsfieldRestylePresetsSchema>;
export const hfRestylePresetsPath = () =>
  process.env.AGENTBROS_HF_RESTYLE_PRESETS ?? fileURLToPath(new URL("./hf-restyle-presets.json", import.meta.url));
export function loadHiggsfieldRestylePresets(file = hfRestylePresetsPath()): HiggsfieldRestylePresets {
  return HiggsfieldRestylePresetsSchema.parse(JSON.parse(readFileSync(file, "utf8")));
}
/** GET /models/higgsfield/genjutsu/restyle/v1.0/presets; discard preview URLs. */
export function parseHiggsfieldRestylePresets(answer: unknown, asOf: string): HiggsfieldRestylePresets {
  const response = z.object({ items: z.array(z.object({ id: z.uuid(), name: z.string().min(1) })) }).parse(answer);
  return HiggsfieldRestylePresetsSchema.parse({ asOf, presets: response.items });
}
export async function syncHiggsfieldRestylePresets(
  options: {
    credentials?: string;
    fetch?: typeof fetch;
    fixtureFile?: string;
    file?: string;
    asOf?: string;
    dryRun?: boolean;
  } = {},
): Promise<{ written: string[]; skipped: boolean; presets?: HiggsfieldRestylePresets }> {
  if (!options.fixtureFile && !options.credentials) return { written: [], skipped: true };
  const fixture = options.fixtureFile
    ? z
        .object({ recordedAt: z.iso.date(), response: z.unknown() })
        .parse(JSON.parse(readFileSync(options.fixtureFile, "utf8")))
    : undefined;
  const answer = fixture
    ? fixture.response
    : await createHiggsfieldClient({ credentials: options.credentials!, fetch: options.fetch }).restylePresets();
  const presets = parseHiggsfieldRestylePresets(
    answer,
    options.asOf ?? fixture?.recordedAt ?? new Date().toISOString().slice(0, 10),
  );
  const file = options.file ?? hfRestylePresetsPath();
  if (!options.dryRun) writeFileSync(file, `${JSON.stringify(presets, null, 2)}\n`);
  return { written: options.dryRun ? [] : [file], skipped: false, presets };
}
