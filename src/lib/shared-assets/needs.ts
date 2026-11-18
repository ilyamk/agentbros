/**
 * Which shared assets a library item or composition loads through staticFile(). Remotion cannot fetch at
 * render time, so the CLIs that render (render, motion:render, library:preview) call ensureAssets() first.
 * tests/shared-assets.test.ts checks that every manifest target named in src/ is covered here.
 */
const HDRI = ["hdri:studio", "hdri:softbox", "hdri:warm", "hdri:loft"];

export const LIBRARY_NEEDS: Record<string, readonly string[]> = {
  "studio-product-stage": ["3d:phone", "3d:laptop", ...HDRI],
  "scene-product-reveal": ["3d:phone", ...HDRI],
  "blender-plate": ["plates:hero-turntable"],
  "paper-collage-assemble": ["collage:phone-cutout"],
};

/** Compositions outside the library, by exact id. */
export const COMPOSITION_NEEDS: Record<string, readonly string[]> = {
  Showcase: ["showcase:order-capture", "showcase:roast-shader", "showcase:coffee-pour"],
  LabReel: ["lab:studio-recording"],
  StudioDemoL: ["lab:studio-recording"],
  StudioScreenshotL: ["lab:studio"],
  PhonePlaybackV: ["lab:poster-vertical"],
  KineticLab: ["lab:studio"],
  CollageDemoL: ["lab:studio"],
};

/** Library-reel style compositions render every block. */
const EVERYTHING = new Set(["library-reel"]);

export function needsForLibraryItems(ids: readonly string[]): string[] {
  if (ids.some((id) => EVERYTHING.has(id))) return [...new Set(Object.values(LIBRARY_NEEDS).flat())];
  return [...new Set(ids.flatMap((id) => LIBRARY_NEEDS[id] ?? []))];
}

/** Library compositions are `Lib-<item id>-<format suffix>` (src/lib/library/paths.ts). */
export function needsForComposition(composition: string): string[] {
  if (COMPOSITION_NEEDS[composition]) return [...COMPOSITION_NEEDS[composition]];
  const match = /^Lib-(.+)-[^-]+$/.exec(composition);
  return match ? needsForLibraryItems([match[1]!]) : [];
}

const COMPONENT_NEEDS: Record<string, string> = {
  StudioProductStage: "studio-product-stage",
  SceneProductReveal: "scene-product-reveal",
  BlenderPlate: "blender-plate",
  PaperCollage: "paper-collage-assemble",
};

/** Needs of free-form project code or JSON: library component names and manifest targets it mentions. */
export function needsForSource(text: string, targets: ReadonlyMap<string, string>): string[] {
  const items = Object.entries(COMPONENT_NEEDS)
    .filter(([name]) => text.includes(name))
    .map(([, item]) => item);
  const direct = [...targets].filter(([target]) => text.includes(target.replace(/^public\//, ""))).map(([, id]) => id);
  return [...new Set([...needsForLibraryItems(items), ...direct])];
}
