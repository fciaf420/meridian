"""Generate per-scene narration audio using Edge TTS (free, no API key needed)."""
import asyncio
import edge_tts
import os
import shutil

VOICE = "en-US-GuyNeural"

SCENES = [
    ("scene1-cold-open", "What if your liquidity could think for itself?"),

    ("scene2-three-agents", "Meridian runs three autonomous agents on Solana. The Screener hunts for high-yield Meteora DLMM pools every thirty minutes. The Manager guards your capital every three to ten minutes, adjusting its cadence to market volatility. And a General agent stands by for on-demand commands. Each one reasons, acts, and learns, completely hands-free."),

    ("scene3-screening", "Screening starts with the Meteora Pool Discovery API. Hard filters slash thousands of pools down to the top candidates. Each survivor is enriched in parallel: token fundamentals, holder distribution, narrative quality, smart wallet presence, and real-time momentum data from OKX. ATH proximity flags dangerous entries near all-time highs. Momentum divergence detects fading pumps before they trap you."),

    ("scene4-signals", "Eleven screening signals are tracked at deploy time. After every five closed positions, Meridian recalculates which signals actually predicted wins versus losses. Top performers get a five percent boost. Worst predictors decay. Mean reversion prevents runaway drift. Over time, the agent learns which market signals matter most, and weights them accordingly."),

    ("scene5-deployment", "Deployment calculates bins from volatility tables, detects swap needs, and executes on-chain via the Meteora SDK. Exit rules fire in strict priority: position instructions first, then take profit, out-of-range timeout, yield death, and emergency stop loss. A PnL watcher runs every thirty seconds, no LLM needed, catching stop losses and trailing take-profit exits in real time."),

    ("scene6-memory", "Meridian never forgets. Nuggets, a holographic memory system, stores facts as vector superpositions, retrievable in under a millisecond via fuzzy matching. Pool memory tracks every deploy's PnL, strategy, and outcome per pool. Structured lessons tag each closed position as prefer or avoid. Facts recalled three or more times auto-promote to permanent context. The agent checks all three layers before every decision."),

    ("scene7-autolearn", "Every close triggers a learning cascade. Lessons are derived and deduplicated. Screening thresholds evolve automatically: volatility ceilings, organic floors, stop losses, take profits, each bounded to twenty percent change per step. And Autoresearch runs A B tests on the agent's own prompt. It attributes losses to specific prompt sections, generates hypotheses, tests over seven real positions, and keeps or reverts based on actual PnL improvement. A circuit breaker auto-reverts after three consecutive losses. The agent literally rewrites its own instructions."),
]

async def generate_scene(name: str, text: str, output_dir: str, public_dir: str):
    communicate = edge_tts.Communicate(text, VOICE, rate="-5%", pitch="+0Hz")
    filename = f"{name}.mp3"
    output_path = os.path.join(output_dir, filename)
    public_path = os.path.join(public_dir, filename)

    await communicate.save(output_path)
    shutil.copy2(output_path, public_path)

    size_kb = os.path.getsize(output_path) / 1024
    print(f"  {filename}: {size_kb:.1f} KB")

async def main():
    script_dir = os.path.dirname(os.path.abspath(__file__))
    public_dir = os.path.join(script_dir, "..", "..", "public")

    print(f"Generating {len(SCENES)} scene narrations via Edge TTS")
    print(f"Voice: {VOICE}\n")

    tasks = []
    for name, text in SCENES:
        tasks.append(generate_scene(name, text, script_dir, public_dir))

    await asyncio.gather(*tasks)

    print(f"\nAll {len(SCENES)} audio files generated and copied to public/")

if __name__ == "__main__":
    asyncio.run(main())
