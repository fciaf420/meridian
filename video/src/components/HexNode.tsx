import React from 'react';
import {useCurrentFrame, useVideoConfig, spring, interpolate} from 'remotion';
import {COLORS, FONTS, GLOW, SPRING_CONFIGS} from '../styles/theme';

interface HexNodeProps {
  label: string;
  sublabel?: string;
  color?: string;
  delay?: number;
  size?: number;
  icon?: string;
}

/**
 * Generates pointy-top hexagon points centered at (cx, cy) with given radius.
 * Pointy-top means the first vertex is at the top.
 */
function hexPoints(cx: number, cy: number, radius: number): string {
  const points: string[] = [];
  for (let i = 0; i < 6; i++) {
    const angleDeg = 60 * i - 90; // start from top
    const angleRad = (Math.PI / 180) * angleDeg;
    const px = cx + radius * Math.cos(angleRad);
    const py = cy + radius * Math.sin(angleRad);
    points.push(`${px},${py}`);
  }
  return points.join(' ');
}

function getGlowFn(color: string): (opacity?: number) => string {
  if (color === COLORS.green) return GLOW.green;
  if (color === COLORS.blue) return GLOW.blue;
  if (color === COLORS.amber) return GLOW.amber;
  if (color === COLORS.red) return GLOW.red;
  return GLOW.purple;
}

export const HexNode: React.FC<HexNodeProps> = ({
  label,
  sublabel,
  color = COLORS.purple,
  delay = 0,
  size = 100,
  icon,
}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();

  const delayedFrame = Math.max(0, frame - delay);

  const entranceProgress = spring({
    frame: delayedFrame,
    fps,
    config: SPRING_CONFIGS.bouncy,
  });

  const scale = interpolate(entranceProgress, [0, 1], [0, 1]);
  const opacity = entranceProgress;

  const cx = size;
  const cy = size;
  const hexRadius = size * 0.85;

  const glowFn = getGlowFn(color);

  // Pulsing glow after entrance
  const glowPulse =
    frame > delay ? Math.sin((frame - delay) * 0.08) * 0.2 + 0.8 : 0;

  const svgWidth = size * 2;
  const svgHeight = size * 2;

  // Extract just the first shadow value for CSS drop-shadow filter
  // glowFn returns "0 0 15px rgba(...), 0 0 30px rgba(...)"
  // drop-shadow only accepts a single shadow
  const dropShadowValue = glowFn(0.4 * glowPulse).split(',')[0];

  return (
    <div
      style={{
        display: 'inline-flex',
        flexDirection: 'column',
        alignItems: 'center',
        transform: `scale(${scale})`,
        opacity,
        width: svgWidth,
      }}
    >
      <div
        style={{
          filter: `drop-shadow(${dropShadowValue})`,
        }}
      >
        <svg
          width={svgWidth}
          height={svgHeight}
          viewBox={`0 0 ${svgWidth} ${svgHeight}`}
        >
          <polygon
            points={hexPoints(cx, cy, hexRadius)}
            fill={COLORS.bgCard}
            stroke={color}
            strokeWidth={2}
          />
          {icon && (
            <text
              x={cx}
              y={cy + 2}
              textAnchor="middle"
              dominantBaseline="central"
              fontSize={32}
              fill={COLORS.white}
            >
              {icon}
            </text>
          )}
        </svg>
      </div>

      {/* Label below hexagon */}
      <div
        style={{
          marginTop: 12,
          fontFamily: FONTS.heading,
          fontSize: 20,
          fontWeight: 600,
          color: COLORS.white,
          textAlign: 'center',
          whiteSpace: 'nowrap',
        }}
      >
        {label}
      </div>

      {sublabel && (
        <div
          style={{
            marginTop: 4,
            fontFamily: FONTS.body,
            fontSize: 16,
            color: COLORS.gray,
            textAlign: 'center',
            whiteSpace: 'nowrap',
          }}
        >
          {sublabel}
        </div>
      )}
    </div>
  );
};
