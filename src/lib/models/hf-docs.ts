import type { FalCategory } from "../../types/fal-catalog";
import type { HiggsfieldSchemaDoc } from "../../types/higgsfield";

export type HiggsfieldWorkflow = Pick<HiggsfieldSchemaDoc, "endpoint" | "title" | "schema" | "usageNotes"> & {
  family: string;
  docsUrl: string;
  category?: FalCategory;
};

const unescapeMarkdown = (value: string): string => value.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~])/g, "$1");

/** Only model/workflow navigation, excluding the unrelated recommendations in the page footer. */
export function listWorkflowLinks(markdown: string): string[] {
  const section =
    markdown.match(/^## (?:Models|Workflows)\s*\n([\s\S]*?)(?=^## |$(?![\s\S]))/m)?.[1] ??
    markdown.split(/^## Related topics/m)[0]!;
  return [
    ...new Set(
      [...section.matchAll(/\]\((https:\/\/docs\.higgsfield\.ai\/docs\/models\/[^\s)]+\.md)\)/g)].map(
        (match) => match[1]!,
      ),
    ),
  ];
}

/** Parse the complete schema rather than reconstructing it from the human field descriptions. */
export function parseHiggsfieldWorkflowPage(markdown: string, url: string): HiggsfieldWorkflow | undefined {
  const endpoint =
    markdown.match(/\*\*Endpoint ID:\*\*\s*`([^`]+)`/)?.[1] ??
    (/\*\*Endpoint:\*\*\s*`POST https:\/\/api\.higgsfield\.ai\/v1\/custom-references`/.test(markdown)
      ? "v1/custom-references"
      : undefined);
  if (!endpoint || endpoint.startsWith("higgsfiled/")) return undefined;
  const plain = markdown.replace(/^> ?/gm, "");
  const fence = plain.slice(plain.indexOf("Complete JSON schema")).match(/```json[^\n]*\n([\s\S]*?)^```/m)?.[1];
  if (!fence) return undefined;
  const schema: unknown = JSON.parse(fence);
  if (!schema || typeof schema !== "object" || Array.isArray(schema))
    throw new Error(`Invalid workflow schema at ${url}.`);
  const notes = markdown.match(/^## Usage notes\s*\n([\s\S]*?)(?=^## |$(?![\s\S]))/m)?.[1] ?? "";
  const usageNotes = [...notes.matchAll(/^[*+-] (.+(?:\n[ \t]+[^\n]+)*)/gm)].map((match) =>
    unescapeMarkdown(match[1]!.replace(/\n\s+/g, " ").trim()),
  );
  const family = new URL(url).pathname.split("/").at(-2)!;
  return {
    endpoint,
    title: unescapeMarkdown(markdown.match(/^# (.+)$/m)?.[1] ?? endpoint),
    family,
    docsUrl: url,
    usageNotes,
    schema: schema as Record<string, unknown>,
    ...(endpoint === "v1/custom-references" ? { category: "training" as const } : {}),
  };
}
