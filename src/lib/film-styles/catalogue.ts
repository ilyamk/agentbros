import { getStyle } from "../../motion/library/styles";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { FilmStyleCardSchema, FilmStyleKeySchema, type FilmStyleCard } from "../../types/film-styles";
import { CliErrorObject } from "../cli";
import { playbooksRoot } from "../playbooks/project";

export const filmStyleKey = ({ id, revision }: Pick<FilmStyleCard, "id" | "revision">) => `${id}@${revision}`;

export function readFilmStyles(root = playbooksRoot()): FilmStyleCard[] {
  const file = path.join(root, "design-reference/style-cards/catalogue.json");
  if (!existsSync(file)) return [];
  const cards = z.array(FilmStyleCardSchema).parse(JSON.parse(readFileSync(file, "utf8")));
  if (new Set(cards.map(filmStyleKey)).size !== cards.length)
    throw new CliErrorObject({ code: "VALIDATION", message: "Duplicate film style revision in the catalogue" });
  return cards;
}

export function selectFilmStyle(key: string, root?: string): FilmStyleCard {
  FilmStyleKeySchema.parse(key);
  const card = readFilmStyles(root)
    .filter((item) => (key.includes("@") ? filmStyleKey(item) === key : item.id === key))
    .sort((left, right) => right.revision - left.revision)[0];
  if (!card)
    throw new CliErrorObject({
      code: "VALIDATION",
      message: `Unknown film style "${key}". Run pnpm film:style --action list.`,
    });
  getStyle(card.preset);
  return card;
}
