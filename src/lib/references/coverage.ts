import { z } from "zod";
import policyData from "./coverage.json";
import { EntityKindSchema, type EntityCard, type EntityKind, type EntityVersion } from "../../types/entities";
import { EntityViewRoleSchema, type EntityReferenceFacts } from "../../types/reference-view";

/**
 * Advisory entity coverage (RFC 0003 §6.1, D9): which card views a kind needs and which declared facts make
 * them usable as model references. Pure: reads a card or a version, never media. Unknown facts are reported
 * with severity "unknown" and never fail coverage.
 */

const WILDCARD = /^(expression|outfit|plate|lighting|custom):\*$/;
/** One policy slot: a view role, alternatives joined by `|`, or a `prefix:*` wildcard. */
const PolicyRoleSchema = z
  .string()
  .min(1)
  .refine(
    (value) => value.split("|").every((part) => WILDCARD.test(part) || EntityViewRoleSchema.safeParse(part).success),
    { message: "Coverage roles must be view roles, `a|b` alternatives or a `prefix:*` wildcard." },
  );
/**
 * Rules (each warns on declared facts; an undeclared fact it needs gives an "unknown" finding instead):
 * - `minDistinctYawDeg:<n>`: fewer than two angle views (front, three-quarter-*, profile-*, back), fewer than two
 *   declared yaws n° apart, or two angle views closer than n° (near duplicates make the model snap between them).
 * - `background:neutral` / `lighting:even`: a sheet view (not a plate, palette, style board, voice or performance
 *   clip) declares a scene background (transparent counts as neutral; packs flatten it) or non-even light.
 * - `oneOutfitPerSheet`: identity views (angles, face-closeup, full-body, expression:*) declare more than one
 *   outfitId, or two different outfit:* roles share one outfitId.
 * - `handsEmptyOnTurnaround`: an angle or full-body view declares handsEmpty false.
 * - `onePlatePerLighting`: two different references share one plate or lighting:* role; each lighting state gets
 *   its own `plate:<state>` / `lighting:<state>` role, or the card is forked.
 * - `noUnintendedPeople` (locations) / `styleWithoutSubject` (styles): a reference declares containsOtherPeople
 *   true; for a style card any person is a subject.
 */
export const CoverageRuleSchema = z.union([
  z.string().regex(/^minDistinctYawDeg:([1-9]\d?|1[0-7]\d|180)$/),
  z.enum([
    "background:neutral",
    "lighting:even",
    "oneOutfitPerSheet",
    "handsEmptyOnTurnaround",
    "onePlatePerLighting",
    "noUnintendedPeople",
    "styleWithoutSubject",
  ]),
]);
export type CoverageRule = z.infer<typeof CoverageRuleSchema>;
export const KindCoveragePolicySchema = z
  .object({
    required: z.array(PolicyRoleSchema).default([]),
    recommended: z.array(PolicyRoleSchema).default([]),
    optional: z.array(PolicyRoleSchema).default([]),
    rules: z.array(CoverageRuleSchema).default([]),
  })
  .strict();
export type KindCoveragePolicy = z.infer<typeof KindCoveragePolicySchema>;
/** `src/lib/references/coverage.json`: one policy per entity kind. */
export const CoveragePolicySchema = z
  .object(
    Object.fromEntries(EntityKindSchema.options.map((kind) => [kind, KindCoveragePolicySchema])) as Record<
      EntityKind,
      typeof KindCoveragePolicySchema
    >,
  )
  .strict();
export type CoveragePolicy = z.infer<typeof CoveragePolicySchema>;

let cached: CoveragePolicy | undefined;
export function loadCoveragePolicy(): CoveragePolicy {
  return (cached ??= CoveragePolicySchema.parse(policyData));
}

export type CoverageFinding = {
  rule: CoverageRule;
  severity: "warn" | "unknown";
  message: string;
  /** Asset ids of the card references the finding is about. */
  references?: string[];
};
export type CoverageReport = {
  kind: EntityKind;
  id: string;
  revision?: number;
  /** Every required and recommended view is present and no rule warns; "unknown" findings never block it. */
  satisfied: boolean;
  /** Required then recommended slots with no matching view, as written in the policy. */
  missing: string[];
  missingRequired: string[];
  missingRecommended: string[];
  /** Distinct vocabulary roles on the card (voice samples count as `voice-sample`). */
  present: string[];
  /** Card roles outside the view-role vocabulary: readable, never matched, never a failure. */
  unrecognisedRoles: string[];
  ruleFindings: CoverageFinding[];
  advisory: true;
};

