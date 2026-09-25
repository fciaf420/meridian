import React from 'react';
import {AbsoluteFill, useCurrentFrame, useVideoConfig, spring, interpolate} from 'remotion';
import {COLORS, FONTS, GLOW, SPRING_CONFIGS} from '../styles/theme';
import {FPS, STAGGER_DELAY} from '../utils/timing';
import {GlowingText} from '../components/GlowingText';
import {NeonBox} from '../components/NeonBox';

/* ------------------------------------------------------------------ */
/*  Inline BinChart – 69 bins, bid_ask strategy, active bin at index 35 */
/* ------------------------------------------------------------------ */

const BIN_COUNT = 69;
const ACTIVE_BIN = 35;
const CHART_WIDTH = 760;
const CHART_HEIGHT = 280;
const BIN_GAP = 1;

function seededRandom(seed: number): number {
  const x = Math.sin(seed * 9301 + 49297) * 233280;
  return x - Math.floor(x);
}

/** Generate deterministic bin heights for bid_ask strategy. */
function generateBinHeights(): number[] {
  const heights: number[] = [];
  for (let i = 0; i < BIN_COUNT; i++) {
    const distFromActive = Math.abs(i - ACTIVE_BIN);
    // Bell-curve-ish shape centered on active bin
    const base = Math.exp(-(distFromActive * distFromActive) / 200);
    const noise = seededRandom(i * 13 + 7) * 0.15;
    heights.push(Math.max(0.08, base + noise));
  }
  return heights;
}

const BIN_HEIGHTS = generateBinHeights();

const BinChartInline: React.FC<{frame: number; fps: number}> = ({frame, fps}) => {
  const binWidth = (CHART_WIDTH - (BIN_COUNT - 1) * BIN_GAP) / BIN_COUNT;

  return (
    <div
      style={{
        position: 'relative',
        width: CHART_WIDTH,
        height: CHART_HEIGHT,
        display: 'flex',
        alignItems: 'flex-end',
        gap: BIN_GAP,
      }}
    >
      {BIN_HEIGHTS.map((h, i) => {
        // Stagger entrance from center outward
        const distFromCenter = Math.abs(i - ACTIVE_BIN);
        const binDelay = 40 + distFromCenter * 1.2;

        const binProgress = spring({
          frame: Math.max(0, frame - binDelay),
          fps,
          config: SPRING_CONFIGS.bouncy,
        });

        const binHeight = interpolate(binProgress, [0, 1], [0, h * CHART_HEIGHT]);

        const isActive = i === ACTIVE_BIN;
        const isNearActive = Math.abs(i - ACTIVE_BIN) <= 3;

        let color: string;
        if (isActive) {
          color = COLORS.white;
        } else if (i < ACTIVE_BIN) {
          color = isNearActive ? COLORS.green : COLORS.green + '88';
        } else {
          color = isNearActive ? COLORS.red : COLORS.red + '88';
        }

        return (
          <div
            key={i}
            style={{
              width: binWidth,
              height: binHeight,
              backgroundColor: color,
              borderRadius: '2px 2px 0 0',
              boxShadow: isActive
                ? GLOW.purple(0.6)
                : undefined,
            }}
          />
        );
      })}
    </div>
  );
};

/* ------------------------------------------------------------------ */
/*  Inline ChecklistItem                                               */
/* ------------------------------------------------------------------ */

interface ChecklistItemData {
  text: string;
  color: string;
  activateFrame: number;
}

const CHECKLIST_ITEMS: ChecklistItemData[] = [
  {text: 'Position instruction met', color: COLORS.purple, activateFrame: 200},
  {text: 'Take profit >= 5%', color: COLORS.green, activateFrame: 260},
  {text: 'OOR timeout >= 30 min', color: COLORS.amber, activateFrame: 320},
  {text: 'Low fee + low volume', color: COLORS.amber, activateFrame: 380},
  {text: 'Emergency drop <= -50%', color: COLORS.red, activateFrame: 440},
];

