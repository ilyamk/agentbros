import React from "react";
import { z } from "zod";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { RegionCamera } from "../../camera";
import type { RegionKeyframe } from "../../camera-math";
import {
  DASHBOARD_DESIGN,
  DASHBOARD_PARTS,
  DashboardScreen,
  DEFAULT_DASHBOARD,
  ease,
  MOBILE_DESIGN,
  MobileScreen,
  Stage,
  themeFor,
  useFormat,
  useStagger,
} from "./kit";

export const dashboardAssembleSchema = z.object({
  product: z.string(),
  title: z.string(),
  /** Marks exactly one element: the revenue chart. */
  accent: z.string(),
  tone: z.enum(["dark", "light"]),
  /** Frame the first block starts to appear. */
  start: z.number().int().min(0),
  /** Frames between consecutive blocks; the whole build stays within 0.6 s at the default 1.5. */
  step: z.number().min(0),
  /** Frame the camera starts its push to the chart (about 2.2x the design size). */
  pushAt: z.number().int().min(0),
});

export type DashboardAssembleProps = z.infer<typeof dashboardAssembleSchema>;

/**
 * The product screen is the frame: sidebar, header, KPI cards, chart and table rows assemble in a 0.6 s stagger,
 * then one state-to-state push crops the KPIs and chart at about 1.9x so every label reads. No tilt, no float.
 */
export const DashboardAssemble: React.FC<DashboardAssembleProps> = ({
  product,
  title,
  accent,
  tone,
  start,
  step,
  pushAt,
}) => {
  const frame = useCurrentFrame();
  const { width, height, portrait } = useFormat();
  const theme = themeFor(tone, accent);
  const reveal = useStagger(DASHBOARD_PARTS, start, step, 16, ease.arrive);
  const chartDraw = ease.state(Math.min(1, Math.max(0, (frame - start - 6) / 30)));
  const copy = { ...DEFAULT_DASHBOARD, product, title };
  const viewport = { width, height };

  const keys: RegionKeyframe[] = portrait
    ? [
        { at: 0, x: 0, y: 0, width: MOBILE_DESIGN.width },
        { at: pushAt, x: 0, y: 0, width: MOBILE_DESIGN.width },
        { at: pushAt + 20, x: 14, y: 96, width: 362, curve: ease.state },
      ]
    : [
        { at: 0, x: -76, y: 0, width: 1512 },
        { at: pushAt, x: -76, y: 0, width: 1512 },
        { at: pushAt + 20, x: 226, y: 80, width: 1128, curve: ease.state },
      ];

  return (
    <Stage ground={theme.canvas} light={tone === "dark" ? "rgba(255,255,255,0.04)" : "rgba(255,255,255,0.6)"}>
      <AbsoluteFill>
        <RegionCamera stage={portrait ? MOBILE_DESIGN : DASHBOARD_DESIGN} viewport={viewport} frame={frame} keys={keys}>
          {portrait ? (
            <MobileScreen theme={theme} reveal={reveal} chartDraw={chartDraw} />
          ) : (
            <DashboardScreen theme={theme} copy={copy} reveal={reveal} chartDraw={chartDraw} />
          )}
        </RegionCamera>
      </AbsoluteFill>
    </Stage>
  );
};