type Reference = EntityCard["references"][number];
const ANGLE_VIEWS = new Set([
  "front",
  "three-quarter-left",
  "three-quarter-right",
  "profile-left",
  "profile-right",
  "back",
]);
const TURNAROUND_VIEWS = new Set([...ANGLE_VIEWS, "full-body"]);
/** Views that show a reference subject on a sheet: background and light rules apply to these. */
const NON_SHEET_VIEWS = new Set(["voice-sample", "performance-clip", "palette", "style-board"]);
const isIdentityView = (role: string) =>
  ANGLE_VIEWS.has(role) || role === "face-closeup" || role === "full-body" || role.startsWith("expression:");
const isPlate = (role: string) => role.startsWith("plate") || role.startsWith("lighting:");
const recognised = (role: string) => EntityViewRoleSchema.safeParse(role).success;
const facts = (ref: Reference): EntityReferenceFacts => ref.facts ?? {};
const ids = (refs: Reference[]) => [...new Set(refs.map((ref) => ref.assetId))];
const roles = (refs: Reference[]) => [...new Set(refs.map((ref) => ref.role))].join(", ");
const yawDistance = (a: number, b: number) => {
  const d = Math.abs(a - b) % 360;
  return Math.min(d, 360 - d);
};
function matches(slot: string, present: Set<string>): boolean {
  return slot.split("|").some((part) => {
    if (!WILDCARD.test(part)) return present.has(part);
    const prefix = part.slice(0, -1);
    return [...present].some((role) => role.startsWith(prefix));
  });
}

