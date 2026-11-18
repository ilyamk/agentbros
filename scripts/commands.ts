/** Lists the command registry: alias, script, section, spend, MCP tool and purpose. Reads only, unless --write-doc. */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { APPLE_COMMANDS, availableLocalCommands } from "../src/lib/local-capabilities";
import { parseArgs, runScript } from "../src/lib/cli";
import { CATALOGUE_DOC, SECTIONS, findCommands, mcpToolName, withCatalogue } from "../src/lib/cli/commands";

void runScript(async () => {
  const args = parseArgs([
    {
      name: "all",
      type: "boolean",
      description: "Full static catalogue, including unprepared optional native commands",
    },
    {
      name: "query",
      description:
        "Words that must all appear in a keyword, the alias, script, purpose, section or MCP tool; best matches first",
    },
    { name: "section", choices: Object.keys(SECTIONS), description: "Only one section" },
    { name: "paid", type: "boolean", description: "Only commands that can spend (paid or may-spend)" },
    { name: "write-doc", type: "boolean", description: `Regenerate the catalogue section of ${CATALOGUE_DOC}` },
  ] as const);
  if (args["write-doc"]) {
    const file = path.resolve(import.meta.dirname, "..", CATALOGUE_DOC);
    writeFileSync(file, withCatalogue(readFileSync(file, "utf8")));
    return { outputs: [CATALOGUE_DOC], metadata: { written: CATALOGUE_DOC } };
  }
  const matches = findCommands({ query: args.query, section: args.section, paid: args.paid });
  const ready =
    args.all || !matches.some((entry) => entry.alias && APPLE_COMMANDS.has(entry.alias))
      ? undefined
      : await availableLocalCommands();
  const commands = matches
    .filter((entry) => !ready || !entry.alias || !APPLE_COMMANDS.has(entry.alias) || ready.has(entry.alias))
    .map((entry) => ({ ...entry, mcp: mcpToolName(entry) ?? entry.mcp }));
  for (const entry of commands) {
    const mcp = typeof entry.mcp === "string" ? entry.mcp : `excluded: ${entry.mcp.excluded}`;
    process.stderr.write(
      `${(entry.alias ?? `(${entry.unaliased}) ${entry.script}`).padEnd(24)} ${entry.section.padEnd(10)} ${entry.paid.padEnd(9)} ${entry.purpose}\n${" ".repeat(25)}${entry.script ?? "-"} | MCP ${mcp}\n`,
    );
  }
  return { metadata: { count: commands.length, sections: SECTIONS, commands } };
});