const ChecklistItemInline: React.FC<{
  text: string;
  color: string;
  activateFrame: number;
  frame: number;
  fps: number;
}> = ({text, color, activateFrame, frame, fps}) => {
  const delayedFrame = Math.max(0, frame - activateFrame);

  const progress = spring({
    frame: delayedFrame,
    fps,
    config: SPRING_CONFIGS.snappy,
  });

  const opacity = interpolate(progress, [0, 1], [0, 1]);
  const translateX = interpolate(progress, [0, 1], [40, 0]);

  // Checkmark opacity
  const checkOpacity = interpolate(progress, [0, 1], [0, 1]);

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 16,
        opacity,
        transform: `translateX(${translateX}px)`,
        marginBottom: 18,
      }}
    >
      {/* Checkbox */}
      <div
        style={{
          width: 28,
          height: 28,
          borderRadius: 6,
          border: `2px solid ${color}`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: frame >= activateFrame + 20 ? color + '22' : 'transparent',
          flexShrink: 0,
        }}
      >
        <svg width={16} height={16} viewBox="0 0 16 16" style={{opacity: checkOpacity}}>
          <polyline
            points="3,8 7,12 13,4"
            fill="none"
            stroke={color}
            strokeWidth={2.5}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </div>
      {/* Text */}
      <div
        style={{
          fontFamily: FONTS.body,
          fontSize: 22,
          fontWeight: 500,
          color: COLORS.white,
        }}
      >
        {text}
      </div>
    </div>
  );
};

/* ------------------------------------------------------------------ */
/*  Main scene                                                         */
/* ------------------------------------------------------------------ */

export const DeploymentExitRules: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();

  /* --- Title --- */
  const titleOpacity = interpolate(frame, [0, 20], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  /* --- SOL label drop-in at frame 150 --- */
  const solDelay = 150;
  const solProgress = spring({
    frame: Math.max(0, frame - solDelay),
    fps,
    config: SPRING_CONFIGS.bouncy,
  });

  const solY = interpolate(solProgress, [0, 1], [-60, 0]);
  const solOpacity = interpolate(solProgress, [0, 1], [0, 1]);

  /* --- Strategy label fade --- */
  const strategyOpacity = interpolate(frame, [80, 110], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  /* --- HARD EXIT RULES title --- */
  const exitTitleProgress = spring({
    frame: Math.max(0, frame - 150),
    fps,
    config: SPRING_CONFIGS.gentle,
  });
  const exitTitleOpacity = interpolate(exitTitleProgress, [0, 1], [0, 1]);

  /* --- Footer text --- */
  const footerOpacity = interpolate(frame, [480, 510], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

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
        <GlowingText text="DEPLOYMENT & EXIT RULES" fontSize={40} />
      </div>

      {/* ============ LEFT HALF: BinChart ============ */}
      <div
        style={{
          position: 'absolute',
          left: 80,
          top: 160,
          width: 800,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
        }}
      >
        {/* SOL label animates from top */}
        <div
          style={{
            opacity: solOpacity,
            transform: `translateY(${solY}px)`,
            fontFamily: FONTS.heading,
            fontSize: 32,
            fontWeight: 700,
            color: COLORS.green,
            textShadow: GLOW.green(0.5),
            marginBottom: 20,
          }}
        >
          0.5 SOL
        </div>

        {/* Bin chart */}
        <BinChartInline frame={frame} fps={fps} />

        {/* Strategy label */}
        <div
          style={{
            marginTop: 20,
            fontFamily: FONTS.body,
            fontSize: 18,
            color: COLORS.gray,
            opacity: strategyOpacity,
          }}
        >
          bid_ask strategy
        </div>

        {/* Active bin indicator */}
        <div
          style={{
            marginTop: 8,
            fontFamily: FONTS.mono,
            fontSize: 14,
            color: COLORS.gray,
            opacity: strategyOpacity,
          }}
        >
          69 bins | active bin #35
        </div>
      </div>

      {/* ============ RIGHT HALF: Exit Rules Checklist ============ */}
      <div
        style={{
          position: 'absolute',
          left: 1000,
          top: 160,
          width: 840,
        }}
      >
        {/* HARD EXIT RULES heading */}
        <div
          style={{
            opacity: exitTitleOpacity,
            fontFamily: FONTS.heading,
            fontSize: 28,
            fontWeight: 700,
            color: COLORS.red,
            textShadow: GLOW.text(COLORS.red, 0.4),
            marginBottom: 36,
          }}
        >
          HARD EXIT RULES
        </div>

        {/* Checklist items */}
        {CHECKLIST_ITEMS.map((item, i) => (
          <ChecklistItemInline
            key={i}
            text={item.text}
            color={item.color}
            activateFrame={item.activateFrame}
            frame={frame}
            fps={fps}
          />
        ))}

        {/* Footer note */}
        <div
          style={{
            marginTop: 40,
            fontFamily: FONTS.body,
            fontSize: 18,
            color: COLORS.gray,
            opacity: footerOpacity,
          }}
        >
          PnL watcher every 30s -- no LLM needed
        </div>
      </div>
    </AbsoluteFill>
  );
};
