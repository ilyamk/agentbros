/**
 * pnpm refs:profiles — model reference profiles (RFC 0003 §6.2, §9): offline, no spend.
 *   --action list                         every family: provider, status, endpoints, slots
 *   --action show --family F              one profile in full
 *   --action for --endpoint E [--provider fal|higgsfield]   the profile of an exact endpoint (default fal)
 *   --action check                        profiles ↔ catalogue ↔ input schemas ↔ guards; fails on any error finding
 */
import { CliErrorObject, parseArgs, runScript } from "../src/lib/cli";
import {
  checkReferenceProfiles,
  listProfiles,
  profileByFamily,
  profileForEndpoint,
} from "../src/lib/references/profiles";

runScript(async () => {
  const args = parseArgs([
    { name: "action", required: true, choices: ["list", "show", "for", "check"], description: "What to do" },
    { name: "family", description: "Profile family for show, e.g. seedance-2.5" },
    { name: "endpoint", description: "Exact endpoint id for for" },
    { name: "provider", choices: ["fal", "higgsfield"], description: "Provider of --endpoint; default fal" },
    { name: "project", description: "Optional MCP project scope (unused)" },
  ] as const);
  if (args.action === "list")
    return {
      metadata: {
        profiles: listProfiles().map((profile) => ({
          family: profile.family,
          provider: profile.provider,
          status: profile.status,
          endpoints: profile.endpoints,
          slots: profile.slots.map((slot) => `${slot.id}:${slot.modality}×${slot.max}`),
          dialect: profile.dialect.kind,
          realFaces: profile.policies.realFaces,
        })),
      },
    };
  if (args.action === "show") {
    if (!args.family) throw new CliErrorObject({ code: "INVALID_INPUT", message: "show needs --family." });
    const profile = profileByFamily(args.family);
    if (!profile)
      throw new CliErrorObject({
        code: "INVALID_INPUT",
        message: `No profile family ${args.family}; see pnpm refs:profiles --action list.`,
      });
    return { metadata: { profile } };
  }
  if (args.action === "for") {
    if (!args.endpoint) throw new CliErrorObject({ code: "INVALID_INPUT", message: "for needs --endpoint." });
    const provider = (args.provider ?? "fal") as "fal" | "higgsfield";
    const profile = profileForEndpoint(args.endpoint, provider);
    return { metadata: { endpoint: args.endpoint, provider, profiled: Boolean(profile), profile: profile ?? null } };
  }
  const result = checkReferenceProfiles();
  if (!result.ok)
    throw new CliErrorObject({
      code: "VALIDATION",
      message: `${result.errors} reference profile error(s); see details.findings.`,
      details: result,
    });
  return { metadata: result };
});
