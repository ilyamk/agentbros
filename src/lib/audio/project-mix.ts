import { planProjectRender } from "../render-plan";
import { buildProjectAudioMix, readProjectAudioAutomation } from "./project-mix-plan";
import { captureAudioMasterInputs } from "./master-inputs";
function resolveProjectAudioMix(projectId: string, { rootDir = process.cwd(), timeline = true } = {}) {
  const job = planProjectRender(projectId, undefined, rootDir, { timeline }).jobs[0];
  const plan = buildProjectAudioMix(
    job.props,
    job.durationInFrames,
    rootDir,
    readProjectAudioAutomation(projectId, rootDir),
  );
  return { job, plan, rootDir };
}
/** Keep the public ordinary mixer plan API without extra provenance reads. */
export function projectAudioMix(projectId: string, options: { rootDir?: string; timeline?: boolean } = {}) {
  return resolveProjectAudioMix(projectId, options).plan;
}
export function projectAudioMixWithInputs(projectId: string, options: { rootDir?: string; timeline?: boolean } = {}) {
  const { job, plan, rootDir } = resolveProjectAudioMix(projectId, options);
  const inputs = captureAudioMasterInputs(
    projectId,
    plan,
    job.props.timeline!,
    rootDir,
    job.props.talkingHead?.audioSource === "embedded",
  );
  return { plan, inputs };
}
