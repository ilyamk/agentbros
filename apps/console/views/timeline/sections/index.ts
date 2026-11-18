/**
 * The timeline view's sections, in page order (RFC 0004 WP13). Each area owns one file (`<id>.tsx` and
 * `<id>.strings.ts`, plus any siblings it adds) and replaces the placeholder body; this list changes only when a
 * section is added or moved.
 */
import type { ComponentType } from "react";
import type { TimelineSectionProps } from "../section";
import { EditSection } from "./edit";
import { SnapshotsSection } from "./snapshots";
import { AssetsSection } from "./assets";
import { BudgetSection } from "./budget";
import { VisualisationsSection } from "./visualisations";
import { QaSection } from "./qa";
import { ChaptersSection } from "./chapters";
import { RealtimeSection } from "./realtime";

export interface TimelineSectionDef {
  /** DOM id `timeline-<id>`, test id `timeline-section-<id>`, strings `d.timeline.<id>`. */
  id: "edit" | "snapshots" | "assets" | "budget" | "visualisations" | "qa" | "chapters" | "realtime";
  component: ComponentType<TimelineSectionProps>;
  /** Spans the full width on large screens. */
  wide?: boolean;
}

export const TIMELINE_SECTIONS: readonly TimelineSectionDef[] = [
  { id: "edit", component: EditSection, wide: true },
  { id: "snapshots", component: SnapshotsSection },
  { id: "assets", component: AssetsSection },
  { id: "budget", component: BudgetSection },
  { id: "visualisations", component: VisualisationsSection },
  { id: "qa", component: QaSection, wide: true },
  { id: "chapters", component: ChaptersSection },
  { id: "realtime", component: RealtimeSection, wide: true },
];
