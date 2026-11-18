import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { CliErrorObject } from "../cli";
import { ResourceCandidateSchema } from "../../types/resources";

export type ResourceCredit = {
  id: string;
  provider: string;
  author: string;
  authorUrl?: string;
  sourceUrl: string;
  text: string;
  file: string;
  required: boolean;
  requested: boolean;
};

/**
 * Credits from a project's acquisition receipts: those the licence requires or the user asked for (`--credit`),
 * or every one with `all`. Receipts always keep the creator and links, so credit can be added later.
 */
export function resourceCredits(projectId: string, options: { rootDir?: string; all?: boolean } = {}) {
  if (!/^[\w.-]+$/.test(projectId) || projectId.startsWith("."))
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "Invalid project id." });
  const project = path.resolve(options.rootDir ?? process.cwd(), "public/projects", projectId);
  if (!existsSync(project))
    throw new CliErrorObject({ code: "PROJECT_NOT_FOUND", message: `Project not found: ${projectId}` });
  const directory = path.join(project, "pipeline/resources");
  const credits: ResourceCredit[] = [];
  if (existsSync(directory))
    for (const name of readdirSync(directory)
      .filter((item) => /^[a-f0-9]{64}\.json$/.test(item))
      .sort()) {
      const file = path.join(directory, name);
      if (!lstatSync(file).isFile()) continue;
      const receipt = JSON.parse(readFileSync(file, "utf8"));
      const parsed = ResourceCandidateSchema.safeParse(receipt.resource);
      if (!parsed.success || !parsed.data.rights.attributionText) continue;
      const resource = parsed.data;
      const required = resource.rights.attributionRequired === true;
      const requested = receipt.usage?.credit === true;
      if (!options.all && !required && !requested) continue;
      credits.push({
        id: resource.id,
        provider: resource.provider,
        author: resource.author,
        ...(resource.authorUrl ? { authorUrl: resource.authorUrl } : {}),
        sourceUrl: resource.sourceUrl,
        text: resource.rights.attributionText,
        file: String(receipt.file ?? ""),
        required,
        requested,
      });
    }
  const short = (credit: ResourceCredit) => {
    const via =
      { unsplash: "on Unsplash", pixabay: "via Pixabay", pexels: "on Pexels" }[credit.provider] ??
      `(${credit.provider})`;
    return `${credit.author || "Unknown creator"} ${via}`;
  };
  const markdown = [
    "# Credits",
    "",
    ...(credits.length ? credits.map((credit) => `- ${credit.text}`) : ["No credits requested or required."]),
    "",
  ].join("\n");
  return { credits, markdown, lines: credits.map(short) };
}
