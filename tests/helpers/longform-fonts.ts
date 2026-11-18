import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { inspectSfnt } from "../../src/lib/font-resources/sfnt";
import { importResource } from "../../src/lib/font-resources/registry";
import {
  createFontManifest,
  FONT_ROLES,
  generateFontRoleModule,
  type FontSelection,
} from "../../src/lib/font-resources/manifest";

/** Explicit installed fixture faces, no CDN, brand substitution or production licence claim. */
export function prepareLongformFonts(rootDir: string, projectId: string) {
  const requiredText =
    "Proportions 123456 A proportion compares a part with a whole. 2 divided by 4 equals 0.5. Nonzero whole. objective prerequisite concept worked-example recap check Part / whole 2 ÷ 4 = 0.5";
  const directory = process.env.LONGFORM_FONT_DIR ?? "/System/Library/Fonts/Supplemental";
  const faces = ["Arial.ttf", "Arial Bold.ttf"].map((file) => {
    const original = path.join(directory, file),
      face = inspectSfnt(readFileSync(original));
    importResource(
      projectId,
      original,
      {
        source: "installed local Full HD technical fixture",
        licence: "test only",
        licenceText: "No font redistribution or commercial project licence claim",
        licenceEvidence: "installed system face",
        attribution: "local fixture",
        checkedAt: "2026-10-11T00:00:00Z",
        kind: "font",
        family: face.family,
        weight: face.weight,
        style: face.style as "normal",
        subset: "latin",
        requiredText,
      },
      rootDir,
    );
    return face;
  });
  const selection: FontSelection = {
    family: faces[0].family,
    weights: faces.map((f) => f.weight),
    style: "normal",
    subset: "latin",
    requiredText,
  };
  const manifest = createFontManifest(
    projectId,
    Object.fromEntries(FONT_ROLES.map((role) => [role, selection])) as Record<
      (typeof FONT_ROLES)[number],
      FontSelection
    >,
    rootDir,
  );
  const context = path.join(rootDir, "public/projects", projectId, "fonts.json");
  writeFileSync(context, JSON.stringify(manifest, null, 2));
  return generateLongformFontAlias(rootDir, projectId, context);
}

export function generateLongformFontAlias(rootDir: string, projectId: string, context: string) {
  mkdirSync(path.join(rootDir, "font-code"), { recursive: true });
  const alias = path.join(rootDir, "font-code/fonts.ts");
  const checked = generateFontRoleModule(projectId, context, alias, { rootDir });
  return { context, alias, manifest: checked.manifest };
}
