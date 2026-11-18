import path from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { inspectSfnt } from "./sfnt";
import { readResources } from "./registry";
import type { LocalFontManifest } from "./browser";
const REQUIRED_FONT_ROLES = [
  "primaryFont",
  "displayFont",
  "condensedFont",
  "serifFont",
  "serifNormalFont",
  "roundedFont",
  "narrowFont",
  "geometricFont",
] as const;
/** From lib/fonts-cyrillic.ts and the caption faces of lib/fonts.ts. Optional, so existing font contexts stay valid and generate the same module. */
const OPTIONAL_FONT_ROLES = [
  "cyrillicCondensedFont",
  "cyrillicWideFont",
  "cyrillicGroteskFont",
  "cyrillicRoundedFont",
  "captionHeavyItalicFont",
  "captionCondensedItalicFont",
  "captionExtraCondensedFont",
  "captionRoundedFont",
  "captionGroteskFont",
  "captionMonoFont",
] as const;
export const FONT_ROLES = [...REQUIRED_FONT_ROLES, ...OPTIONAL_FONT_ROLES] as const;
const isOptionalRole = (role: string) => (OPTIONAL_FONT_ROLES as readonly string[]).includes(role);
export type FontSelection = {
  family: string;
  style: "normal" | "italic";
  weights: number[];
  subset: string;
  requiredText: string;
};
export function createFontManifest(
  projectId: string,
  roles: Record<(typeof REQUIRED_FONT_ROLES)[number], FontSelection> &
    Partial<Record<(typeof OPTIONAL_FONT_ROLES)[number], FontSelection>>,
  rootDir = process.cwd(),
): LocalFontManifest {
  const registry = readResources(projectId, rootDir),
    faces: LocalFontManifest["faces"] = [],
    roleFamilies: Record<string, string> = {};
  for (const role of FONT_ROLES) {
    const request = roles[role];
    if (!request && isOptionalRole(role)) continue;
    if (!request || !request.weights.length) throw new Error(`Explicit cached font selection required: ${role}`);
    roleFamilies[role] = request.family;
    for (const weight of request.weights) {
      const record = registry.records.find(
        (record) =>
          record.kind === "font" &&
          record.family === request.family &&
          record.style === request.style &&
          record.weight === weight &&
          record.subset === request.subset,
      );
      if (!record || record.kind !== "font")
        throw new Error(`Missing exact cached face: ${request.family}/${weight}/${request.style}/${request.subset}`);
      if (inspectSfnt(readFileSync(path.join(rootDir, "public", record.original))).missing(request.requiredText).length)
        throw new Error(`Missing actual glyph coverage for role: ${role}`);
      faces.push({
        family: record.family,
        style: record.style,
        weight,
        original: record.original,
        hash: record.hash,
        testedText: request.requiredText,
      });
    }
  }
  return { version: 1, faces, roles: roleFamilies };
}
/** Explicit webpack alias of lib/fonts.ts to this generated module, never an automatic brand swap. */
export function writeFontRoleModule(
  manifest: LocalFontManifest,
  output: string,
  browserModule = path.resolve("src/lib/font-resources/browser"),
) {
  writeFileSync(output, fontRoleModuleSource(manifest, browserModule), { flag: "wx" });
  return output;
}

/** Controlled source shared by exclusive generation and existing-cache checks. */
export function fontRoleModuleSource(
  manifest: LocalFontManifest,
  browserModule = path.resolve("src/lib/font-resources/browser"),
) {
  return `import { loadLocalFontManifest, type LocalFontManifest } from ${JSON.stringify(browserModule)};\nconst manifest: LocalFontManifest = ${JSON.stringify(manifest)};\nvoid loadLocalFontManifest(manifest);\n${FONT_ROLES.filter(
    (role) => manifest.roles[role] !== undefined,
  )
    .map((role) => `export const ${role} = ${JSON.stringify(manifest.roles[role])};`)
    .join("\n")}\n`;
}

/** Revalidate declarative DATA and registered originals without generating files. */
export function planFontRoleContext(
  projectId: string,
  value: unknown,
  { rootDir = process.cwd(), requiredText = "" }: { rootDir?: string; requiredText?: string } = {},
) {
  const raw = value as LocalFontManifest;
  if (
    raw.version !== 1 ||
    !Array.isArray(raw.faces) ||
    raw.faces.length === 0 ||
    !raw.roles ||
    Object.keys(raw).some((key) => !["version", "faces", "roles"].includes(key))
  )
    throw new Error("Invalid declarative font context");
  const registry = readResources(projectId, rootDir);
  const captures = [path.join(rootDir, "public/projects", projectId, "resources/registry.json")];
  const faces = raw.faces.map((face) => {
    if (
      Object.keys(face).some((key) => !["family", "weight", "style", "original", "hash", "testedText"].includes(key)) ||
      typeof face.testedText !== "string"
    )
      throw new Error("Invalid font face declaration");
    const record = registry.records.find(
      (record) =>
        record.kind === "font" &&
        record.hash === face.hash &&
        record.original === face.original &&
        record.family === face.family &&
        record.weight === face.weight &&
        record.style === face.style,
    );
    if (!record) throw new Error("Font context face is not an exact registered original");
    const original = path.join(rootDir, "public", record.original),
      text = [...new Set([...face.testedText, ...requiredText])].join("");
    if (inspectSfnt(readFileSync(original)).missing(text).length)
      throw new Error("Actual cached face lacks render text coverage");
    captures.push(original, path.join(rootDir, "public", record.licenceFile));
    return { ...face, testedText: text };
  });
  for (const role of FONT_ROLES)
    if (isOptionalRole(role) && raw.roles[role] === undefined) continue;
    else if (typeof raw.roles[role] !== "string" || !faces.some((face) => face.family === raw.roles[role]))
      throw new Error(`Missing actual role family: ${role}`);
  if (Object.keys(raw.roles).some((role) => !(FONT_ROLES as readonly string[]).includes(role)))
    throw new Error("Unknown font role");
  const manifest: LocalFontManifest = { version: 1, faces, roles: raw.roles };
  return {
    manifest,
    captureFiles: [...new Set(captures)],
  };
}

/** Validate declarative JSON and generate only our controlled loader module. */
export function generateFontRoleModule(
  projectId: string,
  contextFile: string,
  modulePath: string,
  options: { rootDir?: string; requiredText?: string } = {},
) {
  const checked = planFontRoleContext(projectId, JSON.parse(readFileSync(contextFile, "utf8")), options);
  writeFontRoleModule(checked.manifest, modulePath, path.resolve("src/lib/font-resources/browser"));
  return {
    modulePath,
    manifest: checked.manifest,
    captureFiles: [...new Set([path.resolve(contextFile), ...checked.captureFiles, path.resolve(modulePath)])],
  };
}
