import { z } from "zod";

const cell = z.string().refine((value) => !/[\r\n]/.test(value), "A credit cell must fit on one line");
const common = {
  version: z.literal(1),
  id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  order: z.number().int().nonnegative(),
};
export const CreditSchema = z.discriminatedUnion("section", [
  z
    .object({
      ...common,
      section: z.literal("repositories"),
      source: cell,
      url: cell,
      pinnedCommit: cell,
      licence: cell,
      whatWeTook: cell,
      whereItLives: cell,
      why: cell,
      date: cell,
    })
    .strict(),
  z
    .object({
      ...common,
      section: z.literal("films"),
      reference: cell,
      source: cell,
      rights: cell,
      whereItLives: cell,
      analysedFor: cell,
    })
    .strict(),
  z
    .object({
      ...common,
      section: z.literal("assets"),
      asset: cell,
      source: cell,
      licence: cell,
      evidence: cell,
      whereItLives: cell,
      status: cell,
    })
    .strict(),
  z.object({ ...common, section: z.literal("tools"), tool: cell, role: cell }).strict(),
]);
export type Credit = z.infer<typeof CreditSchema>;
