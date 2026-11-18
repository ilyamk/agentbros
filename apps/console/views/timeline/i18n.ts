/**
 * Timeline view strings (RFC 0004 WP13), mounted as `timeline` in every console dictionary (i18n/en.ts, ru.ts,
 * zh-Hans.ts) so i18n.test.ts checks them. Each section's strings live next to it (`sections/<id>.strings.ts`).
 */
import { editEn, editRu, editZhHans } from "./sections/edit.strings";
import { snapshotsEn, snapshotsRu, snapshotsZhHans } from "./sections/snapshots.strings";
import { assetsEn, assetsRu, assetsZhHans } from "./sections/assets.strings";
import { budgetEn, budgetRu, budgetZhHans } from "./sections/budget.strings";
import { visualisationsEn, visualisationsRu, visualisationsZhHans } from "./sections/visualisations.strings";
import { qaEn, qaRu, qaZhHans } from "./sections/qa.strings";
import { chaptersEn, chaptersRu, chaptersZhHans } from "./sections/chapters.strings";
import { realtimeEn, realtimeRu, realtimeZhHans } from "./sections/realtime.strings";
import { commonEn, commonRu, commonZhHans } from "./strings";

export const timelineEn = {
  common: commonEn,
  edit: editEn,
  snapshots: snapshotsEn,
  assets: assetsEn,
  budget: budgetEn,
  visualisations: visualisationsEn,
  qa: qaEn,
  chapters: chaptersEn,
  realtime: realtimeEn,
} as const;

export const timelineRu = {
  common: commonRu,
  edit: editRu,
  snapshots: snapshotsRu,
  assets: assetsRu,
  budget: budgetRu,
  visualisations: visualisationsRu,
  qa: qaRu,
  chapters: chaptersRu,
  realtime: realtimeRu,
};

export const timelineZhHans = {
  common: commonZhHans,
  edit: editZhHans,
  snapshots: snapshotsZhHans,
  assets: assetsZhHans,
  budget: budgetZhHans,
  visualisations: visualisationsZhHans,
  qa: qaZhHans,
  chapters: chaptersZhHans,
  realtime: realtimeZhHans,
};
