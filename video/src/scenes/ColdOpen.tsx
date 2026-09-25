import React from 'react';
import {useCurrentFrame, useVideoConfig, spring, interpolate} from 'remotion';
import {COLORS, FONTS, GLOW} from '../styles/theme';
import {GlowingText} from '../components/GlowingText';
import {ParticleField} from '../components/ParticleField';

export const ColdOpen: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();

  // --- Green dot ---
  // Appears at frame 30, pulses briefly, then rapidly scales up
  const dotVisible = frame >= 30;
  const dotFrame = Math.max(0, frame - 30);

  // Spring-driven scale: 20px -> 3000px
  const dotSpring = spring({
    frame: dotFrame,
    fps,
    config: {damping: 14, stiffness: 60, mass: 0.8},
  });

  const dotScale = interpolate(dotSpring, [0, 1], [20, 3000]);

  // Pulse effect before expansion (frames 30-60)
  const dotPulse =
    frame >= 30 && frame < 60
      ? 1 + Math.sin((frame - 30) * 0.4) * 0.15
      : 1;

  // Dot opacity: fade out once it fills screen (past frame ~70)
  const dotOpacity = interpolate(frame, [60, 90], [1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  // --- Background transition ---
  // Starts pure black, transitions to COLORS.bg with radial gradient
  const bgTransition = interpolate(frame, [60, 100], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  // --- Title "MERIDIAN" ---
  // Spring entrance starting at frame 90
  const titleDelay = 90;

  // --- Tagline ---
  const taglineDelay = 140;

  // --- Fade out at end ---
  const endFade = interpolate(frame, [250, 300], [1, 0.8], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  // Particle field fades in with background
  const particleOpacity = interpolate(frame, [80, 120], [0, 0.4], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  return (
    <div
      style={{
        position: 'absolute',
        width: 1920,
        height: 1080,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexDirection: 'column',
        opacity: endFade,
        overflow: 'hidden',
        background: frame < 30
          ? '#000000'
          : `radial-gradient(ellipse at center, ${COLORS.purple}15 0%, ${COLORS.bg} 70%)`,
        backgroundColor: bgTransition > 0.5 ? COLORS.bg : '#000000',
      }}
    >
      {/* Background gradient overlay */}
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          width: 1920,
          height: 1080,
          background: `radial-gradient(ellipse at center, ${COLORS.purple}18 0%, ${COLORS.green}08 30%, ${COLORS.bg} 70%)`,
          opacity: bgTransition,
        }}
      />

      {/* Particle field */}
      <ParticleField opacity={particleOpacity} />

      {/* Green dot */}
      {dotVisible && (
        <div
          style={{
            position: 'absolute',
            left: 960 - (dotScale * dotPulse) / 2,
            top: 540 - (dotScale * dotPulse) / 2,
            width: dotScale * dotPulse,
            height: dotScale * dotPulse,
            borderRadius: '50%',
            background: `radial-gradient(circle, ${COLORS.green} 0%, ${COLORS.purple}80 60%, transparent 100%)`,
            boxShadow: GLOW.green(0.6),
            opacity: dotOpacity,
            pointerEvents: 'none' as const,
          }}
        />
      )}

      {/* Title: MERIDIAN */}
      <div
        style={{
          position: 'relative',
          zIndex: 2,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 16,
        }}
      >
        <GlowingText
          text="MERIDIAN"
          color={COLORS.purple}
          fontSize={72}
          delay={titleDelay}
          fontFamily={FONTS.heading}
        />

        {/* Tagline */}
        <GlowingText
          text="Autonomous Liquidity. Evolved."
          color={COLORS.gray}
          fontSize={32}
          delay={taglineDelay}
          fontFamily={FONTS.body}
        />
      </div>
    </div>
  );
};
