import { lstatSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CreditSchema, type Credit } from "../../types/credits";

export function readCredits(root: string): Credit[] {
  const directory = path.join(root, "credits");
  if (!lstatSync(directory).isDirectory()) throw new Error("credits must be a real directory");
  return readdirSync(directory)
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map((file) => {
      if (!lstatSync(path.join(directory, file)).isFile()) throw new Error(`Expected a regular credit file: ${file}`);
      const credit = CreditSchema.parse(JSON.parse(readFileSync(path.join(directory, file), "utf8")));
      if (file !== `${credit.id}.json`) throw new Error(`Credit id does not match filename: ${file}`);
      return credit;
    });
}

function cells(credit: Credit): string[] {
  switch (credit.section) {
    case "repositories":
      return [
        credit.source,
        credit.url,
        credit.pinnedCommit,
        credit.licence,
        credit.whatWeTook,
        credit.whereItLives,
        credit.why,
        credit.date,
      ];
    case "films":
      return [credit.reference, credit.source, credit.rights, credit.whereItLives, credit.analysedFor];
    case "assets":
      return [credit.asset, credit.source, credit.licence, credit.evidence, credit.whereItLives, credit.status];
    case "tools":
      return [credit.tool, credit.role];
  }
}

export function creditsDocument(credits: Credit[]): string {
  const template = readFileSync(new URL("./credits-template.md", import.meta.url), "utf8");
  return template.replace(/\{\{(repositories|films|assets|tools)\}\}/g, (_, section: Credit["section"]) =>
    credits
      .filter((credit) => credit.section === section)
      .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
      .map((credit) => `| ${cells(credit).join(" | ")} |`)
      .join("\n"),
  );
}

export function writeCredits(root: string, check = false): number {
  const credits = readCredits(root);
  const source = creditsDocument(credits);
  const file = path.join(root, "CREDITS.md");
  const stat = lstatSync(file, { throwIfNoEntry: false });
  if (stat && !stat.isFile()) throw new Error("CREDITS.md must be a regular file");
  if (check) {
    if (readFileSync(file, "utf8") !== source) throw new Error("CREDITS.md is stale. Run pnpm credits:write-doc.");
  } else {
    writeFileSync(file, source);
  }
  return credits.length;
}
