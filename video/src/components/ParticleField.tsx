import React from 'react';
import {useCurrentFrame} from 'remotion';
import {COLORS} from '../styles/theme';

interface ParticleFieldProps {
  opacity?: number;
}

interface Particle {
  x: number;
  y: number;
  radius: number;
  color: string;
  alpha: number;
  dx: number;
  dy: number;
}

/** Deterministic pseudo-random from seed (0..1). */
function seededRandom(seed: number): number {
  const x = Math.sin(seed * 9301 + 49297) * 233280;
  return x - Math.floor(x);
}

function generateParticles(count: number): Particle[] {
  const particles: Particle[] = [];
  for (let i = 0; i < count; i++) {
    const r1 = seededRandom(i * 7 + 1);
    const r2 = seededRandom(i * 7 + 2);
    const r3 = seededRandom(i * 7 + 3);
    const r4 = seededRandom(i * 7 + 4);
    const r5 = seededRandom(i * 7 + 5);
    const r6 = seededRandom(i * 7 + 6);

    const angle = r4 * Math.PI * 2;
    const speed = 0.2 + r5 * 0.3; // 0.2-0.5 px/frame

    particles.push({
      x: r1 * 1920,
      y: r2 * 1080,
      radius: 2 + r3 * 2, // 2-4px
      color: r6 > 0.5 ? COLORS.purple : COLORS.blue,
      alpha: 0.1 + r6 * 0.2, // 0.1-0.3
      dx: Math.cos(angle) * speed,
      dy: Math.sin(angle) * speed,
    });
  }
  return particles;
}

const PARTICLES = generateParticles(40);

export const ParticleField: React.FC<ParticleFieldProps> = ({opacity = 1}) => {
  const frame = useCurrentFrame();

  return (
    <div
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        width: 1920,
        height: 1080,
        opacity,
        overflow: 'hidden',
        pointerEvents: 'none',
      }}
    >
      {PARTICLES.map((p, i) => {
        // Calculate current position with wrapping
        let cx = (p.x + p.dx * frame) % 1920;
        let cy = (p.y + p.dy * frame) % 1080;
        if (cx < 0) cx += 1920;
        if (cy < 0) cy += 1080;

        return (
          <div
            key={i}
            style={{
              position: 'absolute',
              left: cx - p.radius,
              top: cy - p.radius,
              width: p.radius * 2,
              height: p.radius * 2,
              borderRadius: '50%',
              backgroundColor: p.color,
              opacity: p.alpha,
            }}
          />
        );
      })}
    </div>
  );
};
