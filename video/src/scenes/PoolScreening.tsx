import React from 'react';
import {useCurrentFrame, interpolate} from 'remotion';
import {COLORS, FONTS, GLOW} from '../styles/theme';
import {GlowingText} from '../components/GlowingText';
import {NeonBox} from '../components/NeonBox';
import {ParticleField} from '../components/ParticleField';

// --- Funnel filter labels ---
const FILTERS = [
  {label: 'TVL $10k-$150k', frameIn: 40},
  {label: 'Organic Score > 60', frameIn: 60},
  {label: 'Holders > 500', frameIn: 80},
  {label: 'Fee/TVL > 5%', frameIn: 100},
  {label: 'Bin Step 80-125', frameIn: 120},
];

// --- Dot pool simulation ---
function seededRandom(seed: number): number {
  const x = Math.sin(seed * 9301 + 49297) * 233280;
  return x - Math.floor(x);
}

interface PoolDot {
  id: number;
  startFrame: number;
  speed: number;
  xOffset: number;
  dieAtFilter: number; // 0-4 index, or -1 = survives
  color: string;
}

const DOTS: PoolDot[] = Array.from({length: 15}, (_, i) => {
  const r1 = seededRandom(i * 5 + 1);
  const r2 = seededRandom(i * 5 + 2);
  const r3 = seededRandom(i * 5 + 3);
  const r4 = seededRandom(i * 5 + 4);
  const survives = i < 5; // first 5 survive
  return {
    id: i,
    startFrame: 30 + Math.floor(r1 * 40),
    speed: 2.5 + r2 * 2,
    xOffset: -0.4 + r3 * 0.8,
    dieAtFilter: survives ? -1 : Math.floor(r4 * 5),
    color: survives ? COLORS.green : COLORS.purple,
  };
});

// Funnel geometry
const FUNNEL_LEFT = 80;
const FUNNEL_TOP = 180;
const FUNNEL_WIDTH_TOP = 600;
const FUNNEL_WIDTH_BOTTOM = 200;
const FUNNEL_HEIGHT = 500;

