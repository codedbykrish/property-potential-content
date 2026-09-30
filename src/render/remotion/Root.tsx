import React from "react";
import { Composition } from "remotion";
import { FPS, HEIGHT, WIDTH, type ReelProps } from "../props";
import { PropertyReel, Thumbnail } from "./PropertyReel";

const placeholder: ReelProps = {
  fps: FPS,
  durationSec: 5,
  segments: [],
  words: [],
  endCard: { fromSec: 3, headline: "Property Potential", sub: "See what a property could be worth" },
  thumbnail: { imageSrc: "", text: "Preview" },
};

export const Root: React.FC = () => (
  <>
    <Composition
      id="PropertyReel"
      component={PropertyReel}
      width={WIDTH}
      height={HEIGHT}
      fps={FPS}
      durationInFrames={FPS * 5}
      defaultProps={placeholder}
      calculateMetadata={({ props }) => ({ durationInFrames: Math.ceil(props.durationSec * props.fps) })}
    />
    <Composition id="Thumbnail" component={Thumbnail} width={WIDTH} height={HEIGHT} fps={FPS} durationInFrames={1} defaultProps={placeholder} />
  </>
);
