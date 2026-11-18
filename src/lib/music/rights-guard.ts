import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { MusicShortlistSchema } from "../../types/film";
import { MUSIC_PATHS, MusicSearchFileSchema, type MusicHit } from "./types";

export const MUSIC_RIGHTS_CODES = [
  "MUSIC_DECISION_MISSING",
  "MUSIC_DECISION_INVALID",
  "MUSIC_TRENDING_EMBEDDED",
  "MUSIC_REFERENCE_NO_RIGHTS",
  "MUSIC_CANDIDATE_MISSING",
  "MUSIC_LICENCE_UNKNOWN",
  "MUSIC_NON_COMMERCIAL",
  "MUSIC_NO_DERIVATIVES",
  "MUSIC_LICENCE_UNVERIFIED",
  "MUSIC_SHARE_ALIKE",
  "MUSIC_ORIGINAL_MISSING",
  "MUSIC_CREDIT_MISSING",
  "MUSIC_USER_RIGHTS_STATED",
] as const;
export type MusicRightsCode = (typeof MUSIC_RIGHTS_CODES)[number];

/** Same shape as `CreativeFinding`, so pipeline:check can list these unchanged. Each message ends with its fix. */
export type MusicRightsFinding = {
  severity: "error" | "warning" | "info";
  code: MusicRightsCode;
  stage: "music";
  message: string;
};

/** Deliberately loose: a hand-edited decision the schema would reject must still produce a finding. */
export type DecisionForGuard = { route?: string; delivery?: string; candidateId?: string; credit?: string };
export type CandidateForGuard = Partial<
  Pick<MusicHit, "syncAllowed" | "shareAlike" | "sourceVerified" | "statedRights" | "originalPath">
> &
  Pick<MusicHit, "id" | "licence">;

const finding = (
  severity: MusicRightsFinding["severity"],
  code: MusicRightsCode,
  message: string,
): MusicRightsFinding => ({ severity, code, stage: "music", message });

export function musicRights(
  decision: DecisionForGuard,
  candidate?: CandidateForGuard,
  options: { commercialFilm?: boolean } = {},
): MusicRightsFinding[] {
  const commercialFilm = options.commercialFilm ?? true;
  const findings: MusicRightsFinding[] = [];
  const embedded = decision.delivery === "embedded";
  if (decision.route === "trending-native" && embedded)
    findings.push(
      finding(
        "error",
        "MUSIC_TRENDING_EMBEDDED",
        "A trending track cannot be embedded. Set delivery to native-on-platform and let the user add the sound on the platform.",
      ),
    );
  if (!embedded) return findings;
  if (decision.route === "reference-track") {
    const status = candidate?.statedRights?.status;
    if (status !== "owned" && status !== "licensed") {
      findings.push(
        finding(
          "error",
          "MUSIC_REFERENCE_NO_RIGHTS",
          `The reference track has rights status "${status ?? "unknown"}", so it stays study-only. Ask the user who holds the rights, then rerun music --action from-reference with --rights and --rights-note.`,
        ),
      );
      return findings;
    }
  }
  if (decision.route === "free-stock" || decision.route === "reference-track") {
    if (!candidate) {
      if (decision.route === "free-stock")
        findings.push(
          finding(
            "error",
            "MUSIC_CANDIDATE_MISSING",
            `Embedded stock music needs a known candidate${decision.candidateId ? `, and ${decision.candidateId} is in no search or shortlist file` : ""}. Rerecord the decision with --candidate.`,
          ),
        );
      return findings;
    }
    const { licence } = candidate;
    if (licence.commercial === "unknown" || licence.code === "unknown")
      findings.push(
        finding(
          "error",
          "MUSIC_LICENCE_UNKNOWN",
          `${candidate.id}: licence "${licence.code}" is not confirmed for this use. Pick a track with a known licence or confirm it at source.`,
        ),
      );
    else if (licence.commercial === "no")
      findings.push(
        finding(
          commercialFilm ? "error" : "warning",
          "MUSIC_NON_COMMERCIAL",
          `${candidate.id}: ${licence.code} forbids commercial use. Pick another track${commercialFilm ? "" : ", or keep this film non-commercial"}.`,
        ),
      );
    if (candidate.syncAllowed === false && licence.code !== "unknown")
      findings.push(
        finding(
          "error",
          "MUSIC_NO_DERIVATIVES",
          `${candidate.id}: ${licence.code} does not allow syncing to picture, which is an adaptation. Pick another track.`,
        ),
      );
    if (decision.route === "free-stock" && !licence.verifiedAt)
      findings.push(
        finding(
          "error",
          "MUSIC_LICENCE_UNVERIFIED",
          `${candidate.id}: the licence has not been read from the source. Run music --action acquire, which re-reads it, or confirm it with --confirm-licence-url.`,
        ),
      );
    if (candidate.shareAlike)
      findings.push(
        finding(
          "warning",
          "MUSIC_SHARE_ALIKE",
          `${candidate.id}: ${licence.code} carries ShareAlike to the film. Get the user's acceptance or pick another track.`,
        ),
      );
    if (!candidate.originalPath)
      findings.push(
        finding(
          "warning",
          "MUSIC_ORIGINAL_MISSING",
          `${candidate.id}: no original on disk, and a preview is never delivered. Run music --action acquire.`,
        ),
      );
    if (licence.attribution && !decision.credit)
      findings.push(
        finding(
          "warning",
          "MUSIC_CREDIT_MISSING",
          `${candidate.id}: the licence requires attribution. Rerecord the decision with --credit, using pipeline/music/credits.json.`,
        ),
      );
  }
  if (decision.route === "user-supplied")
    findings.push(
      finding(
        "info",
        "MUSIC_USER_RIGHTS_STATED",
        "The rights in a user-supplied track rest on the user's statement. Keep that statement in the decision.",
      ),
    );
  return findings;
}

