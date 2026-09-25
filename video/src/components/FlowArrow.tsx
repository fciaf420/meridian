import React from 'react';
import {useCurrentFrame, interpolate} from 'remotion';
import {COLORS} from '../styles/theme';

interface FlowArrowProps {
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  color?: string;
  delay?: number;
  duration?: number;
}

export const FlowArrow: React.FC<FlowArrowProps> = ({
  fromX,
  fromY,
  toX,
  toY,
  color = COLORS.purple,
  delay = 0,
  duration = 30,
}) => {
  const frame = useCurrentFrame();

  const dx = toX - fromX;
  const dy = toY - fromY;
  const length = Math.sqrt(dx * dx + dy * dy);

  // Drawing progress 0 -> 1
  const progress = interpolate(frame - delay, [0, duration], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  const dashOffset = length * (1 - progress);

  // Unique filter id to avoid clashes when multiple FlowArrows render
  const filterId = `glow-arrow-${fromX}-${fromY}-${toX}-${toY}`;
  const markerId = `arrowhead-${fromX}-${fromY}-${toX}-${toY}`;

  return (
    <svg
      width={1920}
      height={1080}
      style={{position: 'absolute', top: 0, left: 0, pointerEvents: 'none'}}
    >
      <defs>
        <filter id={filterId} x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur in="SourceGraphic" stdDeviation={3} result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
        <marker
          id={markerId}
          markerWidth={10}
          markerHeight={8}
          refX={9}
          refY={4}
          orient="auto"
          markerUnits="userSpaceOnUse"
        >
          <polygon points="0 0, 10 4, 0 8" fill={color} />
        </marker>
      </defs>

      <line
        x1={fromX}
        y1={fromY}
        x2={toX}
        y2={toY}
        stroke={color}
        strokeWidth={2}
        strokeDasharray={length}
        strokeDashoffset={dashOffset}
        filter={`url(#${filterId})`}
        markerEnd={progress > 0.95 ? `url(#${markerId})` : undefined}
        opacity={progress > 0 ? 1 : 0}
      />
    </svg>
  );
};
