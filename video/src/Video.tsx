import React from "react";
import { AbsoluteFill, Sequence, Audio, staticFile } from "remotion";
import { SCENES, TOTAL_FRAMES } from "./utils/timing";
import { COLORS } from "./styles/theme";
import { ParticleField } from "./components/ParticleField";
import { ColdOpen } from "./scenes/ColdOpen";
import { ThreeAgents } from "./scenes/ThreeAgents";
import { PoolScreening } from "./scenes/PoolScreening";
import { SignalWeighting } from "./scenes/SignalWeighting";
import { DeploymentExitRules } from "./scenes/DeploymentExitRules";
import { MemorySystems } from "./scenes/MemorySystems";
import { AutoLearning } from "./scenes/AutoLearning";

// Per-scene audio: delay = frames before narration starts (visual intro time)
// Each scene duration is sized so audio plays fully without cutoff
const SCENE_AUDIO = [
  { file: "scene1-cold-open.mp3",    scene: SCENES.COLD_OPEN,        audioDelay: 90  },
  { file: "scene2-three-agents.mp3", scene: SCENES.THREE_AGENTS,     audioDelay: 15  },
  { file: "scene3-screening.mp3",    scene: SCENES.POOL_SCREENING,   audioDelay: 15  },
  { file: "scene4-signals.mp3",      scene: SCENES.SIGNAL_WEIGHTING, audioDelay: 15  },
  { file: "scene5-deployment.mp3",   scene: SCENES.DEPLOYMENT,       audioDelay: 15  },
  { file: "scene6-memory.mp3",       scene: SCENES.MEMORY_SYSTEMS,   audioDelay: 15  },
  { file: "scene7-autolearn.mp3",    scene: SCENES.AUTO_LEARNING,    audioDelay: 15  },
] as const;

export const Video: React.FC = () => {
  return (
    <AbsoluteFill style={{ backgroundColor: COLORS.bg }}>
      {/* Persistent background particles */}
      <Sequence from={0} durationInFrames={TOTAL_FRAMES}>
        <ParticleField opacity={0.6} />
      </Sequence>

      {/* Per-scene narration audio - each plays fully within its scene */}
      {SCENE_AUDIO.map(({ file, scene, audioDelay }) => (
        <Sequence
          key={file}
          from={scene.start + audioDelay}
          durationInFrames={scene.duration - audioDelay}
        >
          {/* @ts-expect-error Remotion Audio type mismatch with React 18 */}
          <Audio src={staticFile(file)} volume={1} />
        </Sequence>
      ))}

      {/* Scene 1: Cold Open */}
      <Sequence from={SCENES.COLD_OPEN.start} durationInFrames={SCENES.COLD_OPEN.duration}>
        <ColdOpen />
      </Sequence>

      {/* Scene 2: Three Agents */}
      <Sequence from={SCENES.THREE_AGENTS.start} durationInFrames={SCENES.THREE_AGENTS.duration}>
        <ThreeAgents />
      </Sequence>

      {/* Scene 3: Pool Screening */}
      <Sequence from={SCENES.POOL_SCREENING.start} durationInFrames={SCENES.POOL_SCREENING.duration}>
        <PoolScreening />
      </Sequence>

      {/* Scene 4: Signal Weighting */}
      <Sequence from={SCENES.SIGNAL_WEIGHTING.start} durationInFrames={SCENES.SIGNAL_WEIGHTING.duration}>
        <SignalWeighting />
      </Sequence>

      {/* Scene 5: Deployment & Exit Rules */}
      <Sequence from={SCENES.DEPLOYMENT.start} durationInFrames={SCENES.DEPLOYMENT.duration}>
        <DeploymentExitRules />
      </Sequence>

      {/* Scene 6: Memory Systems */}
      <Sequence from={SCENES.MEMORY_SYSTEMS.start} durationInFrames={SCENES.MEMORY_SYSTEMS.duration}>
        <MemorySystems />
      </Sequence>

      {/* Scene 7: Auto-Learning */}
      <Sequence from={SCENES.AUTO_LEARNING.start} durationInFrames={SCENES.AUTO_LEARNING.duration}>
        <AutoLearning />
      </Sequence>
    </AbsoluteFill>
  );
};
