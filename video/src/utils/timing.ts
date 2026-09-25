export const FPS = 30;
export const WIDTH = 1920;
export const HEIGHT = 1080;

// Scene durations derived from actual audio lengths (Edge TTS @ -5% rate)
// Each scene = audioDelay + audioFrames + buffer
// Audio durations: 3.5s, 24.4s, 28.4s, 26.4s, 25.3s, 30.4s, 39.3s, 20.2s
export const SCENES = {
  COLD_OPEN:        { start: 0,    duration: 210  }, //  0:00 -  0:07  (audio 3.5s, delay 90f for logo)
  THREE_AGENTS:     { start: 210,  duration: 762  }, //  0:07 -  0:32  (audio 24.4s)
  POOL_SCREENING:   { start: 972,  duration: 882  }, //  0:32 -  1:02  (audio 28.4s)
  SIGNAL_WEIGHTING: { start: 1854, duration: 822  }, //  1:02 -  1:29  (audio 26.4s)
  DEPLOYMENT:       { start: 2676, duration: 790  }, //  1:29 -  1:56  (audio 25.3s)
  MEMORY_SYSTEMS:   { start: 3466, duration: 942  }, //  1:56 -  2:27  (audio 30.4s)
  AUTO_LEARNING:    { start: 4408, duration: 1209 }, //  2:27 -  3:07  (audio 39.3s)
} as const;

export const TOTAL_FRAMES = 5617; // 3:07

export const FADE_DURATION = 15; // frames for crossfade
export const STAGGER_DELAY = 10; // frames between element entrances
