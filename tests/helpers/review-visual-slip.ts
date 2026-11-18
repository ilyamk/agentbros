import { splitProject } from "./review-visual-split";
/** Existing frame-coded BT709 media and independent protected PCM, no generation/network. */
export const slipProject = (root: string) => splitProject(root, true);
