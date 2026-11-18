import React from "react";
import { z } from "zod";
import { AbsoluteFill, Freeze, Img, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { RegionCamera } from "../../camera";
import type { RegionKeyframe } from "../../camera-math";
import { VelocityBlur } from "../../fx";
import { regionTransform } from "../../camera-math";
import { DataTable, type DataTableProps } from "./DataTable";
import { audioReactSchema, pulse, useAudioReact, type AudioReactProp } from "../../sync/curves";
import { surface } from "./surface";

const stopSchema = z.object({
  /** Centre of the framed region, 0-1 across the material. */
  cx: z.number().min(0).max(1),
  cy: z.number().min(0).max(1),
  /** Magnification against the whole material: 1 shows all of it, 2-3 reads a detail. */
  zoom: z.number().min(1).max(8),
  /** Frames spent travelling here from the previous stop (ignored for the first). */
  move: z.number().int().min(1),
  /** Frames held still once here. */
  hold: z.number().int().min(0),
  label: z.string().optional(),
});

export const cameraReadSchema = z.object({
  /** Image under public/, e.g. "projects/x/assets/images/app.png". Empty reads the built-in results table. */
  src: z.string(),
  /** The image's own pixel size; ignored for the built-in table, which takes the frame size. */
  imageWidth: z.number().int().min(1),
  imageHeight: z.number().int().min(1),
  /** Ground around the material when it does not fill the frame. */
  ground: z.string(),
  stops: z.array(stopSchema).min(1),
  /** Stops used when the frame is portrait; keep the same `move` and `hold` as `stops` so the cues still match. */
  portraitStops: z.array(stopSchema).min(1).optional(),
  /** Directional blur on fast pans. */
  panBlur: z.boolean(),
  /** Off unless set: a tiny push in on each downbeat, from an AudioCurvesProvider above. `curve` defaults to "downbeat", `amount` (scale, at most 0.03) to 0.012; smoothed over 2 frames so the push eases in rather than pops. */
  react: audioReactSchema(0.03).optional(),
});

export type CameraReadProps = z.infer<typeof cameraReadSchema>;
export type ReadStop = z.infer<typeof stopSchema>;

/** Frame each stop is reached; the first is at 0. */
export const readStopFrames = (stops: readonly ReadStop[]): number[] => {
  const out: number[] = [];
  let t = 0;
  stops.forEach((s, i) => {
    if (i > 0) t += s.move;
    out.push(t);
    t += s.hold;
  });
  return out;
};

export const readKeys = (
  stops: readonly ReadStop[],
  stage: { width: number; height: number },
  viewport: { width: number; height: number },
): RegionKeyframe[] => {
  const arrive = readStopFrames(stops);
  const region = (s: ReadStop) => {
    const fit = Math.max(stage.width / viewport.width, stage.height / viewport.height);
    const width = (viewport.width * fit) / s.zoom;
    const height = (width * viewport.height) / viewport.width;
    return { x: s.cx * stage.width - width / 2, y: s.cy * stage.height - height / 2, width };
  };
  return stops.flatMap((s, i) => {
    const r = region(s);
    const keys: RegionKeyframe[] = [{ at: arrive[i]!, ...r, curve: "inOut" }];
    if (s.hold > 0) keys.push({ at: arrive[i]! + s.hold, ...r, curve: "linear" });
    return keys;
  });
};

export const cameraReadCues = (p: CameraReadProps) =>
  readStopFrames(p.stops)
    .slice(1)
    .map((frame, i) => ({
      frame,
      kind: "land" as const,
      sfx: "none" as const,
      weight: "support" as const,
      label: p.stops[i + 1]!.label ?? `stop ${i + 2}`,
    }));

/**
 * A camera that reads across any flat material at 2-3x: eased pans, holds and a directional smear on fast moves.
 * Children keep stage coordinates. Use `CameraRead` around a screenshot, a capture frame or any ui block.
 */
export const CameraRead: React.FC<{
  stage: { width: number; height: number };
  stops: readonly ReadStop[];
  /** The box the camera plays in; defaults to the whole composition. Pass it when nesting in a smaller container. */
  viewport?: { width: number; height: number };
  ground?: string;
  panBlur?: boolean;
  /** Off unless set: push in on downbeats; see `cameraReadSchema.react`. */
  react?: AudioReactProp;
  children: React.ReactNode;
}> = ({ stage, stops, viewport: box, ground = "#0A0A0A", panBlur = true, react, children }) => {
  const frame = useCurrentFrame();
  const config = useVideoConfig();
  const viewport = box ?? { width: config.width, height: config.height };
  const keys = readKeys(stops, stage, viewport);
  const a = regionTransform(frame, keys, viewport);
  const b = regionTransform(frame + 1, keys, viewport);
  const vx = b.x - a.x;
  const vy = b.y - a.y;
  const audio = useAudioReact(react, ["downbeat"], 2);
  const camera = (
    <VelocityBlur
      axis={Math.abs(vx) > Math.abs(vy) ? "x" : "y"}
      speed={panBlur ? Math.hypot(vx, vy) : 0}
      shutter={0.12}
      maxBlur={24}
    >
      <RegionCamera stage={stage} viewport={viewport} frame={frame} keys={keys}>
        {children}
      </RegionCamera>
    </VelocityBlur>
  );
  return (
    <div
      style={{
        position: "relative",
        width: viewport.width,
        height: viewport.height,
        overflow: "hidden",
        backgroundColor: ground,
      }}
    >
      {audio ? (
        <div
          style={{ position: "absolute", inset: 0, transform: `scale(${pulse(audio.value, audio.amount ?? 0.012)})` }}
        >
          {camera}
        </div>
      ) : (
        camera
      )}
    </div>
  );
};

const TABLE: DataTableProps = {
  tone: "light",
  accent: "#2563EB",
  label: "Worked for 18s",
  summary: "Here are 243 replacement parts in stock across four warehouses, each with a confirmed delivery date.",
  columns: ["Part", "Material", "Supplier", "Delivery"],
  rows: [
    { name: "Hinge bracket, left", title: "Brushed steel", company: "Thistlesync", email: "Thu 14 Nov, 09:00" },
    { name: "Gasket ring 40 mm", title: "Silicone", company: "Larchdeck", email: "Fri 15 Nov, 13:30" },
    { name: "Drive belt B-212", title: "Reinforced rubber", company: "Ploverbeam", email: "Thu 14 Nov, 16:00" },
    { name: "Cable gland M20", title: "Nylon", company: "Sorrelgrid", email: "Mon 18 Nov, 10:15" },
    { name: "Bearing 6204-2RS", title: "Chrome steel", company: "Quillstack", email: "Tue 19 Nov, 08:45" },
    { name: "Panel clip, short", title: "Acetal", company: "Fernlight", email: "Wed 20 Nov, 11:00" },
    { name: "Spring washer M8", title: "Spring steel", company: "Larchdeck", email: "Thu 21 Nov, 09:30" },
    { name: "Filter cartridge F3", title: "Pleated cellulose", company: "Ploverbeam", email: "Fri 22 Nov, 14:00" },
    { name: "Hose clamp 25 mm", title: "Stainless steel", company: "Thistlesync", email: "Mon 25 Nov, 08:00" },
    { name: "Knob, ribbed", title: "ABS", company: "Quillstack", email: "Tue 26 Nov, 12:15" },
  ],
  fill: "rows",
  total: 243,
  target: 2,
  targetName: "Drive belt B-212",
  start: 0,
  rowStep: 0,
  scrollAt: 0,
  scrollFrames: 6,
};

/** Library preview: an image if `src` is set, else the results table frozen in its landed state. */
export const CameraReadBlock: React.FC<CameraReadProps> = ({
  src,
  imageWidth,
  imageHeight,
  ground,
  stops: wide,
  portraitStops,
  panBlur,
  react,
}) => {
  const { width, height } = useVideoConfig();
  const stops = height > width * 1.15 && portraitStops ? portraitStops : wide;
  const stage = src ? { width: imageWidth, height: imageHeight } : { width, height };
  return (
    <AbsoluteFill>
      <CameraRead
        stage={stage}
        stops={stops}
        ground={src ? ground : surface("light").ground}
        panBlur={panBlur}
        {...(react ? { react } : {})}
      >
        {src ? (
          <Img src={staticFile(src)} style={{ width: stage.width, height: stage.height, display: "block" }} />
        ) : (
          <Freeze frame={60}>
            <DataTable {...TABLE} />
          </Freeze>
        )}
      </CameraRead>
    </AbsoluteFill>
  );
};
