import React from 'react';
import {useCurrentFrame, useVideoConfig, spring, interpolate} from 'remotion';
import {COLORS, FONTS, SPRING_CONFIGS} from '../styles/theme';
import {STAGGER_DELAY} from '../utils/timing';

interface BarData {
  label: string;
  value: number;
  targetValue: number;
}

interface BarChartProps {
  bars: BarData[];
  delay?: number;
  width?: number;
  height?: number;
}

const BAR_HEIGHT = 28;
const BAR_GAP = 6;
const LABEL_WIDTH = 180;
const VALUE_WIDTH = 60;
const ANIMATION_DURATION = 60; // frames to animate from value to targetValue

export const BarChart: React.FC<BarChartProps> = ({
  bars,
  delay = 0,
  width = 900,
  height = 400,
}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();

  // Chart area dimensions
  const chartLeft = LABEL_WIDTH;
  const chartRight = width - VALUE_WIDTH - 20;
  const chartWidth = chartRight - chartLeft;

  // Find max value for scaling
  const allValues = bars.flatMap((b) => [b.value, b.targetValue]);
  const maxValue = Math.max(...allValues, 2.0);

  // Neutral reference line at value=1.0
  const neutralX = chartLeft + (1.0 / maxValue) * chartWidth;

  // Total content height
  const contentHeight = bars.length * (BAR_HEIGHT + BAR_GAP) - BAR_GAP;
  const topOffset = Math.max(0, (height - contentHeight) / 2);

  return (
    <div
      style={{
        position: 'relative',
        width,
        height,
      }}
    >
      {/* Neutral reference line (dashed, at value=1.0) */}
      <div
        style={{
          position: 'absolute',
          left: neutralX,
          top: topOffset - 10,
          width: 0,
          height: contentHeight + 20,
          borderLeft: `1px dashed ${COLORS.gray}`,
          opacity: 0.5,
        }}
      />
      <div
        style={{
          position: 'absolute',
          left: neutralX - 10,
          top: topOffset - 24,
          fontFamily: FONTS.mono,
          fontSize: 12,
          color: COLORS.gray,
        }}
      >
        1.0x
      </div>

      {bars.map((bar, i) => {
        const barDelay = delay + i * STAGGER_DELAY;
        const delayedFrame = Math.max(0, frame - barDelay);

        // Entrance spring
        const entrance = spring({
          frame: delayedFrame,
          fps,
          config: SPRING_CONFIGS.gentle,
        });

        // Animate value from bar.value toward bar.targetValue
        const animProgress = interpolate(
          delayedFrame,
          [0, ANIMATION_DURATION],
          [0, 1],
          {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'}
        );
        const currentValue =
          bar.value + (bar.targetValue - bar.value) * animProgress;

        // Bar width in pixels
        const barWidth = (currentValue / maxValue) * chartWidth;

        // Color based on target
        let barColor: string;
        if (bar.targetValue > 1.0) {
          barColor = COLORS.green;
        } else if (bar.targetValue < 1.0) {
          barColor = COLORS.amber;
        } else {
          barColor = COLORS.gray;
        }

        const y = topOffset + i * (BAR_HEIGHT + BAR_GAP);

        return (
          <div
            key={i}
            style={{
              position: 'absolute',
              top: y,
              left: 0,
              width: '100%',
              height: BAR_HEIGHT,
              opacity: entrance,
            }}
          >
            {/* Label */}
            <div
              style={{
                position: 'absolute',
                left: 0,
                width: LABEL_WIDTH - 12,
                height: BAR_HEIGHT,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'flex-end',
                fontFamily: FONTS.mono,
                fontSize: 16,
                color: COLORS.white,
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {bar.label}
            </div>

            {/* Bar background */}
            <div
              style={{
                position: 'absolute',
                left: chartLeft,
                top: 2,
                width: chartWidth,
                height: BAR_HEIGHT - 4,
                backgroundColor: COLORS.darkGray,
                borderRadius: 4,
                overflow: 'hidden',
              }}
            >
              {/* Filled portion */}
              <div
                style={{
                  width: Math.max(0, barWidth),
                  height: '100%',
                  backgroundColor: barColor,
                  borderRadius: 4,
                  boxShadow: `0 0 8px ${barColor}44`,
                }}
              />
            </div>

            {/* Value text */}
            <div
              style={{
                position: 'absolute',
                left: chartLeft + Math.max(0, barWidth) + 8,
                top: 0,
                height: BAR_HEIGHT,
                display: 'flex',
                alignItems: 'center',
                fontFamily: FONTS.mono,
                fontSize: 14,
                color: barColor,
                whiteSpace: 'nowrap',
              }}
            >
              {currentValue.toFixed(2)}x
            </div>
          </div>
        );
      })}
    </div>
  );
};