function checkRule(rule: CoverageRule, refs: Reference[]): CoverageFinding[] {
  const out: CoverageFinding[] = [];
  const add = (severity: CoverageFinding["severity"], message: string, list?: Reference[]) =>
    out.push({ rule, severity, message, ...(list?.length ? { references: ids(list) } : {}) });
  const sheet = refs.filter((ref) => recognised(ref.role) && !NON_SHEET_VIEWS.has(ref.role) && !isPlate(ref.role));
  if (rule.startsWith("minDistinctYawDeg:")) {
    const minimum = Number(rule.slice("minDistinctYawDeg:".length));
    const angles = refs.filter((ref) => ANGLE_VIEWS.has(ref.role));
    if (angles.length < 2) {
      add(
        "warn",
        `${angles.length} angle view(s); add at least two views ${minimum}° or more apart (front plus three-quarter or profile) so the model does not infer unseen sides.`,
        angles,
      );
      return out;
    }
    const declared = angles.filter((ref) => facts(ref).yawDeg !== undefined);
    const undeclared = angles.filter((ref) => facts(ref).yawDeg === undefined);
    if (undeclared.length)
      add("unknown", `facts.yawDeg is not declared on ${roles(undeclared)}; the yaw spread is unchecked.`, undeclared);
    if (declared.length < 2) return out;
    const picked: number[] = [];
    for (const yaw of declared.map((ref) => facts(ref).yawDeg!).sort((a, b) => a - b))
      if (picked.every((other) => yawDistance(yaw, other) >= minimum)) picked.push(yaw);
    const close = declared.filter((ref, i) =>
      declared.some((other, j) => i !== j && yawDistance(facts(ref).yawDeg!, facts(other).yawDeg!) < minimum),
    );
    if (picked.length < 2)
      add(
        "warn",
        `Declared yaws give ${picked.length} distinct view(s) ${minimum}° apart; at least two are needed.`,
        declared,
      );
    else if (close.length)
      add(
        "warn",
        `${roles(close)} are less than ${minimum}° apart; near-duplicate angles make the model snap between them.`,
        close,
      );
    return out;
  }
  if (rule === "background:neutral" || rule === "lighting:even") {
    const field = rule === "background:neutral" ? "background" : "lighting";
    const ok = field === "background" ? ["neutral", "transparent"] : ["even"];
    const bad = sheet.filter((ref) => {
      const value = facts(ref)[field];
      return value !== undefined && value !== "unknown" && !ok.includes(value);
    });
    const unknown = sheet.filter((ref) => (facts(ref)[field] ?? "unknown") === "unknown");
    if (bad.length)
      add(
        "warn",
        field === "background"
          ? `${roles(bad)} have a scene background; identity and product views need a neutral one, or it bakes into the shot.`
          : `${roles(bad)} are not evenly lit; directional or scene light bakes into the result.`,
        bad,
      );
    if (unknown.length) add("unknown", `facts.${field} is not declared on ${roles(unknown)}.`, unknown);
    return out;
  }
  if (rule === "oneOutfitPerSheet") {
    const identity = refs.filter((ref) => isIdentityView(ref.role));
    const outfits = new Set(identity.map((ref) => facts(ref).outfitId).filter(Boolean));
    if (outfits.size > 1)
      add(
        "warn",
        `Identity views show ${outfits.size} outfits (${[...outfits].join(", ")}); keep one costume per card and fork the card or tag extra costumes as outfit:*.`,
        identity.filter((ref) => facts(ref).outfitId),
      );
    const outfitRefs = refs.filter((ref) => ref.role.startsWith("outfit:"));
    const byOutfit = new Map<string, Reference[]>();
    for (const ref of outfitRefs) {
      const outfit = facts(ref).outfitId;
      if (outfit) byOutfit.set(outfit, [...(byOutfit.get(outfit) ?? []), ref]);
    }
    for (const [outfit, list] of byOutfit)
      if (new Set(list.map((ref) => ref.role)).size > 1)
        add(
          "warn",
          `Outfit roles ${roles(list)} share outfitId "${outfit}"; each outfit:* sheet is one costume.`,
          list,
        );
    const undeclared = [...identity, ...outfitRefs].filter((ref) => !facts(ref).outfitId);
    if (undeclared.length && identity.length + outfitRefs.length > 1)
      add("unknown", `facts.outfitId is not declared on ${roles(undeclared)}.`, undeclared);
    return out;
  }
  if (rule === "handsEmptyOnTurnaround") {
    const turnaround = refs.filter((ref) => TURNAROUND_VIEWS.has(ref.role));
    const holding = turnaround.filter((ref) => facts(ref).handsEmpty === false);
    const unknown = turnaround.filter((ref) => facts(ref).handsEmpty === undefined);
    if (holding.length)
      add("warn", `${roles(holding)} show something in the hands; props belong on their own sheet.`, holding);
    if (unknown.length) add("unknown", `facts.handsEmpty is not declared on ${roles(unknown)}.`, unknown);
    return out;
  }
  if (rule === "onePlatePerLighting") {
    const byRole = new Map<string, Reference[]>();
    for (const ref of refs.filter((r) => isPlate(r.role))) byRole.set(ref.role, [...(byRole.get(ref.role) ?? []), ref]);
    for (const [role, list] of byRole)
      if (ids(list).length > 1)
        add(
          "warn",
          `${list.length} references share the role ${role}; give each lighting state its own plate:<state> or lighting:<state> role, or fork the card.`,
          list,
        );
    return out;
  }
  if (rule === "noUnintendedPeople" || rule === "styleWithoutSubject") {
    const visual = refs.filter((ref) => ref.role !== "voice-sample");
    const people = visual.filter((ref) => facts(ref).containsOtherPeople === true);
    const unknown = visual.filter((ref) => facts(ref).containsOtherPeople === undefined);
    if (people.length)
      add(
        "warn",
        rule === "noUnintendedPeople"
          ? `${roles(people)} contain people; keep plates empty unless people are intended, or they leak into the shot.`
          : `${roles(people)} contain a subject; style references carry no subject, or its identity entangles with the look.`,
        people,
      );
    if (unknown.length) add("unknown", `facts.containsOtherPeople is not declared on ${roles(unknown)}.`, unknown);
    return out;
  }
  return out;
}

/** Advisory coverage of one card or immutable card version against the kind's policy. */
export function computeCoverage(
  input: EntityCard | EntityVersion,
  policy: CoveragePolicy = loadCoveragePolicy(),
): CoverageReport {
  const version = "card" in input ? input : undefined;
  const card = version ? version.card : (input as EntityCard);
  const refs = card.references;
  const kindPolicy = policy[card.kind];
  const present = new Set(refs.map((ref) => ref.role).filter(recognised));
  if (card.kind === "character" && card.voice?.sampleAssetIds?.length) present.add("voice-sample");
  const unrecognisedRoles = [...new Set(refs.map((ref) => ref.role).filter((role) => !recognised(role)))];
  const missingRequired = kindPolicy.required.filter((slot) => !matches(slot, present));
  const missingRecommended = kindPolicy.recommended.filter((slot) => !matches(slot, present));
  const ruleFindings = kindPolicy.rules.flatMap((rule) => checkRule(rule, refs));
  return {
    kind: card.kind,
    id: card.id,
    ...(version ? { revision: version.revision } : {}),
    satisfied:
      missingRequired.length === 0 &&
      missingRecommended.length === 0 &&
      ruleFindings.every((finding) => finding.severity !== "warn"),
    missing: [...missingRequired, ...missingRecommended],
    missingRequired,
    missingRecommended,
    present: [...present].sort(),
    unrecognisedRoles,
    ruleFindings,
    advisory: true,
  };
}
