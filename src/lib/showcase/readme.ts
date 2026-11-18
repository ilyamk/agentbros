import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { readShowcases } from "./data";

export function showcaseReadme(root: string) {
  const file = path.join(root, "README.md"),
    source = readFileSync(file, "utf8");
  const clean = (value: string) => value.replace(/[\[\]<>\\*`_]/g, "").replace(/[\r\n]/g, " ");
  const entries = readShowcases(root)
    .filter((entry) => entry.verification !== "declared")
    .slice(0, 6);
  const body = entries.length
    ? entries
        .map(
          (entry) =>
            `- [${clean(entry.title)}](https://ilyamk.github.io/agentbros/showcases/${entry.slug}/) — @${entry.author.handle} · ${entry.verification}`,
        )
        .join("\n")
    : "Verified community films will appear here. [Share a showcase](docs/showcases.md).";
  const block = `<!-- showcases:start -->\n\n${body}\n\n<!-- showcases:end -->`;
  const markers = /<!-- showcases:start -->[\s\S]*?<!-- showcases:end -->/;
  if (source.includes("<!-- showcases:start -->") !== source.includes("<!-- showcases:end -->"))
    throw new Error("Incomplete README showcase markers");
  const heading = /(^## [^\n]*Now Showing[^\n]*\n)/m;
  if (!markers.test(source) && !heading.test(source)) throw new Error("README Now Showing section is missing");
  writeFileSync(
    file,
    markers.test(source) ? source.replace(markers, block) : source.replace(heading, `$1\n${block}\n`),
  );
  return { outputs: ["README.md"], metadata: { showcases: entries.length } };
}
