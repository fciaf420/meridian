import React from 'react';
import {useCurrentFrame, interpolate} from 'remotion';
import {COLORS, FONTS} from '../styles/theme';
import {STAGGER_DELAY} from '../utils/timing';
import {NeonBox} from './NeonBox';

interface LoopNode {
  label: string;
  sublabel?: string;
}

interface LoopDiagramProps {
  nodes: LoopNode[];
  activeIndex?: number;
  delay?: number;
  radius?: number;
}

/**
 * Positions 4 nodes: top, right, bottom, left around a center.
 */
function getNodePosition(
  index: number,
  radius: number,
  centerX: number,
  centerY: number
): {x: number; y: number} {
  // top=0, right=1, bottom=2, left=3
  const angles = [-Math.PI / 2, 0, Math.PI / 2, Math.PI];
  const angle = angles[index % 4];
  return {
    x: centerX + Math.cos(angle) * radius,
    y: centerY + Math.sin(angle) * radius,
  };
}

/**
 * Quadratic bezier control point for a clockwise curve between two node positions.
 */
function getBezierControl(
  from: {x: number; y: number},
  to: {x: number; y: number},
  centerX: number,
  centerY: number
): {x: number; y: number} {
  // Midpoint between from and to, pushed outward from center
  const midX = (from.x + to.x) / 2;
  const midY = (from.y + to.y) / 2;
  const dx = midX - centerX;
  const dy = midY - centerY;
  const dist = Math.sqrt(dx * dx + dy * dy);
  const pushFactor = 0.3;
  return {
    x: midX + (dx / dist) * dist * pushFactor,
    y: midY + (dy / dist) * dist * pushFactor,
  };
}

/**
 * Approximate quadratic bezier arc length for dasharray.
 */
function approxBezierLength(
  from: {x: number; y: number},
  ctrl: {x: number; y: number},
  to: {x: number; y: number}
): number {
  // Approximate with 10 segments
  let length = 0;
  let prevX = from.x;
  let prevY = from.y;
  for (let t = 0.1; t <= 1.0; t += 0.1) {
    const x =
      (1 - t) * (1 - t) * from.x + 2 * (1 - t) * t * ctrl.x + t * t * to.x;
    const y =
      (1 - t) * (1 - t) * from.y + 2 * (1 - t) * t * ctrl.y + t * t * to.y;
    length += Math.sqrt((x - prevX) ** 2 + (y - prevY) ** 2);
    prevX = x;
    prevY = y;
  }
  return length;
}

const NODE_WIDTH = 160;
const NODE_HEIGHT = 70;
const ARROW_DRAW_DURATION = 20; // frames to draw each arrow

export const LoopDiagram: React.FC<LoopDiagramProps> = ({
  nodes,
  activeIndex = -1,
  delay = 0,
  radius = 250,
}) => {
  const frame = useCurrentFrame();

  const centerX = 480; // relative center within the diagram
  const centerY = 300;

  // If activeIndex is -1, auto-cycle through nodes (each 60 frames)
  const effectiveActiveIndex =
    activeIndex >= 0
      ? activeIndex
      : frame > delay
        ? Math.floor(((frame - delay) % (nodes.length * 60)) / 60)
        : -1;

  const nodePositions = nodes.map((_, i) =>
    getNodePosition(i, radius, centerX, centerY)
  );

  // Build arrow paths: node i -> node (i+1) % n
  const arrows = nodes.map((_, i) => {
    const fromPos = nodePositions[i];
    const toPos = nodePositions[(i + 1) % nodes.length];
    const ctrl = getBezierControl(fromPos, toPos, centerX, centerY);
    const pathD = `M ${fromPos.x} ${fromPos.y} Q ${ctrl.x} ${ctrl.y} ${toPos.x} ${toPos.y}`;
    const pathLength = approxBezierLength(fromPos, ctrl, toPos);
    return {pathD, pathLength};
  });

  const diagramWidth = centerX * 2;
  const diagramHeight = centerY * 2;

  return (
    <div style={{position: 'relative', width: diagramWidth, height: diagramHeight}}>
      {/* SVG arrows layer */}
      <svg
        width={diagramWidth}
        height={diagramHeight}
        style={{position: 'absolute', top: 0, left: 0, pointerEvents: 'none'}}
      >
        <defs>
          <filter id="loop-arrow-glow" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur in="SourceGraphic" stdDeviation={2} result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
          <marker
            id="loop-arrowhead"
            markerWidth={8}
            markerHeight={6}
            refX={7}
            refY={3}
            orient="auto"
            markerUnits="userSpaceOnUse"
          >
            <polygon points="0 0, 8 3, 0 6" fill={COLORS.purple} />
          </marker>
        </defs>

        {arrows.map((arrow, i) => {
          const arrowDelay =
            delay + nodes.length * STAGGER_DELAY + i * ARROW_DRAW_DURATION;
          const progress = interpolate(
            frame - arrowDelay,
            [0, ARROW_DRAW_DURATION],
            [0, 1],
            {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'}
          );

          return (
            <path
              key={`arrow-${i}`}
              d={arrow.pathD}
              fill="none"
              stroke={COLORS.purple}
              strokeWidth={2}
              strokeDasharray={arrow.pathLength}
              strokeDashoffset={arrow.pathLength * (1 - progress)}
              filter="url(#loop-arrow-glow)"
              markerEnd={progress > 0.9 ? 'url(#loop-arrowhead)' : undefined}
              opacity={progress > 0 ? 0.7 : 0}
            />
          );
        })}
      </svg>

      {/* Node boxes */}
      {nodes.map((node, i) => {
        const pos = nodePositions[i];
        const nodeDelay = delay + i * STAGGER_DELAY;
        const isActive = i === effectiveActiveIndex;

        return (
          <div
            key={i}
            style={{
              position: 'absolute',
              left: pos.x - NODE_WIDTH / 2,
              top: pos.y - NODE_HEIGHT / 2,
              transform: isActive ? 'scale(1.08)' : 'scale(1)',
              transition: 'transform 0.3s ease',
            }}
          >
            <NeonBox
              color={isActive ? COLORS.green : COLORS.purple}
              delay={nodeDelay}
              width={NODE_WIDTH}
              height={NODE_HEIGHT}
              padding={12}
            >
              <div
                style={{
                  fontFamily: FONTS.heading,
                  fontSize: 16,
                  fontWeight: 600,
                  color: COLORS.white,
                  textAlign: 'center',
                }}
              >
                {node.label}
              </div>
              {node.sublabel && (
                <div
                  style={{
                    fontFamily: FONTS.body,
                    fontSize: 12,
                    color: COLORS.gray,
                    textAlign: 'center',
                    marginTop: 4,
                  }}
                >
                  {node.sublabel}
                </div>
              )}
            </NeonBox>
          </div>
        );
      })}
    </div>
  );
};
