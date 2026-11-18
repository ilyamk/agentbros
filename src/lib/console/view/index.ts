/** The console's projector (RFC 0004 WP3): the read model of a project, its waiting decisions and the home rows. */
export { buildProjectView, isProject, type BuildOptions } from "./build";
export { deriveWaiting, waitingWithAdvisories, cardDecisions } from "./waiting";
export { decisionId, bindFiles, type Binding } from "./decision";
export { outputsHash, verdictAxes, VERDICT_AXES } from "./film";
export { projectSummary } from "./summary";
export { readFilmMaterial, rubricAxes, type StepStatusById } from "./film-material";
export { createProjectorDataSource, ProjectorDataSource, fingerprint, VIEW_MAX_AGE_MS } from "./source";
export * from "./argv";
