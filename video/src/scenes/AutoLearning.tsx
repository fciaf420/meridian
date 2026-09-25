import React from 'react';
import {AbsoluteFill, useCurrentFrame, useVideoConfig, spring, interpolate} from 'remotion';
import {COLORS, FONTS, GLOW, SPRING_CONFIGS} from '../styles/theme';
import {FPS} from '../utils/timing';
import {GlowingText} from '../components/GlowingText';
import {NeonBox} from '../components/NeonBox';
import {FlowArrow} from '../components/FlowArrow';

/* ------------------------------------------------------------------ */
/*  Node definitions for the circular loop                             */
/* ------------------------------------------------------------------ */

interface LoopNode {
  label: string;
  color: string;
  x: number;
  y: number;
  entranceDelay: number;
}

const CENTER_X = 960;
const CENTER_Y = 500;
const RADIUS = 250;

const NODES: LoopNode[] = [
  {label: 'Position Closes', color: COLORS.purple, x: CENTER_X, y: CENTER_Y - RADIUS, entranceDelay: 40},
  {label: 'Derive Lesson', color: COLORS.green, x: CENTER_X + RADIUS + 50, y: CENTER_Y, entranceDelay: 70},
  {label: 'Evolve Thresholds', color: COLORS.amber, x: CENTER_X, y: CENTER_Y + RADIUS, entranceDelay: 100},
  {label: 'Autoresearch', color: COLORS.blue, x: CENTER_X - RADIUS - 50, y: CENTER_Y, entranceDelay: 130},
];

const NODE_WIDTH = 220;
const NODE_HEIGHT = 80;

/* Arrow connections: from -> to (clockwise) */
const ARROWS = [
  {from: 0, to: 1, delay: 200}, // top -> right
  {from: 1, to: 2, delay: 250}, // right -> bottom
  {from: 2, to: 3, delay: 300}, // bottom -> left
  {from: 3, to: 0, delay: 350}, // left -> top
];

/* ------------------------------------------------------------------ */
/*  Progress bar component                                             */
/* ------------------------------------------------------------------ */

const ProgressBar: React.FC<{filled: number; total: number; color: string}> = ({
  filled,
  total,
  color,
}) => {
  const segmentWidth = 24;
  const gap = 4;

  return (
    <div style={{display: 'flex', gap, alignItems: 'center'}}>
      {Array.from({length: total}).map((_, i) => (
        <div
          key={i}
          style={{
            width: segmentWidth,
            height: 8,
            borderRadius: 2,
            backgroundColor: i < filled ? color : COLORS.darkGray,
          }}
        />
      ))}
    </div>
  );
};

/* ------------------------------------------------------------------ */
/*  Main scene                                                         */
/* ------------------------------------------------------------------ */

