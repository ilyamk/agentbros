import React from "react";
import { Composition } from "remotion";
import { libraryItems } from "./registry";
import { FORMAT_SIZE, type LibraryItem } from "./types";

const FPS = 30;
const SUFFIX = { vertical: "V", square: "S", landscape: "L" } as const;

/** One composition per item and checked format: `Lib-<id>-<V|S|L>`. */
export const makeLibraryRoot = (items: LibraryItem[]): React.FC => {
  const LibraryRootFor: React.FC = () => (
    <>
      {items.flatMap((item) =>
        item.formats.map((format) => (
          <Composition
            key={`${item.id}-${format}`}
            id={`Lib-${item.id}-${SUFFIX[format]}`}
            component={item.component}
            schema={item.schema as never}
            defaultProps={item.defaultProps as never}
            durationInFrames={item.durationInFrames}
            calculateMetadata={
              item.durationForProps ? ({ props }) => ({ durationInFrames: item.durationForProps!(props) }) : undefined
            }
            fps={FPS}
            {...FORMAT_SIZE[format]}
          />
        )),
      )}
    </>
  );
  return LibraryRootFor;
};

export const LibraryRoot = makeLibraryRoot(libraryItems);
