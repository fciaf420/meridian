import React from 'react';
import {AbsoluteFill, useCurrentFrame, useVideoConfig, spring, interpolate} from 'remotion';
import {COLORS, FONTS, GLOW, SPRING_CONFIGS} from '../styles/theme';
import {FPS} from '../utils/timing';
import {GlowingText} from '../components/GlowingText';
import {NeonBox} from '../components/NeonBox';
import {FlowArrow} from '../components/FlowArrow';

/* ------------------------------------------------------------------ */
/*  Orbiting labels for the vector sphere                              */
/* ------------------------------------------------------------------ */

const ORBIT_LABELS = ['pools', 'strategies', 'lessons', 'patterns'];
const ORBIT_RADIUS = 70;

const VectorSphere: React.FC<{frame: number; fps: number; delay: number}> = ({
  frame,
  fps,
  delay,
}) => {
  const progress = spring({
    frame: Math.max(0, frame - delay),
    fps,
    config: SPRING_CONFIGS.gentle,
  });

  const sphereOpacity = interpolate(progress, [0, 1], [0, 1]);

  // Glow pulse
  const pulse = frame > delay ? Math.sin((frame - delay) * 0.06) * 0.3 + 0.7 : 0;

  return (
    <div
      style={{
        position: 'relative',
        width: 200,
        height: 160,
        opacity: sphereOpacity,
        flexShrink: 0,
      }}
    >
      {/* Central glowing sphere */}
      <div
        style={{
          position: 'absolute',
          left: 100 - 30,
          top: 80 - 30,
          width: 60,
          height: 60,
          borderRadius: '50%',
          background: `radial-gradient(circle at 40% 35%, ${COLORS.purple}, ${COLORS.purple}44 70%, transparent)`,
          boxShadow: GLOW.purple(0.6 * pulse),
        }}
      />

      {/* Orbiting labels */}
      {ORBIT_LABELS.map((label, i) => {
        const baseAngle = (i / ORBIT_LABELS.length) * Math.PI * 2;
        // Slow rotation: ~1 revolution per 300 frames
        const angle = baseAngle + ((frame - delay) * 0.021);
        const lx = 100 + Math.cos(angle) * ORBIT_RADIUS;
        const ly = 80 + Math.sin(angle) * ORBIT_RADIUS * 0.6; // elliptical

        return (
          <div
            key={label}
            style={{
              position: 'absolute',
              left: lx,
              top: ly,
              transform: 'translate(-50%, -50%)',
              fontFamily: FONTS.mono,
              fontSize: 13,
              color: COLORS.purple,
              whiteSpace: 'nowrap',
              opacity: 0.8,
              textShadow: GLOW.text(COLORS.purple, 0.3),
            }}
          >
            {label}
          </div>
        );
      })}
    </div>
  );
};

/* ------------------------------------------------------------------ */
/*  Tag component for lessons layer                                    */
/* ------------------------------------------------------------------ */

const LessonTag: React.FC<{
  text: string;
  color: string;
  delay: number;
  frame: number;
  fps: number;
}> = ({text, color, delay, frame, fps}) => {
  const progress = spring({
    frame: Math.max(0, frame - delay),
    fps,
    config: SPRING_CONFIGS.snappy,
  });

  const opacity = interpolate(progress, [0, 1], [0, 1]);
  const translateX = interpolate(progress, [0, 1], [20, 0]);

  return (
    <div
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        padding: '8px 16px',
        borderRadius: 8,
        border: `1px solid ${color}66`,
        backgroundColor: color + '15',
        opacity,
        transform: `translateX(${translateX}px)`,
        marginRight: 16,
      }}
    >
      {/* Dot */}
      <div
        style={{
          width: 8,
          height: 8,
          borderRadius: '50%',
          backgroundColor: color,
          marginRight: 10,
          flexShrink: 0,
        }}
      />
      <span
        style={{
          fontFamily: FONTS.body,
          fontSize: 15,
          color: COLORS.white,
        }}
      >
        {text}
      </span>
    </div>
  );
};

/* ------------------------------------------------------------------ */
/*  Main scene                                                         */
/* ------------------------------------------------------------------ */