export const AutoLearning: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();

  /* --- Title --- */
  const titleOpacity = interpolate(frame, [0, 20], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  /* --- Loop activation phase (frames 400+) --- */
  // Each node stays highlighted for 60 frames, cycling through 4 nodes = 240 frame cycle
  const CYCLE_LENGTH = 240;
  const HIGHLIGHT_DURATION = 60;
  const loopActive = frame >= 400;
  const loopFrame = loopActive ? frame - 400 : 0;
  const activeNodeIndex = loopActive
    ? Math.floor((loopFrame % CYCLE_LENGTH) / HIGHLIGHT_DURATION)
    : -1;

  /* --- Annotation entrances --- */
  const thresholdAnnotationProgress = spring({
    frame: Math.max(0, frame - 300),
    fps,
    config: SPRING_CONFIGS.gentle,
  });
  const thresholdAnnotationOpacity = interpolate(thresholdAnnotationProgress, [0, 1], [0, 1]);

  const autoresearchAnnotationProgress = spring({
    frame: Math.max(0, frame - 340),
    fps,
    config: SPRING_CONFIGS.gentle,
  });
  const autoresearchAnnotationOpacity = interpolate(autoresearchAnnotationProgress, [0, 1], [0, 1]);

  /* Threshold parameter labels staggered */
  const thresholdParams = ['maxVolatility', 'minOrganic', 'stopLoss', 'takeProfit'];

  return (
    <AbsoluteFill>
      {/* Title */}
      <div
        style={{
          position: 'absolute',
          top: 40,
          left: 0,
          width: 1920,
          textAlign: 'center',
          opacity: titleOpacity,
        }}
      >
        <GlowingText text="AUTO-LEARNING" fontSize={40} />
      </div>

      {/* ============ Loop Nodes ============ */}
      {NODES.map((node, i) => {
        const nodeProgress = spring({
          frame: Math.max(0, frame - node.entranceDelay),
          fps,
          config: SPRING_CONFIGS.bouncy,
        });

        const nodeScale = interpolate(nodeProgress, [0, 1], [0, 1]);
        const nodeOpacity = interpolate(nodeProgress, [0, 1], [0, 1]);

        // Highlight effect during loop activation
        const isHighlighted = activeNodeIndex === i;
        const highlightScale = isHighlighted ? 1.05 : 1.0;
        const highlightGlow = isHighlighted ? 0.8 : 0.35;

        const glowFnMap: Record<string, (opacity?: number) => string> = {
          [COLORS.purple]: GLOW.purple,
          [COLORS.green]: GLOW.green,
          [COLORS.amber]: GLOW.amber,
          [COLORS.blue]: GLOW.blue,
        };
        const glowFn = glowFnMap[node.color] || GLOW.purple;

        return (
          <div
            key={i}
            style={{
              position: 'absolute',
              left: node.x - NODE_WIDTH / 2,
              top: node.y - NODE_HEIGHT / 2,
              width: NODE_WIDTH,
              height: NODE_HEIGHT,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              transform: `scale(${nodeScale * highlightScale})`,
              opacity: nodeOpacity,
              backgroundColor: COLORS.bgCard,
              borderRadius: 12,
              border: `1.5px solid ${node.color}${isHighlighted ? 'FF' : '99'}`,
              boxShadow: glowFn(highlightGlow),
              transition: 'box-shadow 0.1s',
              fontFamily: FONTS.heading,
              fontSize: 20,
              fontWeight: 600,
              color: COLORS.white,
            }}
          >
            {node.label}
          </div>
        );
      })}

      {/* ============ Curved Arrows between nodes ============ */}
      {ARROWS.map((arrow, i) => {
        const fromNode = NODES[arrow.from];
        const toNode = NODES[arrow.to];

        // Calculate edge points (from center of node toward the other node)
        const dx = toNode.x - fromNode.x;
        const dy = toNode.y - fromNode.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const nx = dx / dist;
        const ny = dy / dist;

        // Start from edge of source node, end at edge of target node
        const startX = fromNode.x + nx * (NODE_WIDTH / 2 + 5);
        const startY = fromNode.y + ny * (NODE_HEIGHT / 2 + 5);
        const endX = toNode.x - nx * (NODE_WIDTH / 2 + 15);
        const endY = toNode.y - ny * (NODE_HEIGHT / 2 + 15);

        // During loop activation, highlight the arrow leading TO the active node
        const arrowLeadsToActive = activeNodeIndex === arrow.to;
        const arrowOpacity = arrowLeadsToActive && loopActive ? 1.0 : 0.6;

        return (
          <div key={`arrow-${i}`} style={{opacity: arrowOpacity}}>
            <FlowArrow
              fromX={startX}
              fromY={startY}
              toX={endX}
              toY={endY}
              color={toNode.color}
              delay={arrow.delay}
              duration={40}
            />
          </div>
        );
      })}

      {/* ============ Annotations: Evolve Thresholds (right of bottom node) ============ */}
      <div
        style={{
          position: 'absolute',
          left: CENTER_X + 160,
          top: CENTER_Y + RADIUS - 20,
          opacity: thresholdAnnotationOpacity,
        }}
      >
        {/* Parameter names staggered */}
        {thresholdParams.map((param, i) => {
          const paramProgress = spring({
            frame: Math.max(0, frame - (320 + i * 12)),
            fps,
            config: SPRING_CONFIGS.snappy,
          });
          const paramOpacity = interpolate(paramProgress, [0, 1], [0, 1]);
          const paramX = interpolate(paramProgress, [0, 1], [15, 0]);

          return (
            <div
              key={param}
              style={{
                fontFamily: FONTS.mono,
                fontSize: 16,
                color: COLORS.gray,
                opacity: paramOpacity,
                transform: `translateX(${paramX}px)`,
                marginBottom: 4,
              }}
            >
              {param}
            </div>
          );
        })}

        {/* Constraint label */}
        <div
          style={{
            fontFamily: FONTS.body,
            fontSize: 18,
            fontWeight: 600,
            color: COLORS.amber,
            marginTop: 10,
            opacity: thresholdAnnotationOpacity,
            textShadow: GLOW.text(COLORS.amber, 0.3),
          }}
        >
          +/-20% max per step
        </div>
      </div>

      {/* ============ Annotations: Autoresearch (left of left node) ============ */}
      <div
        style={{
          position: 'absolute',
          left: CENTER_X - RADIUS - 50 - NODE_WIDTH / 2 - 260,
          top: CENTER_Y - 40,
          width: 240,
          opacity: autoresearchAnnotationOpacity,
        }}
      >
        {/* A/B test label */}
        <div
          style={{
            fontFamily: FONTS.body,
            fontSize: 16,
            color: COLORS.white,
            marginBottom: 8,
          }}
        >
          A/B test: 7 positions
        </div>

        {/* Progress bar 3/7 */}
        <ProgressBar filled={3} total={7} color={COLORS.blue} />

        {/* Circuit breaker */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            marginTop: 14,
            fontFamily: FONTS.body,
            fontSize: 15,
            color: COLORS.gray,
          }}
        >
          {/* Red dot */}
          <div
            style={{
              width: 8,
              height: 8,
              borderRadius: '50%',
              backgroundColor: COLORS.red,
              flexShrink: 0,
              boxShadow: GLOW.red(0.5),
            }}
          />
          <span>{'Circuit breaker: 3 losses → revert'}</span>
        </div>
      </div>
    </AbsoluteFill>
  );
};
