import { TransitionSeries } from "@remotion/transitions";
import React from "react";
import { AbsoluteFill, useVideoConfig } from "remotion";
import { z } from "zod";
import { groundSwap } from "../transitions/GroundSwap";
import { cutTiming } from "../transitions/WhipPan";
import { CursorClick } from "../ui/CursorClick";
import { DashboardAssemble } from "../ui/DashboardAssemble";
import { ToastStack } from "../ui/ToastStack";
import { MaybeFinish, sceneBaseSchema, useLook } from "./shared";

export const sceneFeatureDemoSchema = sceneBaseSchema.extend({
  product: z.string(),
  dashboardTitle: z.string(),
  /** Frames the dashboard builds and holds before the cut to the action. */
  dashboardFrames: z.number().int().min(40),
  actionTitle: z.string(),
  actionBody: z.string(),
  checks: z.array(z.string()),
  buttonLabel: z.string(),
  /** What the clicked button opens into: a title and one quiet line. */
  nextTitle: z.string(),
  nextLine: z.string(),
  /** Frame, inside the dashboard shot, the camera pushes to the chart. */
  pushAt: z.number().int().min(0),
  /** Frame, inside the action shot, the click lands: the SFX frame and the cause of the done state. */
  clickAt: z.number().int().min(20),
  actionFrames: z.number().int().min(60),
});

export type SceneFeatureDemoProps = z.infer<typeof sceneFeatureDemoSchema>;

export const WHIP_FRAMES = 9;

export const featureDemoFrames = (p: Pick<SceneFeatureDemoProps, "dashboardFrames" | "actionFrames">): number =>
  p.dashboardFrames + p.actionFrames - WHIP_FRAMES;

/**
 * The product screen assembles on the light ground, a hard ground-swap cut lands on the action, and a cursor click
 * causes the next state (the button floods into the accent ground).
 * In a vertical frame (where the click card is unchecked) the cut lands on a lock screen where the results arrive as notifications.
 */
export const SceneFeatureDemo: React.FC<SceneFeatureDemoProps> = ({
  styleId,
  finish,
  product,
  dashboardTitle,
  dashboardFrames,
  actionTitle,
  actionBody,
  checks,
  buttonLabel,
  nextTitle,
  nextLine,
  pushAt,
  clickAt,
  actionFrames,
}) => {
  const { width, height } = useVideoConfig();
  const look = useLook(styleId);
  const accent = look.palette.accent;
  const dashboard = (
    <DashboardAssemble
      product={product}
      title={dashboardTitle}
      accent={accent}
      tone="light"
      start={0}
      step={1.5}
      pushAt={pushAt}
    />
  );
  return (
    <MaybeFinish on={finish} styleId={styleId} seed="scene-demo">
      {height > width ? (
        <TransitionSeries>
          <TransitionSeries.Sequence durationInFrames={dashboardFrames}>{dashboard}</TransitionSeries.Sequence>
          <TransitionSeries.Transition presentation={groundSwap()} timing={cutTiming(WHIP_FRAMES)} />
          <TransitionSeries.Sequence durationInFrames={actionFrames}>
            <ToastStack
              toasts={[
                ...checks.map((check) => ({
                  app: product,
                  title: check,
                  body: actionTitle,
                  icon: "card",
                  time: "now",
                })),
                { app: product, title: nextTitle, body: nextLine, icon: "send", time: "now" },
              ]}
              accent={accent}
              accentIndex={checks.length}
              start={8}
              gap={16}
              mode="list"
              context="screen"
              clock="9:41"
              date="Tuesday, 14 April"
            />
          </TransitionSeries.Sequence>
        </TransitionSeries>
      ) : (
        <TransitionSeries>
          <TransitionSeries.Sequence durationInFrames={dashboardFrames}>{dashboard}</TransitionSeries.Sequence>
          <TransitionSeries.Transition presentation={groundSwap()} timing={cutTiming(WHIP_FRAMES)} />
          <TransitionSeries.Sequence durationInFrames={actionFrames}>
            <CursorClick
              title={actionTitle}
              body={actionBody}
              checks={checks}
              buttonLabel={buttonLabel}
              nextTitle={nextTitle}
              nextLine={nextLine}
              accent={accent}
              clickAt={clickAt}
              travel={28}
            />
          </TransitionSeries.Sequence>
        </TransitionSeries>
      )}
    </MaybeFinish>
  );
};

export const sceneFeatureDemoDefaults: SceneFeatureDemoProps = {
  styleId: "paper-signal",
  finish: true,
  product: "Apex",
  dashboardTitle: "Renders this week",
  dashboardFrames: 120,
  actionTitle: "Publish the launch film",
  actionBody: "Render every format, check every frame and send the cut to the team.",
  checks: ["Landscape and vertical rendered", "Frame checks passed", "Captions in 13 languages"],
  buttonLabel: "Publish now",
  nextTitle: "Published.",
  nextLine: "Every format, checked frame by frame",
  pushAt: 58,
  clickAt: 62,
  actionFrames: 120,
};
