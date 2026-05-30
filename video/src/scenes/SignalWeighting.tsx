import React from 'react';
import {useCurrentFrame, interpolate} from 'remotion';
import {COLORS, FONTS} from '../styles/theme';
import {GlowingText} from '../components/GlowingText';
import {NeonBox} from '../components/NeonBox';
import {BarChart} from '../components/BarChart';
import {ParticleField} from '../components/ParticleField';

// Signal weight data: all start at 1.0, animate to target
const SIGNALS = [
  {label: 'organic_score', targetValue: 1.35},
  {label: 'fee_tvl_ratio', targetValue: 1.25},
  {label: 'volume', targetValue: 0.85},
  {label: 'mcap', targetValue: 1.05},
  {label: 'holder_count', targetValue: 1.15},
  {label: 'smart_wallets', targetValue: 1.40},
  {label: 'narrative_quality', targetValue: 0.7},
  {label: 'study_win_rate', targetValue: 1.2},
  {label: 'volatility', targetValue: 0.75},
  {label: 'ath_proximity', targetValue: 1.1},
];

const BARS = SIGNALS.map((s) => ({
  label: s.label,
  value: 1.0,
  targetValue: s.targetValue,
}));

export const SignalWeighting: React.FC = () => {
  const frame = useCurrentFrame();

  // Title
  const titleOpacity = interpolate(frame, [0, 40], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  // Annotation boxes (frames 220-350)
  const annotTopRight = interpolate(frame, [220, 260], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const annotBottomRight = interpolate(frame, [260, 300], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  // Mean reversion + bounds (frames 350-450)
  const meanRevOpacity = interpolate(frame, [350, 390], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const boundsOpacity = interpolate(frame, [380, 420], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  // Bottom text (frames 450-540)
  const bottomTextOpacity = interpolate(frame, [450, 490], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  // End fade (frames 540-600)
  const endFade = interpolate(frame, [540, 600], [1, 0.7], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  // Mean reversion arrow animation
  const arrowPulse = frame > 350 ? Math.sin((frame - 350) * 0.08) * 4 : 0;

  return (
    <div
      style={{
        position: 'absolute',
        width: 1920,
        height: 1080,
        background: COLORS.bg,
        overflow: 'hidden',
        opacity: endFade,
      }}
    >
      <ParticleField opacity={0.15} />

      {/* Title */}
      <div
        style={{
          position: 'absolute',
          top: 50,
          width: 1920,
          textAlign: 'center',
          opacity: titleOpacity,
        }}
      >
        <GlowingText
          text="DARWINIAN SIGNAL WEIGHTS"
          color={COLORS.purple}
          fontSize={42}
          delay={0}
        />
      </div>

      {/* Bar chart - left-center, positioned at y=180 */}
      <div
        style={{
          position: 'absolute',
          left: 80,
          top: 180,
        }}
      >
        <BarChart bars={BARS} delay={40} width={1000} height={500} />
      </div>

      {/* RIGHT SIDE: Annotation boxes */}

      {/* Top Quartile annotation */}
      <div
        style={{
          position: 'absolute',
          right: 100,
          top: 220,
          opacity: annotTopRight,
          transform: `translateX(${interpolate(annotTopRight, [0, 1], [20, 0])}px)`,
        }}
      >
        <NeonBox color={COLORS.green} delay={220} width={340} padding={20}>
          <div style={{display: 'flex', flexDirection: 'column', gap: 6}}>
            <div
              style={{
                fontFamily: FONTS.heading,
                fontSize: 16,
                fontWeight: 700,
                color: COLORS.green,
              }}
            >
              Top Quartile
            </div>
            <div
              style={{
                fontFamily: FONTS.mono,
                fontSize: 22,
                fontWeight: 600,
                color: COLORS.white,
              }}
            >
              x1.05 boost
            </div>
            <div
              style={{
                fontFamily: FONTS.body,
                fontSize: 13,
                color: COLORS.gray,
              }}
            >
              Signals consistently predicting profit get amplified
            </div>
          </div>
        </NeonBox>
      </div>

      {/* Bottom Quartile annotation */}
      <div
        style={{
          position: 'absolute',
          right: 100,
          top: 380,
          opacity: annotBottomRight,
          transform: `translateX(${interpolate(annotBottomRight, [0, 1], [20, 0])}px)`,
        }}
      >
        <NeonBox color={COLORS.amber} delay={260} width={340} padding={20}>
          <div style={{display: 'flex', flexDirection: 'column', gap: 6}}>
            <div
              style={{
                fontFamily: FONTS.heading,
                fontSize: 16,
                fontWeight: 700,
                color: COLORS.amber,
              }}
            >
              Bottom Quartile
            </div>
            <div
              style={{
                fontFamily: FONTS.mono,
                fontSize: 22,
                fontWeight: 600,
                color: COLORS.white,
              }}
            >
              x0.95 decay
            </div>
            <div
              style={{
                fontFamily: FONTS.body,
                fontSize: 13,
                color: COLORS.gray,
              }}
            >
              Underperforming signals gradually lose influence
            </div>
          </div>
        </NeonBox>
      </div>

      {/* Mean Reversion annotation */}
      <div
        style={{
          position: 'absolute',
          right: 100,
          top: 550,
          opacity: meanRevOpacity,
          transform: `translateX(${interpolate(meanRevOpacity, [0, 1], [20, 0])}px)`,
        }}
      >
        <div style={{display: 'flex', alignItems: 'center', gap: 12}}>
          {/* Animated arrows pulling toward center */}
          <svg width={40} height={30} viewBox="0 0 40 30">
            <line
              x1={5}
              y1={15}
              x2={35}
              y2={15}
              stroke={COLORS.gray}
              strokeWidth={1.5}
              strokeDasharray="3 2"
            />
            <polygon
              points={`${20 + arrowPulse},8 ${20 + arrowPulse},22 ${12},15`}
              fill={COLORS.gray}
              opacity={0.7}
            />
            <polygon
              points={`${20 - arrowPulse},8 ${20 - arrowPulse},22 ${28},15`}
              fill={COLORS.gray}
              opacity={0.7}
            />
          </svg>
          <div>
            <div
              style={{
                fontFamily: FONTS.mono,
                fontSize: 16,
                color: COLORS.white,
              }}
            >
              Mean Reversion: 2%
            </div>
            <div
              style={{
                fontFamily: FONTS.body,
                fontSize: 12,
                color: COLORS.gray,
              }}
            >
              Weights drift back toward 1.0 each cycle
            </div>
          </div>
        </div>
      </div>

      {/* Bounds annotation */}
      <div
        style={{
          position: 'absolute',
          right: 100,
          top: 620,
          opacity: boundsOpacity,
          transform: `translateX(${interpolate(boundsOpacity, [0, 1], [20, 0])}px)`,
        }}
      >
        <div style={{display: 'flex', alignItems: 'center', gap: 12}}>
          {/* Bracket visualization */}
          <svg width={40} height={30} viewBox="0 0 40 30">
            <path
              d="M 12,4 L 6,4 L 6,26 L 12,26"
              fill="none"
              stroke={COLORS.purple}
              strokeWidth={2}
              strokeLinecap="round"
            />
            <path
              d="M 28,4 L 34,4 L 34,26 L 28,26"
              fill="none"
              stroke={COLORS.purple}
              strokeWidth={2}
              strokeLinecap="round"
            />
          </svg>
          <div>
            <div
              style={{
                fontFamily: FONTS.mono,
                fontSize: 16,
                color: COLORS.white,
              }}
            >
              Bounds: 0.3 &ndash; 2.5
            </div>
            <div
              style={{
                fontFamily: FONTS.body,
                fontSize: 12,
                color: COLORS.gray,
              }}
            >
              Hard clamp prevents runaway weights
            </div>
          </div>
        </div>
      </div>

      {/* Bottom text */}
      <div
        style={{
          position: 'absolute',
          bottom: 80,
          width: 1920,
          textAlign: 'center',
          opacity: bottomTextOpacity,
        }}
      >
        <GlowingText
          text="Recalculated every 5 closed positions"
          color={COLORS.purple}
          fontSize={24}
          delay={450}
        />
      </div>
    </div>
  );
};
