import React from "react";
import { QAEvidenceProbe } from "./QAEvidenceProbe";
import { Audio } from "@remotion/media";
import { staticFile } from "remotion";
import type { CalculateMetadataFunction } from "remotion";
import { TimelineComposition } from "./TimelineComposition";
import { compileTimelineIR } from "../lib/timeline-ir/compiler";
import { renderBoundary, freezeRenderData } from "../lib/timeline-ir/render";
import { PromoVideo } from "./PromoVideo";
import { TalkingHeadComposition } from "./TalkingHeadComposition";
import { ProjectVideoSchema, type ProjectVideoProps } from "../lib/project-props";
import { compileTimeline } from "../lib/timeline";

export const GenericProject: React.FC<ProjectVideoProps> = (props) => {
  const rendered = props.audioMaster ? { ...props, voiceoverEnabled: false, musicVolume: 0 } : props;
  const content = props.timeline ? (
    <TimelineComposition {...rendered} timeline={props.timeline} />
  ) : props.talkingHead?.enabled ? (
    <TalkingHeadComposition {...rendered} talkingHead={props.talkingHead} muteAllAudio={!!props.audioMaster} />
  ) : (
    <PromoVideo {...rendered} />
  );
  return (
    <>
      {content}
      {props.qaEvidence && <QAEvidenceProbe />}
      {props.audioMaster && <Audio src={staticFile(props.audioMaster.source)} volume={1} />}
    </>
  );
};

export const calculateProjectMetadata: CalculateMetadataFunction<ProjectVideoProps> = ({ props }) => {
  const canonical = freezeRenderData(ProjectVideoSchema.parse(props));
  if (canonical.timeline) {
    const snapshot = compileTimelineIR(canonical.timeline);
    return {
      durationInFrames: renderBoundary(snapshot.duration, snapshot.timebase, 30),
      props: canonical,
    };
  }
  const timeline = compileTimeline(canonical.scenes, {
    fps: 30,
    talkingHead: !!canonical.talkingHead?.enabled,
  });
  return { durationInFrames: timeline.durationInFrames, props: canonical };
};
