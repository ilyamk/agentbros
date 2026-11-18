import { runScript, parseArgs, CliErrorObject } from "../src/lib/cli";
import { profilePresets, readProfile, setProfile } from "../src/lib/icon-resources/storage";
runScript(async () => {
  const a = parseArgs([
    { name: "project", required: true, description: "Existing project" },
    {
      name: "action",
      choices: ["show", "presets", "set"],
      default: "show",
      description: "Read or set project icon profile",
    },
    { name: "preset", choices: profilePresets, description: "Icon family and variant" },
    { name: "colour", description: "#RRGGBB" },
    { name: "size", type: "number", description: "Default square export size" },
    { name: "padding", type: "number", description: "Export padding" },
    { name: "background", description: "transparent or #RRGGBB" },
    { name: "stroke-width", type: "number", description: "Stroke-based icon width" },
    { name: "expected-revision", type: "number", description: "Required revision when replacing an existing profile" },
  ] as const);
  try {
    const old = readProfile(process.cwd(), String(a.project));
    if (a.action === "presets") return { metadata: { presets: profilePresets } };
    if (a.action === "show") return { metadata: { profile: old ?? null } };
    const [provider, variant] = (a.preset ?? "phosphor-regular").split("-");
    const input = Object.fromEntries(
      Object.entries({
        ...old,
        provider,
        variant,
        colour: a.colour ?? old?.colour,
        size: a.size ?? old?.size,
        padding: a.padding ?? old?.padding,
        background: a.background ?? old?.background,
        strokeWidth: a["stroke-width"] ?? old?.strokeWidth,
      }).filter(([, v]) => v !== undefined),
    );
    return { metadata: { profile: setProfile(process.cwd(), String(a.project), input, a["expected-revision"]) } };
  } catch (error) {
    if (error instanceof CliErrorObject) throw error;
    throw new CliErrorObject({ code: "VALIDATION", message: String(error) });
  }
});
