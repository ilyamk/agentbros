import React from "react";
import { VizScene as Scene, vizSceneSchema as internalSchema, type VizSceneProps } from "../../viz/VizScene";
export const vizSceneSchema = internalSchema.omit({ plateSrc: true, plateFrames: true }).strict();
export const VizScene: React.FC<VizSceneProps> = (props) => <Scene {...props} />;
export { vizSceneDefaults } from "../../../lib/viz/example-plan";
