import React from "react";
import { Composition } from "remotion";
import { DreiAirPath, DreiCells, DreiConnector, DreiLatch, DreiOptics, DreiProjector, DreiReel } from "./DreiDemos";

const L = { width: 1920, height: 1080, fps: 30 };
const V = { width: 1080, height: 1920, fps: 30 };

export const DreiDemoCompositions: React.FC = () => (
  <>
    <Composition id="DreiProjectorL" component={DreiProjector} durationInFrames={150} {...L} />
    <Composition id="DreiProjectorV" component={DreiProjector} durationInFrames={150} {...V} />
    <Composition id="DreiConnectorL" component={DreiConnector} durationInFrames={150} {...L} />
    <Composition id="DreiConnectorV" component={DreiConnector} durationInFrames={150} {...V} />
    <Composition id="DreiLatchL" component={DreiLatch} durationInFrames={120} {...L} />
    <Composition id="DreiLatchV" component={DreiLatch} durationInFrames={120} {...V} />
    <Composition id="DreiAirPathL" component={DreiAirPath} durationInFrames={150} {...L} />
    <Composition id="DreiAirPathV" component={DreiAirPath} durationInFrames={150} {...V} />
    <Composition id="DreiOpticsL" component={DreiOptics} durationInFrames={150} {...L} />
    <Composition id="DreiOpticsV" component={DreiOptics} durationInFrames={150} {...V} />
    <Composition
      id="DreiOpticsControlL"
      component={DreiOptics}
      defaultProps={{ control: true }}
      durationInFrames={150}
      {...L}
    />
    <Composition
      id="DreiOpticsControlV"
      component={DreiOptics}
      defaultProps={{ control: true }}
      durationInFrames={150}
      {...V}
    />
    <Composition id="DreiCellsL" component={DreiCells} durationInFrames={180} {...L} />
    <Composition id="DreiCellsV" component={DreiCells} durationInFrames={180} {...V} />
    <Composition id="DreiReelL" component={DreiReel} durationInFrames={900} {...L} />
  </>
);
