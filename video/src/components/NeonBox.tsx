import React from 'react';
import {useCurrentFrame, useVideoConfig, spring, interpolate} from 'remotion';
import {COLORS, GLOW, SPRING_CONFIGS} from '../styles/theme';

interface NeonBoxProps {
  children: React.ReactNode;
  color?: string;
  delay?: number;
  width?: number;
  height?: number;
  padding?: number;
}

/** Map a hex color to the matching GLOW function key, fallback to purple. */
function getGlowFn(color: string): (opacity?: number) => string {
  if (color === COLORS.green) return GLOW.green;
  if (color === COLORS.blue) return GLOW.blue;
  if (color === COLORS.amber) return GLOW.amber;
  if (color === COLORS.red) return GLOW.red;
  return GLOW.purple;
}

export const NeonBox: React.FC<NeonBoxProps> = ({
  children,
  color = COLORS.purple,
  delay = 0,
  width,
  height,
  padding = 24,
}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();

  const delayedFrame = Math.max(0, frame - delay);

  const entranceProgress = spring({
    frame: delayedFrame,
    fps,
    config: SPRING_CONFIGS.gentle,
  });

  const scale = interpolate(entranceProgress, [0, 1], [0.95, 1]);
  const opacity = interpolate(entranceProgress, [0, 1], [0, 1]);

  // Pulsing glow
  const glowPulse =
    frame > delay
      ? Math.sin((frame - delay) * 0.08) * 0.3 + 0.7
      : 0;

  const glowFn = getGlowFn(color);
  const boxShadow = glowFn(0.35 * glowPulse);

  // Border color at 60% opacity
  const borderColor = color + '99'; // 99 hex ~ 60%

  return (
    <div
      style={{
        display: 'inline-flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        transform: `scale(${scale})`,
        opacity,
        background: COLORS.bgCard,
        borderRadius: 12,
        border: `1px solid ${borderColor}`,
        boxShadow,
        padding,
        ...(width != null ? {width} : {}),
        ...(height != null ? {height} : {}),
        boxSizing: 'border-box' as const,
      }}
    >
      {children}
    </div>
  );
};
