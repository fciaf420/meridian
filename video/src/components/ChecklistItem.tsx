import React from 'react';
import {useCurrentFrame, useVideoConfig, spring, interpolate} from 'remotion';
import {COLORS, FONTS, SPRING_CONFIGS} from '../styles/theme';

interface ChecklistItemProps {
  text: string;
  delay?: number;
  color?: string;
  index?: number;
}

export const ChecklistItem: React.FC<ChecklistItemProps> = ({
  text,
  delay = 0,
  color = COLORS.green,
  index: _index = 0,
}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();

  const isActivated = frame >= delay;
  const delayedFrame = Math.max(0, frame - delay);

  // Spring for the circle fill animation
  const activationProgress = spring({
    frame: delayedFrame,
    fps,
    config: SPRING_CONFIGS.bouncy,
  });

  // Flash effect: bright for a brief moment then settle
  const flashIntensity = isActivated
    ? interpolate(delayedFrame, [0, 5, 15], [0, 1, 0], {
        extrapolateRight: 'clamp',
        extrapolateLeft: 'clamp',
      })
    : 0;

  // Circle scale: pops on activation
  const circleScale = isActivated
    ? interpolate(activationProgress, [0, 1], [0.5, 1])
    : 1;

  // Text color transition
  const textColor = isActivated ? COLORS.white : COLORS.gray;

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 16,
        height: 36,
      }}
    >
      {/* Circle indicator */}
      <div
        style={{
          width: 16,
          height: 16,
          borderRadius: '50%',
          flexShrink: 0,
          transform: `scale(${circleScale})`,
          backgroundColor: isActivated ? color : 'transparent',
          border: isActivated ? 'none' : `2px solid ${COLORS.darkGray}`,
          boxShadow: isActivated
            ? `0 0 ${8 + flashIntensity * 16}px ${color}${Math.round(
                (0.4 + flashIntensity * 0.6) * 255
              )
                .toString(16)
                .padStart(2, '0')}`
            : 'none',
          opacity: isActivated ? activationProgress : 0.5,
        }}
      />

      {/* Text */}
      <div
        style={{
          fontFamily: FONTS.body,
          fontSize: 22,
          color: textColor,
          opacity: isActivated
            ? interpolate(activationProgress, [0, 1], [0.5, 1])
            : 0.5,
          transform: isActivated
            ? `translateX(${interpolate(
                activationProgress,
                [0, 1],
                [8, 0]
              )}px)`
            : 'none',
        }}
      >
        {text}
      </div>
    </div>
  );
};
