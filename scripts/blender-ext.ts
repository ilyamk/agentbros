import path from "node:path";
import { arsenalPaths } from "../src/lib/blender-arsenal/paths";
import { CliErrorObject, parseArgs, runScript } from "../src/lib/cli";
import { resolveBlender } from "../src/lib/backends/blender-run";
import {
  approveExtension,
  extensionEnvironment,
  fetchExtension,
  inspectExtension,
  installExtension,
  listExtensions,
  proposeExtension,
  trialExtension,
} from "../src/lib/blender-arsenal/extensions";

const actions = ["list", "inspect", "fetch", "install", "trial", "propose", "approve", "doctor"] as const;
const specs = [
  {
    name: "action",
    choices: actions,
    default: "list",
    description: "Extension action (also accepted as first positional argument)",
  },
  { name: "id", description: "Pinned extension id" },
  { name: "file", description: "Local extension ZIP" },
  { name: "name", description: "Fresh isolated trial name" },
  { name: "purpose", description: "What this extension gives a film" },
  { name: "consent", description: "Explicit user consent: who/when/why" },
  {
    name: "allow-network-account",
    type: "boolean",
    description: "Explicit approval of network permission or account dependency",
  },
  { name: "executable", description: "Blender executable override" },
] as const;

void runScript(async () => {
  const argv = process.argv.slice(2).filter((value, index) => value !== "--" || index !== 0);
  if (argv[0] && !argv[0].startsWith("-")) argv.unshift("--action");
  const args = parseArgs(specs, argv),
    root = process.cwd();
  const required = (key: "id" | "file" | "name" | "purpose" | "consent") => {
    if (!args[key]?.trim())
      throw new CliErrorObject({ code: "INVALID_INPUT", message: `--${key} is required for ${args.action}.` });
    return args[key]!;
  };
  switch (args.action) {
    case "inspect":
      return { metadata: { inspection: inspectExtension(required("file")) } };
    case "list":
      return { metadata: { extensions: listExtensions(root) } };
    case "fetch":
      return { outputs: [await fetchExtension(root, required("id"), required("consent"))] };
    case "propose":
      return { metadata: proposeExtension(root, required("file"), required("purpose")) };
    case "approve":
      return {
        metadata: {
          extension: approveExtension(
            root,
            required("id"),
            required("consent"),
            Boolean(args["allow-network-account"]),
          ),
        },
      };
    case "install":
      return {
        metadata: installExtension(
          root,
          required("id"),
          resolveBlender(args.executable, extensionEnvironment(root)).path!,
        ),
      };
    case "trial":
      return {
        metadata: trialExtension(
          root,
          required("file"),
          required("name"),
          resolveBlender(
            args.executable,
            extensionEnvironment(root, path.join(arsenalPaths(root).trials, required("name"), "blender-user")),
          ).path!,
        ),
      };
    case "doctor": {
      const blender = resolveBlender(args.executable, extensionEnvironment(root)),
        extensions = listExtensions(root);
      return {
        metadata: {
          blender,
          environment: extensionEnvironment(root),
          extensions,
          healthy: extensions.every((entry) => entry.drift === null || entry.drift === "not installed"),
        },
      };
    }
    default:
      throw new CliErrorObject({ code: "INVALID_INPUT", message: "Unknown extension action." });
  }
});
