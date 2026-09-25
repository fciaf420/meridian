import React from "react";
import { Composition } from "remotion";
import { Video } from "./Video";
import { TOTAL_FRAMES, FPS, WIDTH, HEIGHT } from "./utils/timing";

export const Root: React.FC = () => {
  return (
    <Composition
      id="MeridianExplainer"
      component={Video}
      durationInFrames={TOTAL_FRAMES}
      fps={FPS}
      width={WIDTH}
      height={HEIGHT}
    />
  );
};
