import { z } from "zod";

const colour = z.string().regex(/^#[0-9a-f]{6}$/i);
export const TutorialKitSchema = z
  .object({
    title: z.object({ accent: colour, text: colour, ground: colour }).strict(),
    captions: z.enum(["calm", "karaoke", "keyword"]),
    cursorColour: colour,
    cuePack: z.enum(["none", "synth-ui"]),
  })
  .strict();

export const DEFAULT_TUTORIAL_KIT = {
  title: { accent: "#42D9BC", text: "#FFFFFF", ground: "#101A20" },
  captions: "calm",
  cursorColour: "#42D9BC",
  cuePack: "synth-ui",
} as const;