/** Everything known about one candidate: search files carry the licence, the shortlist the local paths. */
export function findMusicCandidate(projectDir: string, id: string): MusicHit | undefined {
  const directory = path.join(projectDir, "pipeline/music");
  let found: MusicHit | undefined;
  if (existsSync(directory))
    for (const name of readdirSync(directory)
      .filter((item) => /^search-.*\.json$/.test(item))
      .sort()) {
      const file = MusicSearchFileSchema.safeParse(JSON.parse(readFileSync(path.join(directory, name), "utf8")));
      const hit = file.success ? file.data.candidates.find((item) => item.id === id) : undefined;
      if (hit) found = hit;
    }
  const shortlistPath = path.join(projectDir, MUSIC_PATHS.shortlist);
  if (found && existsSync(shortlistPath)) {
    const listed = MusicShortlistSchema.safeParse(JSON.parse(readFileSync(shortlistPath, "utf8")));
    const row = listed.success ? listed.data.candidates.find((item) => item.id === id) : undefined;
    if (row) found = { ...found, ...row };
  }
  return found;
}

/** The entry point for checks: reads the project's decision and its candidate. */
export function checkProjectMusicRights(
  projectDir: string,
  options: { commercialFilm?: boolean; decisionRequired?: boolean } = {},
): MusicRightsFinding[] {
  const target = path.join(projectDir, MUSIC_PATHS.decision);
  if (!existsSync(target))
    return options.decisionRequired
      ? [
          finding(
            "error",
            "MUSIC_DECISION_MISSING",
            "No music decision. Run music --action options, put the question to the user, then music --action record.",
          ),
        ]
      : [];
  let decision: DecisionForGuard;
  try {
    decision = JSON.parse(readFileSync(target, "utf8")) as DecisionForGuard;
  } catch {
    return [
      finding(
        "error",
        "MUSIC_DECISION_INVALID",
        `${MUSIC_PATHS.decision} is not valid JSON. Record the decision again.`,
      ),
    ];
  }
  return musicRights(
    decision,
    decision.candidateId ? findMusicCandidate(projectDir, decision.candidateId) : undefined,
    options,
  );
}
