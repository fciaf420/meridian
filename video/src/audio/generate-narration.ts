// Audio generation uses Python edge-tts (free, no API key).
// Run: python src/audio/generate-narration.py
//
// This generates 8 per-scene MP3 files in public/:
//   scene1-cold-open.mp3, scene2-three-agents.mp3, etc.
//
// The Video.tsx component loads each file via staticFile()
// and plays them synced to their respective scene Sequences.

console.log("Use the Python script instead:");
console.log("  python src/audio/generate-narration.py");
