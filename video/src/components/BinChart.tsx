import React from 'react';
import {useCurrentFrame, useVideoConfig, spring, interpolate} from 'remotion';
import {COLORS, FONTS, SPRING_CONFIGS} from '../styles/theme';

interface BinChartProps {
  strategy?: 'bid_ask' | 'spot';
  delay?: number;
  activeBinIndex?: number;
  totalBins?: number;
}

const BIN_WIDTH = 8;
const BIN_GAP = 2;
const MAX_BIN_HEIGHT = 200;
const ACTIVE_BIN_HEIGHT = 240;

export const BinChart: React.FC<BinChartProps> = ({
  strategy = 'bid_ask',
  delay = 0,
  activeBinIndex = 35,
  totalBins = 69,
}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();

  const chartWidth = totalBins * (BIN_WIDTH + BIN_GAP) - BIN_GAP;
  const chartHeight = ACTIVE_BIN_HEIGHT + 50;

  return (
    <div
      style={{
        position: 'relative',
        width: chartWidth,
        height: chartHeight,
        display: 'flex',
        alignItems: 'flex-end',
        justifyContent: 'center',
      }}
    >
      {/* Bins */}
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-end',
          gap: BIN_GAP,
          position: 'relative',
        }}
      >
        {Array.from({length: totalBins}).map((_, i) => {
          const isActive = i === activeBinIndex;
          const isBelow = i < activeBinIndex;
          const isAbove = i > activeBinIndex;

          // Calculate target height based on strategy
          let targetHeight: number;
          if (isActive) {
            targetHeight = ACTIVE_BIN_HEIGHT;
          } else if (strategy === 'bid_ask') {
            // Bid-ask: only bins below active bin, descending wedge
            if (isAbove) {
              targetHeight = 0;
            } else {
              // Closer to active bin = taller
              const distFromActive = activeBinIndex - i;
              const maxDist = activeBinIndex;
              const ratio = 1 - distFromActive / Math.max(maxDist, 1);
              targetHeight = 30 + ratio * (MAX_BIN_HEIGHT - 30);
            }
          } else {
            // Spot: bins on both sides, uniform height
            const distFromActive = Math.abs(i - activeBinIndex);
            const maxDist = Math.max(
              activeBinIndex,
              totalBins - 1 - activeBinIndex
            );
            if (distFromActive > maxDist * 0.8) {
              targetHeight = 0;
            } else {
              targetHeight = MAX_BIN_HEIGHT * 0.8;
            }
          }

          // Color
          let binColor: string;
          if (isActive) {
            binColor = COLORS.white;
          } else if (strategy === 'bid_ask') {
            binColor = COLORS.blue;
          } else {
            // Spot: blue below, purple above
            binColor = isBelow ? COLORS.blue : COLORS.purple;
          }

          // Staggered entrance spring -- stagger from active bin outward
          const distFromActive = Math.abs(i - activeBinIndex);
          const binDelay = delay + distFromActive * 1.5;
          const delayedFrame = Math.max(0, frame - binDelay);

          const entrance = spring({
            frame: delayedFrame,
            fps,
            config: SPRING_CONFIGS.snappy,
          });

          const currentHeight = targetHeight * entrance;

          return (
            <div
              key={i}
              style={{
                position: 'relative',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
              }}
            >
              <div
                style={{
                  width: BIN_WIDTH,
                  height: currentHeight,
                  backgroundColor: binColor,
                  borderRadius: '2px 2px 0 0',
                  opacity: isActive ? 1 : 0.8,
                  boxShadow: isActive
                    ? '0 0 12px rgba(255,255,255,0.6), 0 0 24px rgba(255,255,255,0.3)'
                    : 'none',
                }}
              />

              {/* Active bin label */}
              {isActive && entrance > 0.5 && (
                <div
                  style={{
                    position: 'absolute',
                    top: -30,
                    fontFamily: FONTS.mono,
                    fontSize: 11,
                    color: COLORS.white,
                    whiteSpace: 'nowrap',
                    textAlign: 'center',
                    opacity: interpolate(entrance, [0.5, 1], [0, 1], {
                      extrapolateLeft: 'clamp',
                      extrapolateRight: 'clamp',
                    }),
                  }}
                >
                  Active Bin
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};
