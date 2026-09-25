import React from 'react';
import {useCurrentFrame, useVideoConfig, spring, interpolate} from 'remotion';
import {COLORS, FONTS, GLOW, SPRING_CONFIGS} from '../styles/theme';

interface GlowingTextProps {
  text: string;
  color?: string;
  fontSize?: number;
  delay?: number;
  fontFamily?: string;
}

export const GlowingText: React.FC<GlowingTextProps> = ({
  text,
  color = COLORS.purple,
  fontSize = 48,
  delay = 0,
  fontFamily,
}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();

  const delayedFrame = Math.max(0, frame - delay);

  // Spring entrance: scale 0.9 -> 1.0 and opacity 0 -> 1
  const entranceProgress = spring({
    frame: delayedFrame,
    fps,
    config: SPRING_CONFIGS.gentle,
  });

  const scale = interpolate(entranceProgress, [0, 1], [0.9, 1]);
  const opacity = interpolate(entranceProgress, [0, 1], [0, 1]);

  // Pulsing glow using sin wave
  const glowPulse =
    frame > delay
      ? Math.sin((frame - delay) * 0.08) * 0.3 + 0.7
      : 0;

  const textShadow = GLOW.text(color, 0.6 * glowPulse);

  return (
    <div
      style={{
        display: 'inline-block',
        transform: `scale(${scale})`,
        opacity,
        fontFamily: fontFamily || FONTS.heading,
        fontSize,
        fontWeight: 700,
        color: COLORS.white,
        textShadow,
        whiteSpace: 'pre-wrap',
      }}
    >
      {text}
    </div>
  );
};
