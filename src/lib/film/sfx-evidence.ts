import type { FilmMeasure } from "../../types/film";
import type { SoundReview } from "../audio/review-evidence";

type Leg = FilmMeasure["legs"][number];

/**
 * film:measure's `sfx-evidence` leg: which placed SFX files carry a saved Earshot audit of their exact bytes, and what it
 * flagged. Warn at most, never fail: the audit is uncalibrated (edit-research has not measured it), and agents cannot
 * hear. It reads saved reports only; Earshot never runs here.
 */
export function sfxEvidenceLeg(reviews: SoundReview[] | undefined): Leg {
  const id = "sfx-evidence";
  if (!reviews?.length)
    return {
      id,
      status: "skipped",
      value: null,
      message: "No placed sounds (sound-cues.json), so there is no SFX audit to read.",
      evidence: [],
    };
  const audited = reviews.filter((row) => row.review);
  const flagged = audited.filter((row) => !row.review!.ok);
  const missing = reviews.filter((row) => !row.review);
  if (!audited.length)
    return {
      id,
      status: "skipped",
      value: 0,
      message: `None of the ${reviews.length} placed SFX file(s) has a saved Earshot audit (Earshot not prepared, or sfx:audition not run).`,
      fix: "pnpm media:prepare --engines earshot-bank --allow-download, then sfx:audition.",
      evidence: [],
    };
  const share = Math.round((audited.length / reviews.length) * 1000) / 1000;
  const message = `${audited.length} of ${reviews.length} placed SFX file(s) have a saved Earshot audit of their bytes; ${flagged.length} flagged. Advisory: the audit is not calibrated and is not hearing.`;
  if (!missing.length && !flagged.length) return { id, status: "pass", value: share, message, evidence: [] };
  return {
    id,
    status: "warn",
    value: share,
    message,
    fix: missing.length
      ? "Run sfx:audition (it audits every candidate when Earshot is prepared) or audio:review --project <id> --output pipeline/audio-review/<sha256>.json on the unaudited files; read flagged warnings before the mix ships."
      : "Read each flagged warning: swap the sound (sfx:audition) or keep it with a reason; the user judges by ear.",
    evidence: [
      ...flagged.map(
        (row) =>
          `${row.file}: ${[...row.review!.warnings, ...row.review!.notes.map((note) => `${note} (note)`)].join(", ")}`,
      ),
      ...missing.map((row) => `${row.file}: no saved audit`),
    ],
  };
}
