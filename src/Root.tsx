import "./index.css";
import { Composition, Folder } from "remotion";
import type { CalculateMetadataFunction } from "remotion";
import { GenericProject, calculateProjectMetadata } from "./components/GenericProject";
import { ProjectVideoSchema, PROJECT_COMPOSITION_IDS } from "./lib/project-props";
import { compileTimeline } from "./lib/timeline";
import { PromoVideo } from "./components/PromoVideo";
import { SetupSmoke } from "./components/SetupSmoke";
import {
  VERTICAL_CONFIG,
  SQUARE_CONFIG,
  LANDSCAPE_CONFIG,
  VideoSchema,
  DEFAULT_SCENES,
  type VideoProps,
  type Scene,
} from "./types/video";

function calcDuration(scenes: Scene[], fps: number): number {
  return compileTimeline(scenes, { fps }).durationInFrames;
}

/** Derive duration from props so any composition auto-adjusts */
const calculateMetadata: CalculateMetadataFunction<VideoProps> = ({ props, defaultProps }) => {
  const scenes = props.scenes ?? defaultProps.scenes;
  const fps = 30;
  const dur = calcDuration(scenes, fps);
  return { durationInFrames: dur, props };
};

// --- Demo project defaults ---
const demoProps: Omit<VideoProps, "format"> = {
  projectId: "demo",
  productName: "Agent Bros. Pictures",
  tagline: "Create stunning videos with AI",
  accentColor: "#6C5CE7",
  bgColor: "#0F0F0F",
  textColor: "#FFFFFF",
  scenes: DEFAULT_SCENES.map((scene) => ({
    ...scene,
    durationInFrames: 4 * VERTICAL_CONFIG.fps,
  })),
  voiceoverEnabled: false,
  musicVolume: 0.15,
};

const demoDuration = calcDuration(demoProps.scenes, VERTICAL_CONFIG.fps);

export const RemotionRoot = () => {
  return (
    <>
      <Folder name="Projects">
        {(["vertical", "square", "landscape"] as const).map((format) => (
          <Composition
            key={format}
            id={PROJECT_COMPOSITION_IDS[format]}
            component={GenericProject}
            {...(format === "vertical" ? VERTICAL_CONFIG : format === "square" ? SQUARE_CONFIG : LANDSCAPE_CONFIG)}
            durationInFrames={demoDuration}
            schema={ProjectVideoSchema}
            calculateMetadata={calculateProjectMetadata}
            defaultProps={{ ...demoProps, musicVolume: 0, format }}
          />
        ))}
      </Folder>
      {/* Demo project */}
      <Folder name="Demo">
        <Composition
          id="TalkingHeadDemo"
          component={GenericProject}
          {...LANDSCAPE_CONFIG}
          durationInFrames={demoDuration}
          schema={ProjectVideoSchema}
          calculateMetadata={calculateProjectMetadata}
          defaultProps={{ ...demoProps, musicVolume: 0, format: "landscape" as const }}
        />
        <Composition
          id="Vertical"
          component={PromoVideo}
          {...VERTICAL_CONFIG}
          durationInFrames={demoDuration}
          schema={VideoSchema}
          calculateMetadata={calculateMetadata}
          defaultProps={{
            ...demoProps,
            format: "vertical" as const,
          }}
        />
        <Composition
          id="Square"
          component={PromoVideo}
          {...SQUARE_CONFIG}
          durationInFrames={demoDuration}
          schema={VideoSchema}
          calculateMetadata={calculateMetadata}
          defaultProps={{
            ...demoProps,
            format: "square" as const,
          }}
        />
      </Folder>
      {/* Install check rendered by pnpm bootstrap --smoke */}
      <Folder name="Setup">
        <Composition id="SetupSmoke" component={SetupSmoke} {...SQUARE_CONFIG} durationInFrames={SQUARE_CONFIG.fps} />
      </Folder>
    </>
  );
};