export const PoolScreening: React.FC = () => {
  const frame = useCurrentFrame();

  // Scene title
  const titleOpacity = interpolate(frame, [0, 40], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  // Funnel trapezoid SVG points
  const funnelCenterX = FUNNEL_LEFT + FUNNEL_WIDTH_TOP / 2;
  const funnelPoints = [
    `${funnelCenterX - FUNNEL_WIDTH_TOP / 2},${FUNNEL_TOP}`,
    `${funnelCenterX + FUNNEL_WIDTH_TOP / 2},${FUNNEL_TOP}`,
    `${funnelCenterX + FUNNEL_WIDTH_BOTTOM / 2},${FUNNEL_TOP + FUNNEL_HEIGHT}`,
    `${funnelCenterX - FUNNEL_WIDTH_BOTTOM / 2},${FUNNEL_TOP + FUNNEL_HEIGHT}`,
  ].join(' ');

  // Funnel entrance
  const funnelOpacity = interpolate(frame, [20, 50], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  // Filter layer Y positions (evenly spaced inside funnel)
  const filterYs = FILTERS.map((_, i) => {
    return FUNNEL_TOP + 60 + i * ((FUNNEL_HEIGHT - 80) / (FILTERS.length - 1));
  });

  // Width of funnel at a given Y
  const funnelWidthAtY = (y: number): number => {
    const t = (y - FUNNEL_TOP) / FUNNEL_HEIGHT;
    return FUNNEL_WIDTH_TOP + (FUNNEL_WIDTH_BOTTOM - FUNNEL_WIDTH_TOP) * t;
  };

  // --- Right half: Enrichment cards ---
  const CARD_X = 820;
  const CARD_TOP = 200;
  const CARD_WIDTH = 240;
  const CARD_HEIGHT = 100;
  const CARD_GAP = 16;

  const enrichmentCards = [
    {
      title: 'Token Info',
      detail: 'mcap, holders, organic',
      color: COLORS.blue,
      frameIn: 210,
      hasPie: false,
      hasSparkline: false,
    },
    {
      title: 'Holder Dist',
      detail: 'distribution analysis',
      color: COLORS.purple,
      frameIn: 240,
      hasPie: true,
      hasSparkline: false,
    },
    {
      title: 'Narrative',
      detail: 'AI story analysis',
      color: COLORS.green,
      frameIn: 270,
      hasPie: false,
      hasSparkline: false,
    },
    {
      title: 'Smart Wallets',
      detail: '\u2713 Detected',
      color: COLORS.amber,
      frameIn: 300,
      hasPie: false,
      hasSparkline: false,
    },
    {
      title: 'OKX Momentum',
      detail: 'trend signal',
      color: COLORS.green,
      frameIn: 330,
      hasPie: false,
      hasSparkline: true,
    },
  ];

  // PARALLEL label
  const parallelOpacity = interpolate(frame, [200, 230], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const parallelPulse = frame > 230 ? Math.sin((frame - 230) * 0.1) * 0.3 + 0.7 : 0;

  return (
    <div
      style={{
        position: 'absolute',
        width: 1920,
        height: 1080,
        background: COLORS.bg,
        overflow: 'hidden',
      }}
    >
      <ParticleField opacity={0.2} />

      {/* Scene title */}
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
          text="POOL SCREENING"
          color={COLORS.green}
          fontSize={44}
          delay={0}
        />
      </div>

      {/* LEFT HALF: Screening funnel */}
      <svg
        width={1920}
        height={1080}
        style={{position: 'absolute', top: 0, left: 0, pointerEvents: 'none'}}
      >
        <defs>
          <linearGradient id="funnelGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={COLORS.purple} stopOpacity={0.15} />
            <stop offset="100%" stopColor={COLORS.green} stopOpacity={0.08} />
          </linearGradient>
        </defs>

        {/* Funnel shape */}
        <polygon
          points={funnelPoints}
          fill="url(#funnelGrad)"
          stroke={COLORS.purple}
          strokeWidth={1.5}
          strokeOpacity={0.5}
          opacity={funnelOpacity}
        />

        {/* Filter layer lines */}
        {FILTERS.map((filter, i) => {
          const y = filterYs[i];
          const w = funnelWidthAtY(y);
          const lineOpacity = interpolate(
            frame,
            [filter.frameIn, filter.frameIn + 20],
            [0, 0.6],
            {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'},
          );
          return (
            <line
              key={i}
              x1={funnelCenterX - w / 2 + 10}
              y1={y}
              x2={funnelCenterX + w / 2 - 10}
              y2={y}
              stroke={COLORS.darkGray}
              strokeWidth={1}
              strokeDasharray="3 3"
              opacity={lineOpacity}
            />
          );
        })}

        {/* Animated dots flowing through funnel */}
        {DOTS.map((dot) => {
          const dotElapsed = frame - dot.startFrame;
          if (dotElapsed < 0) return null;

          const yPos = FUNNEL_TOP + dotElapsed * dot.speed;

          // Determine death point
          let deathY = FUNNEL_TOP + FUNNEL_HEIGHT + 50;
          if (dot.dieAtFilter >= 0) {
            deathY = filterYs[dot.dieAtFilter];
          }

          if (yPos > deathY && dot.dieAtFilter >= 0) {
            // Fade out and shrink near death point
            const fadeProgress = Math.min(1, (yPos - deathY) / 30);
            if (fadeProgress >= 1) return null;

            const w = funnelWidthAtY(Math.min(yPos, FUNNEL_TOP + FUNNEL_HEIGHT));
            const xPos = funnelCenterX + dot.xOffset * w * 0.4;

            return (
              <circle
                key={dot.id}
                cx={xPos}
                cy={Math.min(yPos, deathY + 15)}
                r={6 * (1 - fadeProgress)}
                fill={COLORS.red}
                opacity={0.7 * (1 - fadeProgress)}
              />
            );
          }

          // Still alive - check if past funnel bottom
          if (yPos > FUNNEL_TOP + FUNNEL_HEIGHT + 30) return null;

          const w = funnelWidthAtY(Math.min(yPos, FUNNEL_TOP + FUNNEL_HEIGHT));
          const xPos = funnelCenterX + dot.xOffset * w * 0.4;

          // Surviving dots glow near the bottom
          const nearBottom =
            dot.dieAtFilter === -1 && yPos > FUNNEL_TOP + FUNNEL_HEIGHT - 30;
          const glowRadius = nearBottom ? 6 + Math.sin(frame * 0.15) * 2 : 6;

          return (
            <circle
              key={dot.id}
              cx={xPos}
              cy={yPos}
              r={glowRadius}
              fill={dot.color}
              opacity={0.8}
            />
          );
        })}
      </svg>

      {/* Filter labels inside funnel */}
      {FILTERS.map((filter, i) => {
        const y = filterYs[i];
        const labelOpacity = interpolate(
          frame,
          [filter.frameIn, filter.frameIn + 20],
          [0, 1],
          {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'},
        );
        const labelSlide = interpolate(
          frame,
          [filter.frameIn, filter.frameIn + 20],
          [10, 0],
          {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'},
        );

        return (
          <div
            key={i}
            style={{
              position: 'absolute',
              left: funnelCenterX - 110,
              top: y - 12,
              width: 220,
              textAlign: 'center',
              fontFamily: FONTS.mono,
              fontSize: 13,
              color: COLORS.white,
              opacity: labelOpacity,
              transform: `translateY(${labelSlide}px)`,
              textShadow: `0 0 8px ${COLORS.bg}`,
            }}
          >
            {filter.label}
          </div>
        );
      })}

      {/* RIGHT HALF: Enrichment cards */}

      {/* PARALLEL label */}
      <div
        style={{
          position: 'absolute',
          left: CARD_X,
          top: CARD_TOP - 50,
          opacity: parallelOpacity,
        }}
      >
        <div
          style={{
            fontFamily: FONTS.mono,
            fontSize: 16,
            fontWeight: 700,
            color: COLORS.green,
            letterSpacing: 4,
            textShadow: GLOW.text(COLORS.green, 0.4 * parallelPulse),
          }}
        >
          PARALLEL
        </div>
      </div>

      {/* Enrichment cards */}
      {enrichmentCards.map((card, i) => {
        const cardY = CARD_TOP + i * (CARD_HEIGHT + CARD_GAP);

        return (
          <div
            key={i}
            style={{
              position: 'absolute',
              left: CARD_X,
              top: cardY,
            }}
          >
            <NeonBox
              color={card.color}
              delay={card.frameIn}
              width={CARD_WIDTH}
              height={CARD_HEIGHT}
              padding={16}
            >
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 6,
                  width: '100%',
                }}
              >
                <div
                  style={{
                    fontFamily: FONTS.heading,
                    fontSize: 16,
                    fontWeight: 700,
                    color: card.color,
                  }}
                >
                  {card.title}
                </div>

                {/* Card-specific visuals */}
                {card.hasPie ? (
                  <div style={{display: 'flex', alignItems: 'center', gap: 10}}>
                    {/* Tiny pie chart: 3 colored arcs */}
                    <svg width={36} height={36} viewBox="0 0 36 36">
                      <circle
                        cx={18}
                        cy={18}
                        r={16}
                        fill="none"
                        stroke={COLORS.darkGray}
                        strokeWidth={3}
                      />
                      <circle
                        cx={18}
                        cy={18}
                        r={16}
                        fill="none"
                        stroke={COLORS.purple}
                        strokeWidth={3}
                        strokeDasharray="40 60.5"
                        strokeDashoffset={0}
                        transform="rotate(-90 18 18)"
                      />
                      <circle
                        cx={18}
                        cy={18}
                        r={16}
                        fill="none"
                        stroke={COLORS.blue}
                        strokeWidth={3}
                        strokeDasharray="25 75.5"
                        strokeDashoffset={-40}
                        transform="rotate(-90 18 18)"
                      />
                      <circle
                        cx={18}
                        cy={18}
                        r={16}
                        fill="none"
                        stroke={COLORS.green}
                        strokeWidth={3}
                        strokeDasharray="35 65.5"
                        strokeDashoffset={-65}
                        transform="rotate(-90 18 18)"
                      />
                    </svg>
                    <span
                      style={{
                        fontFamily: FONTS.body,
                        fontSize: 13,
                        color: COLORS.gray,
                      }}
                    >
                      {card.detail}
                    </span>
                  </div>
                ) : card.hasSparkline ? (
                  <div style={{display: 'flex', alignItems: 'center', gap: 10}}>
                    {/* Tiny sparkline: 4 points connected by lines */}
                    <svg width={60} height={28} viewBox="0 0 60 28">
                      <polyline
                        points="5,22 20,14 35,18 55,5"
                        fill="none"
                        stroke={COLORS.green}
                        strokeWidth={2}
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                      {[
                        [5, 22],
                        [20, 14],
                        [35, 18],
                        [55, 5],
                      ].map(([cx, cy], j) => (
                        <circle
                          key={j}
                          cx={cx}
                          cy={cy}
                          r={3}
                          fill={COLORS.green}
                        />
                      ))}
                    </svg>
                    <span
                      style={{
                        fontFamily: FONTS.body,
                        fontSize: 13,
                        color: COLORS.gray,
                      }}
                    >
                      {card.detail}
                    </span>
                  </div>
                ) : (
                  <div
                    style={{
                      fontFamily: FONTS.body,
                      fontSize: 13,
                      color: COLORS.gray,
                    }}
                  >
                    {card.detail}
                  </div>
                )}
              </div>
            </NeonBox>
          </div>
        );
      })}

      {/* Connecting arrow from funnel to enrichment cards */}
      {frame > 200 && (
        <svg
          width={1920}
          height={1080}
          style={{position: 'absolute', top: 0, left: 0, pointerEvents: 'none'}}
        >
          <defs>
            <marker
              id="enrichArrow"
              markerWidth={8}
              markerHeight={6}
              refX={7}
              refY={3}
              orient="auto"
            >
              <polygon
                points="0 0, 8 3, 0 6"
                fill={COLORS.green}
                opacity={0.6}
              />
            </marker>
          </defs>
          <line
            x1={funnelCenterX + FUNNEL_WIDTH_BOTTOM / 2 + 40}
            y1={FUNNEL_TOP + FUNNEL_HEIGHT / 2}
            x2={CARD_X - 20}
            y2={CARD_TOP + 2.5 * (CARD_HEIGHT + CARD_GAP)}
            stroke={COLORS.green}
            strokeWidth={1.5}
            strokeDasharray="6 4"
            opacity={interpolate(frame, [200, 240], [0, 0.5], {
              extrapolateLeft: 'clamp',
              extrapolateRight: 'clamp',
            })}
            markerEnd="url(#enrichArrow)"
          />
        </svg>
      )}
    </div>
  );
};
