/**
 * Cover art for a song, drawn from its id.
 *
 * SongForge does not generate images, and a grey placeholder on every card
 * makes a library unreadable at a glance. So each project gets a small piece
 * of deterministic art: two colours and a waveform silhouette derived from the
 * project id. The same song always looks the same, on every machine, and no
 * image is ever stored or fetched.
 */
import * as React from "react";

import { cn } from "@/lib/utils";

/** FNV-1a, enough to spread ids across the colour wheel. */
function hash(text: string): number {
  let value = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    value ^= text.charCodeAt(index);
    value = Math.imul(value, 0x01000193);
  }
  return value >>> 0;
}

/** A small seeded generator, so the bars are stable for a given id. */
function mulberry32(seed: number) {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function Artwork({
  seed,
  bars = 22,
  className,
  rounded = "rounded-xl",
}: {
  /** The project id. */
  seed: string;
  /** Fewer for small tiles, where thin bars turn to noise. */
  bars?: number;
  className?: string;
  rounded?: string;
}) {
  const art = React.useMemo(() => {
    const value = hash(seed);
    const random = mulberry32(value);
    const hueA = value % 360;
    const hueB = (hueA + 35 + Math.floor(random() * 70)) % 360;
    const hueC = (hueA + 180 + Math.floor(random() * 60)) % 360;
    const heights: number[] = [];
    // Two overlapping slow curves plus a little noise: reads as a waveform
    // with a shape, not as a row of random sticks.
    const phaseA = random() * Math.PI * 2;
    const phaseB = random() * Math.PI * 2;
    for (let index = 0; index < bars; index++) {
      const x = index / Math.max(1, bars - 1);
      const envelope = Math.sin(x * Math.PI) ** 0.6;
      const body =
        0.5 +
        0.28 * Math.sin(x * Math.PI * 2.2 + phaseA) +
        0.18 * Math.sin(x * Math.PI * 5.1 + phaseB);
      heights.push(Math.max(0.1, Math.min(1, (body * 0.75 + random() * 0.25) * envelope + 0.08)));
    }
    return { hueA, hueB, hueC, heights };
  }, [seed, bars]);

  const width = 100 / (bars * 1.6);
  const gap = (100 - width * bars) / (bars + 1);

  return (
    <div
      aria-hidden="true"
      className={cn("relative h-full w-full overflow-hidden", rounded, className)}
      style={{
        backgroundColor: `oklch(0.24 0.06 ${art.hueC})`,
        backgroundImage: [
          `radial-gradient(120% 90% at 12% 8%, oklch(0.66 0.17 ${art.hueA} / 0.95), transparent 62%)`,
          `radial-gradient(110% 100% at 92% 96%, oklch(0.5 0.17 ${art.hueB} / 0.9), transparent 60%)`,
        ].join(", "),
      }}
    >
      <svg
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        className="absolute inset-0 h-full w-full"
      >
        {art.heights.map((height, index) => {
          const barHeight = height * 46;
          return (
            <rect
              key={index}
              x={gap + index * (width + gap)}
              y={50 - barHeight / 2}
              width={width}
              height={barHeight}
              rx={width / 2}
              fill="white"
              opacity={0.34 + height * 0.3}
            />
          );
        })}
      </svg>
      {/* A soft top light and bottom shade, so overlaid controls stay legible. */}
      <div className="absolute inset-0 bg-gradient-to-b from-white/10 via-transparent to-black/30" />
    </div>
  );
}
