import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import lists from "./stimuli-lists.json";

export const STIMULUS_METHODS = ["kill-first-10", "zwicky", "random-entry", "scamper", "triz", "synectics"] as const;
export type StimulusMethod = (typeof STIMULUS_METHODS)[number];

const DEFAULT_COUNT: Record<StimulusMethod, number> = {
  "kill-first-10": 10,
  zwicky: 3,
  "random-entry": 3,
  scamper: 3,
  triz: 3,
  synectics: 3,
};

export interface Stimulus {
  method: StimulusMethod;
  seed: string;
  prompt: string;
  detail: Record<string, string>;
}

export interface StimulusSheet {
  schemaVersion: 1;
  method: StimulusMethod;
  seed: string;
  count: number;
  context: { proposition?: string; audienceMoment?: string };
  stimuli: Stimulus[];
}

function seededRandom(seed: string): () => number {
  let state = Number.parseInt(createHash("sha256").update(seed).digest("hex").slice(0, 8), 16) >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(items: readonly T[], random: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

const pickOne = <T>(items: readonly T[], random: () => number): T => items[Math.floor(random() * items.length)]!;

function readContext(projectDir: string): StimulusSheet["context"] {
  const file = path.join(projectDir, "pipeline", "strategy.json");
  if (!existsSync(file)) return {};
  try {
    const strategy = JSON.parse(readFileSync(file, "utf8")) as { proposition?: string; audience?: { moment?: string } };
    return {
      ...(strategy.proposition ? { proposition: strategy.proposition } : {}),
      ...(strategy.audience?.moment ? { audienceMoment: strategy.audience.moment } : {}),
    };
  } catch {
    return {};
  }
}

export function buildStimuli(
  method: StimulusMethod,
  seed: string,
  count?: number,
  context: StimulusSheet["context"] = {},
): StimulusSheet {
  const n = count ?? DEFAULT_COUNT[method];
  const random = seededRandom(`${method}:${seed}`);
  const make = (prompt: string, detail: Record<string, string>): Stimulus => ({ method, seed, prompt, detail });
  const proves = context.proposition ? ` It must prove: ${context.proposition}` : "";
  let stimuli: Stimulus[];
  switch (method) {
    case "kill-first-10":
      stimuli = shuffle(lists.killFirst10, random)
        .slice(0, n)
        .map((cliche) =>
          make(`Banned: ${cliche}. Write the category's own version of this obvious idea, then ban it.`, { cliche }),
        );
      break;
    case "zwicky": {
      const dims = Object.entries(lists.zwicky);
      stimuli = Array.from({ length: n }, () => {
        const detail = Object.fromEntries(dims.map(([dim, values]) => [dim, pickOne(values, random)]));
        if (context.audienceMoment && detail.pointOfView === "the person in the audience's moment")
          detail.pointOfView = `the person in the audience's moment: ${context.audienceMoment}`;
        const prompt = `Build one idea from this combination: ${dims.map(([dim]) => `${dim}: ${detail[dim]}`).join("; ")}.${proves}`;
        return make(prompt, detail);
      });
      break;
    }
    case "random-entry": {
      const words = shuffle(lists.randomWords, random);
      const provocations = shuffle(lists.poProvocations, random);
      stimuli = Array.from({ length: n }, (_, i) => {
        const word = words[i % words.length]!;
        const po = provocations[i % provocations.length]!;
        const focus = pickOne(lists.provocationFocus, random);
        const provocation = po.template.replace("{focus}", focus);
        return make(
          `Random entry: "${word}". List five properties of it, carry one into the film's picture. Then the provocation: ${provocation}; move from it to a filmable idea.${proves}`,
          { word, provocation, kind: po.kind },
        );
      });
      break;
    }
    case "scamper": {
      const ops = shuffle(lists.scamper, random);
      const conventions = shuffle(lists.categoryConventions, random);
      stimuli = Array.from({ length: n }, (_, i) => {
        const op = ops[i % ops.length]!;
        const convention = conventions[i % conventions.length]!;
        return make(
          `Convention: ${convention}. ${op.prompt}. Name the category's own form of this convention first.${proves}`,
          { op: op.op, convention },
        );
      });
      break;
    }
    case "triz": {
      const contradictions = shuffle(lists.triz.contradictions, random);
      stimuli = Array.from({ length: n }, (_, i) => {
        const contradiction = contradictions[i % contradictions.length]!;
        const separation = pickOne(lists.triz.separations, random);
        return make(`Contradiction: ${contradiction}. ${separation.prompt}.`, {
          contradiction,
          separation: separation.by,
        });
      });
      break;
    }
    case "synectics": {
      const domains = shuffle(lists.remoteDomains, random);
      stimuli = Array.from({ length: n }, (_, i) => {
        const domain = domains[i % domains.length]!;
        return make(
          `Direct analogy from ${domain}: how does ${domain} solve the problem the product solves? Name the one object or gesture that carries it, and film that.${proves}`,
          { domain },
        );
      });
      break;
    }
  }
  return { schemaVersion: 1, method, seed, count: n, context, stimuli };
}

export const isStimulusMethod = (value: string): value is StimulusMethod =>
  (STIMULUS_METHODS as readonly string[]).includes(value);

/** Writes pipeline/stimuli/<method>-<seed>.json for each method; returns the files. */
export function writeStimuli(
  projectDir: string,
  methods: readonly StimulusMethod[],
  seed: string,
  count?: number,
): { file: string; sheet: StimulusSheet }[] {
  const context = readContext(projectDir);
  const dir = path.join(projectDir, "pipeline", "stimuli");
  mkdirSync(dir, { recursive: true });
  const safeSeed = seed.replace(/[^A-Za-z0-9_.-]/g, "_");
  return methods.map((method) => {
    const sheet = buildStimuli(method, seed, count, context);
    const file = path.join(dir, `${method}-${safeSeed}.json`);
    writeFileSync(file, `${JSON.stringify(sheet, null, 2)}\n`);
    return { file, sheet };
  });
}
