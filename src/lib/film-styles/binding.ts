import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  FilmStyleBindingSchema,
  FilmStyleStageSchema,
  type FilmStyleBinding,
  type FilmStyleCard,
} from "../../types/film-styles";
import { getStyle } from "../../motion/library/styles";
import { atomicJson, locked } from "../campaigns/production/files";
import { CliErrorObject } from "../cli";
import { filmStyleKey } from "./catalogue";

export const FILM_STYLE_ARTEFACT = "film-style.json";
export const filmStyleFile = (project: string) => path.join(project, "pipeline", FILM_STYLE_ARTEFACT);

const styleHash = ({ style, tokens }: Pick<FilmStyleBinding, "style" | "tokens">) =>
  createHash("sha256").update(JSON.stringify({ style, tokens })).digest("hex");

function prepareStyleBinding(style: FilmStyleCard): FilmStyleBinding {
  const { palette, fonts, motion, finish, grounds, typeScale } = getStyle(style.preset);
  const draft = FilmStyleBindingSchema.parse({
    version: 1,
    style,
    tokens: { palette, fonts, motion, finish, grounds, typeScale },
    sha256: "0".repeat(64),
  });
  return { ...draft, sha256: styleHash(draft) };
}

export function bindFilmStyle(project: string, style: FilmStyleCard) {
  return locked(path.join(project, "pipeline/.film-style.lock"), () => {
    const previous = readFilmStyle(project);
    if (previous && filmStyleKey(previous.style) === filmStyleKey(style)) {
      if (JSON.stringify(previous.style) !== JSON.stringify(style))
        throw new CliErrorObject({ code: "VALIDATION", message: "A film style changed without a new revision." });
      return previous;
    }
    if (existsSync(path.join(project, "pipeline/campaign-binding.json")))
      throw new CliErrorObject({
        code: "VALIDATION",
        message: "Choose a campaign member's film style in its campaign plan.",
      });
    if (
      ["briefs/look.md", "design.json", "look/styleframes.png"].some((file) =>
        existsSync(path.join(project, "pipeline", file)),
      )
    ) {
      throw new CliErrorObject({
        code: "VALIDATION",
        message: "Choose the film style before look starts. Use a fresh project to compare treatments.",
      });
    }
    return writeFilmStyle(project, style);
  });
}

export function writeFilmStyle(project: string, style: FilmStyleCard): FilmStyleBinding {
  const binding = prepareStyleBinding(style);
  atomicJson(filmStyleFile(project), binding);
  return binding;
}

export function readFilmStyle(project: string): FilmStyleBinding | undefined {
  const file = filmStyleFile(project);
  if (!existsSync(file)) return;
  const binding = FilmStyleBindingSchema.parse(JSON.parse(readFileSync(file, "utf8")));
  if (binding.sha256 !== styleHash(binding))
    throw new CliErrorObject({
      code: "VALIDATION",
      message: "The pinned film style has changed. Restore the original selection.",
    });
  return binding;
}

type FilmStyleStepContext = {
  key: string;
  title: string;
  rules?: string[];
  choices?: string;
  preset?: string;
  blocks?: string[];
  engines?: string[];
};

export function filmStyleForStep(project: string, step?: string | null): FilmStyleStepContext | undefined {
  const stage = step === "render" ? "build" : step === "qa" ? "critic" : step;
  const phase = FilmStyleStageSchema.safeParse(stage);
  if (step && !phase.success) return;
  const binding = readFilmStyle(project);
  if (!binding) return;
  const card = binding.style;
  const identity = { key: filmStyleKey(card), title: card.title };
  if (!phase.success) return identity;
  return {
    ...identity,
    rules: card.stages[phase.data],
    ...(phase.data === "look" ? { choices: card.choices, preset: card.preset } : {}),
    ...(phase.data === "build" ? { blocks: card.blocks, engines: card.engines } : {}),
  };
}
