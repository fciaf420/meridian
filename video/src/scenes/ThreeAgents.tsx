import React from 'react';
import {useCurrentFrame, interpolate} from 'remotion';
import {COLORS} from '../styles/theme';
import {GlowingText} from '../components/GlowingText';
import {HexNode} from '../components/HexNode';
import {FlowArrow} from '../components/FlowArrow';
import {ParticleField} from '../components/ParticleField';

// Layout coordinates
const CENTRAL = {x: 960, y: 340};
const SCREENER = {x: 360, y: 600};
const MANAGER = {x: 1560, y: 600};
const GENERAL = {x: 960, y: 780};

// HexNode renders with inline-flex, so we position via wrapper divs.
// The HexNode component's rendered width = size * 2, center at size.
const CENTRAL_SIZE = 100;
const AGENT_SIZE = 80;

export const ThreeAgents: React.FC = () => {
  const frame = useCurrentFrame();

  // Scene title fade in
  const titleOpacity = interpolate(frame, [0, 60], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  // Pulsing glow on all elements after frame 300
  const pulsePhase = frame > 300 ? Math.sin((frame - 300) * 0.04) * 0.1 + 0.9 : 1;

  return (
    <div
      style={{
        position: 'absolute',
        width: 1920,
        height: 1080,
        background: COLORS.bg,
        overflow: 'hidden',
      }}
    >
      <ParticleField opacity={0.3} />

      {/* Scene title */}
      <div
        style={{
          position: 'absolute',
          top: 60,
          width: 1920,
          textAlign: 'center',
          opacity: titleOpacity,
        }}
      >
        <GlowingText
          text="THE ARCHITECTURE"
          color={COLORS.gray}
          fontSize={40}
          delay={0}
        />
      </div>

      {/* Central node: ReAct Loop */}
      <div
        style={{
          position: 'absolute',
          left: CENTRAL.x - CENTRAL_SIZE,
          top: CENTRAL.y - CENTRAL_SIZE - 20,
          opacity: pulsePhase,
        }}
      >
        <HexNode
          label="ReAct Loop"
          sublabel="LLM Engine"
          color={COLORS.purple}
          delay={30}
          size={CENTRAL_SIZE}
        />
      </div>

      {/* SCREENER agent */}
      <div
        style={{
          position: 'absolute',
          left: SCREENER.x - AGENT_SIZE,
          top: SCREENER.y - AGENT_SIZE - 20,
          opacity: pulsePhase,
        }}
      >
        <HexNode
          label="SCREENER"
          sublabel="every 30 min"
          icon={'\uD83D\uDD0D'}
          color={COLORS.green}
          delay={60}
          size={AGENT_SIZE}
        />
      </div>

      {/* MANAGER agent */}
      <div
        style={{
          position: 'absolute',
          left: MANAGER.x - AGENT_SIZE,
          top: MANAGER.y - AGENT_SIZE - 20,
          opacity: pulsePhase,
        }}
      >
        <HexNode
          label="MANAGER"
          sublabel="every 3-10 min"
          icon={'\uD83D\uDEE1\uFE0F'}
          color={COLORS.blue}
          delay={90}
          size={AGENT_SIZE}
        />
      </div>

      {/* GENERAL agent */}
      <div
        style={{
          position: 'absolute',
          left: GENERAL.x - AGENT_SIZE,
          top: GENERAL.y - AGENT_SIZE - 20,
          opacity: pulsePhase,
        }}
      >
        <HexNode
          label="GENERAL"
          sublabel="on demand"
          icon={'\uD83D\uDCAC'}
          color={COLORS.purple}
          delay={120}
          size={AGENT_SIZE}
        />
      </div>

      {/* Flow arrows from each agent to central node */}
      <FlowArrow
        fromX={SCREENER.x + 60}
        fromY={SCREENER.y - 30}
        toX={CENTRAL.x - 60}
        toY={CENTRAL.y + 40}
        color={COLORS.green}
        delay={150}
        duration={40}
      />
      <FlowArrow
        fromX={MANAGER.x - 60}
        fromY={MANAGER.y - 30}
        toX={CENTRAL.x + 60}
        toY={CENTRAL.y + 40}
        color={COLORS.blue}
        delay={170}
        duration={40}
      />
      <FlowArrow
        fromX={GENERAL.x}
        fromY={GENERAL.y - 60}
        toX={CENTRAL.x}
        toY={CENTRAL.y + 80}
        color={COLORS.purple}
        delay={190}
        duration={40}
      />

      {/* Subtle dashed connections between agents */}
      <svg
        width={1920}
        height={1080}
        style={{position: 'absolute', top: 0, left: 0, pointerEvents: 'none'}}
      >
        {frame > 200 && (
          <>
            <line
              x1={SCREENER.x + 80}
              y1={SCREENER.y}
              x2={GENERAL.x - 40}
              y2={GENERAL.y - 20}
              stroke={COLORS.darkGray}
              strokeWidth={1}
              strokeDasharray="4 6"
              opacity={0.3 * pulsePhase}
            />
            <line
              x1={MANAGER.x - 80}
              y1={MANAGER.y}
              x2={GENERAL.x + 40}
              y2={GENERAL.y - 20}
              stroke={COLORS.darkGray}
              strokeWidth={1}
              strokeDasharray="4 6"
              opacity={0.3 * pulsePhase}
            />
          </>
        )}
      </svg>
    </div>
  );
};
