import React from 'react';
import {useCurrentFrame, useVideoConfig, spring, interpolate} from 'remotion';
import {COLORS, FONTS, GLOW, SPRING_CONFIGS} from '../styles/theme';
import {STAGGER_DELAY} from '../utils/timing';
import {FlowArrow} from './FlowArrow';

interface NetworkNode {
  x: number;
  y: number;
  label: string;
  color?: string;
}

interface NetworkGraphProps {
  nodes: NetworkNode[];
  centerLabel?: string;
  delay?: number;
}

const CENTER_X = 960;
const CENTER_Y = 540;
const CENTER_RADIUS = 60;
const NODE_RADIUS = 36;
const PACKET_RADIUS = 8;
const PACKET_TRAVEL_DURATION = 60; // frames for packet to travel from outer to center

export const NetworkGraph: React.FC<NetworkGraphProps> = ({
  nodes,
  centerLabel = 'Network',
  delay = 0,
}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();

  // Center node entrance
  const centerEntrance = spring({
    frame: Math.max(0, frame - delay),
    fps,
    config: SPRING_CONFIGS.bouncy,
  });

  return (
    <div
      style={{
        position: 'relative',
        width: 1920,
        height: 1080,
      }}
    >
      {/* Flow arrows from each outer node to center */}
      {nodes.map((node, i) => {
        const arrowDelay = delay + STAGGER_DELAY + i * STAGGER_DELAY;
        return (
          <FlowArrow
            key={`arrow-${i}`}
            fromX={node.x}
            fromY={node.y}
            toX={CENTER_X}
            toY={CENTER_Y}
            color={node.color || COLORS.purple}
            delay={arrowDelay}
            duration={20}
          />
        );
      })}

      {/* Data packet circles traveling along each line */}
      <svg
        width={1920}
        height={1080}
        style={{position: 'absolute', top: 0, left: 0, pointerEvents: 'none'}}
      >
        <defs>
          <filter id="packet-glow" x="-100%" y="-100%" width="300%" height="300%">
            <feGaussianBlur in="SourceGraphic" stdDeviation={3} />
          </filter>
        </defs>

        {nodes.map((node, i) => {
          const packetDelay =
            delay + STAGGER_DELAY + i * STAGGER_DELAY + 20; // start after arrow draws
          const packetFrame = frame - packetDelay;

          // Looping: packet repeats every PACKET_TRAVEL_DURATION + small gap
          const cycleLength = PACKET_TRAVEL_DURATION + 15;
          const cycleFrame = packetFrame >= 0 ? packetFrame % cycleLength : -1;

          const t = interpolate(cycleFrame, [0, PACKET_TRAVEL_DURATION], [0, 1], {
            extrapolateLeft: 'clamp',
            extrapolateRight: 'clamp',
          });

          if (packetFrame < 0 || cycleFrame > PACKET_TRAVEL_DURATION) {
            return null;
          }

          const px = node.x + (CENTER_X - node.x) * t;
          const py = node.y + (CENTER_Y - node.y) * t;
          const packetColor = node.color || COLORS.purple;

          return (
            <React.Fragment key={`packet-${i}`}>
              {/* Glow layer */}
              <circle
                cx={px}
                cy={py}
                r={PACKET_RADIUS + 2}
                fill={packetColor}
                opacity={0.3}
                filter="url(#packet-glow)"
              />
              {/* Packet */}
              <circle
                cx={px}
                cy={py}
                r={PACKET_RADIUS}
                fill={packetColor}
                opacity={0.9}
              />
            </React.Fragment>
          );
        })}
      </svg>

      {/* Outer nodes */}
      {nodes.map((node, i) => {
        const nodeDelay = delay + i * STAGGER_DELAY;
        const delayedFrame = Math.max(0, frame - nodeDelay);

        const entrance = spring({
          frame: delayedFrame,
          fps,
          config: SPRING_CONFIGS.bouncy,
        });

        const nodeColor = node.color || COLORS.purple;
        const scale = interpolate(entrance, [0, 1], [0, 1]);

        return (
          <div
            key={`node-${i}`}
            style={{
              position: 'absolute',
              left: node.x - NODE_RADIUS,
              top: node.y - NODE_RADIUS,
              width: NODE_RADIUS * 2,
              height: NODE_RADIUS * 2,
              borderRadius: '50%',
              backgroundColor: COLORS.bgCard,
              border: `2px solid ${nodeColor}`,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              transform: `scale(${scale})`,
              boxShadow: `0 0 12px ${nodeColor}66, 0 0 24px ${nodeColor}33`,
            }}
          >
            <div
              style={{
                fontFamily: FONTS.heading,
                fontSize: 11,
                fontWeight: 600,
                color: COLORS.white,
                textAlign: 'center',
                lineHeight: '1.2',
                padding: 4,
                wordBreak: 'break-word',
              }}
            >
              {node.label}
            </div>
          </div>
        );
      })}

      {/* Center node */}
      <div
        style={{
          position: 'absolute',
          left: CENTER_X - CENTER_RADIUS,
          top: CENTER_Y - CENTER_RADIUS,
          width: CENTER_RADIUS * 2,
          height: CENTER_RADIUS * 2,
          borderRadius: '50%',
          backgroundColor: COLORS.bgCard,
          border: `2px solid ${COLORS.purple}`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          transform: `scale(${interpolate(centerEntrance, [0, 1], [0, 1])})`,
          boxShadow: GLOW.purple(0.5),
        }}
      >
        <div
          style={{
            fontFamily: FONTS.heading,
            fontSize: 14,
            fontWeight: 700,
            color: COLORS.white,
            textAlign: 'center',
            lineHeight: '1.2',
          }}
        >
          {centerLabel}
        </div>
      </div>
    </div>
  );
};
