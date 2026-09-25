export const COLORS = {
  bg: '#0a0a1a',
  bgCard: '#12122a',
  purple: '#9945FF',
  green: '#14F195',
  blue: '#4A9FFF',
  amber: '#FFB020',
  red: '#FF4545',
  white: '#EEEEF0',
  gray: '#8888AA',
  darkGray: '#2A2A4A',
};

export const FONTS = {
  heading: 'Inter',
  body: 'Inter',
  mono: 'monospace',
};

export const GLOW = {
  purple: (opacity = 0.4) =>
    `0 0 15px rgba(153,69,255,${opacity}), 0 0 30px rgba(153,69,255,${opacity * 0.5})`,
  green: (opacity = 0.4) =>
    `0 0 15px rgba(20,241,149,${opacity}), 0 0 30px rgba(20,241,149,${opacity * 0.5})`,
  blue: (opacity = 0.4) =>
    `0 0 15px rgba(74,159,255,${opacity}), 0 0 30px rgba(74,159,255,${opacity * 0.5})`,
  amber: (opacity = 0.4) =>
    `0 0 15px rgba(255,176,32,${opacity}), 0 0 30px rgba(255,176,32,${opacity * 0.5})`,
  red: (opacity = 0.4) =>
    `0 0 15px rgba(255,69,69,${opacity}), 0 0 30px rgba(255,69,69,${opacity * 0.5})`,
  text: (color: string, opacity = 0.6) =>
    `0 0 10px ${color}${Math.round(opacity * 255).toString(16).padStart(2, '0')}, 0 0 20px ${color}${Math.round(opacity * 0.5 * 255).toString(16).padStart(2, '0')}`,
};

export const SPRING_CONFIGS = {
  bouncy: { damping: 12, stiffness: 100, mass: 0.5 },
  gentle: { damping: 20, stiffness: 80, mass: 1 },
  snappy: { damping: 15, stiffness: 200, mass: 0.4 },
};