export const MemorySystems: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();

  /* --- Title --- */
  const titleOpacity = interpolate(frame, [0, 20], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  /* --- Layer entrances --- */
  const nuggetsProgress = spring({
    frame: Math.max(0, frame - 40),
    fps,
    config: SPRING_CONFIGS.gentle,
  });
  const nuggetsOpacity = interpolate(nuggetsProgress, [0, 1], [0, 1]);
  const nuggetsY = interpolate(nuggetsProgress, [0, 1], [30, 0]);

  const poolProgress = spring({
    frame: Math.max(0, frame - 120),
    fps,
    config: SPRING_CONFIGS.gentle,
  });
  const poolOpacity = interpolate(poolProgress, [0, 1], [0, 1]);
  const poolY = interpolate(poolProgress, [0, 1], [30, 0]);

  const lessonsProgress = spring({
    frame: Math.max(0, frame - 200),
    fps,
    config: SPRING_CONFIGS.gentle,
  });
  const lessonsOpacity = interpolate(lessonsProgress, [0, 1], [0, 1]);
  const lessonsY = interpolate(lessonsProgress, [0, 1], [30, 0]);

  /* --- Promotion arrow entrance --- */
  const arrowProgress = spring({
    frame: Math.max(0, frame - 350),
    fps,
    config: SPRING_CONFIGS.gentle,
  });
  const arrowOpacity = interpolate(arrowProgress, [0, 1], [0, 1]);

  /* --- Gentle pulsing phase (500-660) --- */
  const pulsePhase = frame > 500 ? Math.sin((frame - 500) * 0.05) * 0.05 + 1.0 : 1.0;

  // Layout constants
  const boxLeft = 260;
  const boxWidth = 1400;

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
        <GlowingText text="MEMORY SYSTEMS" fontSize={40} />
      </div>

      {/* ============ TOP LAYER: Nuggets / Holographic Memory ============ */}
      <div
        style={{
          position: 'absolute',
          left: boxLeft,
          top: 140,
          opacity: nuggetsOpacity,
          transform: `translateY(${nuggetsY}px) scale(${pulsePhase})`,
        }}
      >
        <NeonBox color={COLORS.purple} width={boxWidth} height={180} padding={20}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              width: '100%',
              height: '100%',
              gap: 40,
            }}
          >
            {/* Left: vector sphere */}
            <VectorSphere frame={frame} fps={fps} delay={40} />

            {/* Right: text description */}
            <div style={{flex: 1}}>
              <div
                style={{
                  fontFamily: FONTS.heading,
                  fontSize: 24,
                  fontWeight: 700,
                  color: COLORS.white,
                  marginBottom: 8,
                }}
              >
                Holographic Memory (HRR)
              </div>
              <div
                style={{
                  fontFamily: FONTS.body,
                  fontSize: 18,
                  color: COLORS.gray,
                }}
              >
                Fuzzy recall via vector superposition
              </div>
            </div>
          </div>
        </NeonBox>
      </div>

      {/* ============ MIDDLE LAYER: Pool Memory ============ */}
      <div
        style={{
          position: 'absolute',
          left: boxLeft,
          top: 360,
          opacity: poolOpacity,
          transform: `translateY(${poolY}px) scale(${pulsePhase})`,
        }}
      >
        <NeonBox color={COLORS.blue} width={boxWidth} height={140} padding={20}>
          <div style={{width: '100%'}}>
            {/* Header row */}
            <div
              style={{
                display: 'flex',
                gap: 60,
                fontFamily: FONTS.mono,
                fontSize: 16,
                color: COLORS.gray,
                marginBottom: 14,
                paddingBottom: 10,
                borderBottom: `1px solid ${COLORS.darkGray}`,
              }}
            >
              <span style={{width: 160}}>Pool</span>
              <span style={{width: 100}}>Deploys</span>
              <span style={{width: 120}}>Avg PnL</span>
              <span style={{width: 120}}>Win Rate</span>
            </div>
            {/* Data row */}
            <div
              style={{
                display: 'flex',
                gap: 60,
                fontFamily: FONTS.mono,
                fontSize: 18,
                color: COLORS.white,
              }}
            >
              <span style={{width: 160}}>BONK-SOL</span>
              <span style={{width: 100}}>12</span>
              <span style={{width: 120, color: COLORS.green}}>+2.4%</span>
              <span style={{width: 120, color: COLORS.green}}>75%</span>
            </div>
          </div>
        </NeonBox>
      </div>

      {/* ============ BOTTOM LAYER: Lessons ============ */}
      <div
        style={{
          position: 'absolute',
          left: boxLeft,
          top: 540,
          opacity: lessonsOpacity,
          transform: `translateY(${lessonsY}px) scale(${pulsePhase})`,
        }}
      >
        <NeonBox color={COLORS.green} width={boxWidth} height={140} padding={20}>
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              justifyContent: 'center',
              gap: 12,
              width: '100%',
              height: '100%',
            }}
          >
            <LessonTag
              text="PREFER: high organic + smart wallets = +3.2%"
              color={COLORS.green}
              delay={220}
              frame={frame}
              fps={fps}
            />
            <LessonTag
              text="AVOID: vol > 6 + bid_ask = OOR downside"
              color={COLORS.amber}
              delay={260}
              frame={frame}
              fps={fps}
            />
          </div>
        </NeonBox>
      </div>

      {/* ============ PROMOTION ARROW ============ */}
      <div style={{opacity: arrowOpacity}}>
        {/* Upward arrow from bottom layer to top layer */}
        <FlowArrow
          fromX={220}
          fromY={680}
          toX={220}
          toY={200}
          color={COLORS.green}
          delay={350}
          duration={60}
        />
      </div>

      {/* Arrow label */}
      <div
        style={{
          position: 'absolute',
          left: 80,
          top: 420,
          opacity: arrowOpacity,
          transform: `translateX(${interpolate(arrowProgress, [0, 1], [-20, 0])}px)`,
        }}
      >
        <div
          style={{
            fontFamily: FONTS.body,
            fontSize: 18,
            color: COLORS.green,
            textShadow: GLOW.text(COLORS.green, 0.3),
            writingMode: 'vertical-rl' as const,
            textOrientation: 'mixed' as const,
            transform: 'rotate(180deg)',
            whiteSpace: 'nowrap',
          }}
        >
          {'3+ recalls → permanent context'}
        </div>
      </div>
    </AbsoluteFill>
  );
};
