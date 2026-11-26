"use client";

/**
 * Players: views onto the one audio engine in lib/audio.
 *
 * `Player` is the inline player a page shows for one version; `PlayerDock` is
 * the bar at the bottom of the screen that follows you around. Neither owns an
 * <audio> element - they both drive the shared one, so pressing play here and
 * pause there is the same track, and two players can never overlap.
 *
 * The waveform is drawn from the backend's precomputed peaks, so nothing has to
 * decode the whole file in the browser. When no peak data exists it degrades to
 * a plain progress bar rather than drawing a fake waveform.
 */
import Link from "next/link";
import * as React from "react";
import { Pause, Play, SkipBack, Volume1, Volume2, VolumeX, X } from "lucide-react";

import { Artwork } from "@/components/artwork";
import { Slider, Spinner } from "@/components/ui/primitives";
import { type Track, useAudio, useAudioTime, useWaveform } from "@/lib/audio";
import { clamp, cn, formatDuration } from "@/lib/utils";

// ------------------------------------------------------------------ waveform

/** Width of one bar plus its gap, in CSS pixels. */
const BAR_PITCH = 4;

function useElementWidth<T extends HTMLElement>() {
  const ref = React.useRef<T>(null);
  const [width, setWidth] = React.useState(0);
  React.useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver((entries) => {
      const next = Math.round(entries[0]?.contentRect.width ?? 0);
      setWidth((previous) => (previous === next ? previous : next));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

/**
 * A scrubbable track: waveform when peaks exist, plain bar when they do not.
 *
 * Bars are laid out once per width and painted twice - a muted layer and an
 * accent layer clipped to the playhead - so a time update changes one style
 * property instead of re-rendering a hundred elements.
 */
export function WaveformTrack({
  peaks,
  progress,
  duration,
  height = 48,
  onSeek,
  label = "Seek",
  className,
}: {
  peaks: number[] | null | undefined;
  /** 0..1 */
  progress: number;
  duration: number;
  height?: number;
  onSeek: (fraction: number) => void;
  label?: string;
  className?: string;
}) {
  const [ref, width] = useElementWidth<HTMLDivElement>();
  const [hover, setHover] = React.useState<number | null>(null);
  const draggingRef = React.useRef(false);

  const fractionAt = (clientX: number) => {
    const rect = ref.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return 0;
    return clamp((clientX - rect.left) / rect.width, 0, 1);
  };

  const bars = React.useMemo(() => {
    if (!peaks || peaks.length === 0 || width === 0) return null;
    const columns = Math.max(16, Math.floor(width / BAR_PITCH));
    const values: number[] = [];
    for (let index = 0; index < columns; index++) {
      const from = Math.floor((index / columns) * peaks.length);
      const to = Math.max(from + 1, Math.floor(((index + 1) / columns) * peaks.length));
      let peak = 0;
      for (let cursor = from; cursor < to && cursor < peaks.length; cursor++) {
        if (peaks[cursor] > peak) peak = peaks[cursor];
      }
      values.push(peak);
    }
    return values.map((peak, index) => (
      <span
        key={index}
        className="flex-1 rounded-full bg-current"
        style={{ height: `${Math.max(6, Math.min(100, peak * 100))}%` }}
      />
    ));
  }, [peaks, width]);

  const percent = clamp(progress, 0, 1) * 100;
  const seconds = clamp(progress, 0, 1) * duration;

  const interaction = {
    onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      draggingRef.current = true;
      event.currentTarget.setPointerCapture(event.pointerId);
      onSeek(fractionAt(event.clientX));
    },
    onPointerMove: (event: React.PointerEvent<HTMLDivElement>) => {
      const fraction = fractionAt(event.clientX);
      setHover(fraction);
      if (draggingRef.current) onSeek(fraction);
    },
    onPointerUp: (event: React.PointerEvent<HTMLDivElement>) => {
      draggingRef.current = false;
      event.currentTarget.releasePointerCapture?.(event.pointerId);
    },
    onPointerLeave: () => setHover(null),
    onKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (!duration) return;
      const step = (event.shiftKey ? 30 : 5) / duration;
      if (event.key === "ArrowRight" || event.key === "ArrowUp") {
        event.preventDefault();
        event.stopPropagation();
        onSeek(clamp(progress + step, 0, 1));
      } else if (event.key === "ArrowLeft" || event.key === "ArrowDown") {
        event.preventDefault();
        event.stopPropagation();
        onSeek(clamp(progress - step, 0, 1));
      } else if (event.key === "Home") {
        event.preventDefault();
        event.stopPropagation();
        onSeek(0);
      } else if (event.key === "End") {
        event.preventDefault();
        event.stopPropagation();
        onSeek(1);
      }
    },
  };

  const slider = {
    role: "slider" as const,
    tabIndex: 0,
    "aria-label": label,
    "aria-valuemin": 0,
    "aria-valuemax": Math.round(duration),
    "aria-valuenow": Math.round(seconds),
    "aria-valuetext": `${formatDuration(seconds)} of ${formatDuration(duration || null)}`,
  };

  return (
    <div
      ref={ref}
      {...slider}
      {...interaction}
      className={cn("group/track relative cursor-pointer touch-none select-none rounded-md", className)}
      style={{ height }}
    >
      {bars ? (
        <>
          <div className="absolute inset-0 flex items-center gap-px text-edge-strong">
            {bars}
          </div>
          <div
            className="absolute inset-0 flex items-center gap-px text-accent"
            style={{ clipPath: `inset(0 ${100 - percent}% 0 0)` }}
          >
            {bars}
          </div>
        </>
      ) : (
        // No peaks: a plain progress bar, honestly, rather than an invented shape.
        <div className="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 overflow-hidden rounded-full bg-elevated">
          <div className="h-full rounded-full bg-accent" style={{ width: `${percent}%` }} />
        </div>
      )}

      {hover !== null && duration > 0 && (
        <>
          <span
            aria-hidden="true"
            className="pointer-events-none absolute inset-y-0 w-px bg-ink/50"
            style={{ left: `${hover * 100}%` }}
          />
          <span
            aria-hidden="true"
            className="pointer-events-none absolute -top-7 -translate-x-1/2 rounded-md border border-edge-strong bg-elevated px-1.5 py-0.5 text-xs tabular-nums text-ink shadow-[var(--sf-shadow-md)]"
            style={{ left: `${clamp(hover, 0.04, 0.96) * 100}%` }}
          >
            {formatDuration(hover * duration)}
          </span>
        </>
      )}
    </div>
  );
}

// -------------------------------------------------------------- play button

export function PlayButton({
  playing,
  buffering,
  onClick,
  size = "md",
  label,
  disabled,
  className,
}: {
  playing: boolean;
  buffering?: boolean;
  onClick: (event: React.MouseEvent) => void;
  size?: "sm" | "md" | "lg";
  label: string;
  disabled?: boolean;
  className?: string;
}) {
  const box = size === "lg" ? "h-14 w-14" : size === "sm" ? "h-9 w-9" : "h-11 w-11";
  const glyph = size === "lg" ? "h-6 w-6" : size === "sm" ? "h-4 w-4" : "h-[1.15rem] w-[1.15rem]";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      className={cn(
        "sf-ember flex shrink-0 items-center justify-center rounded-full",
        "shadow-[0_1px_0_oklch(1_0_0/0.3)_inset,0_6px_18px_-6px_var(--sf-accent-deep)]",
        "transition-[transform,filter] duration-150 hover:scale-105 hover:brightness-110 active:scale-95",
        "disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:scale-100",
        box,
        className,
      )}
    >
      {buffering ? (
        <Spinner className={glyph} />
      ) : playing ? (
        <Pause className={cn(glyph, "fill-current")} aria-hidden="true" />
      ) : (
        <Play className={cn(glyph, "ml-0.5 fill-current")} aria-hidden="true" />
      )}
    </button>
  );
}

// ------------------------------------------------------------- inline player

export interface PlayerProps {
  projectId: string;
  version?: number;
  title?: string;
  /** Known duration, used until the audio element reports its own. */
  duration?: number | null;
  compact?: boolean;
  className?: string;
}

export function Player({
  projectId,
  version,
  title,
  duration: knownDuration,
  compact,
  className,
}: PlayerProps) {
  const audio = useAudio();
  const waveform = useWaveform(projectId, version);
  const track: Track = React.useMemo(
    () => ({ projectId, version, title: title ?? "Untitled", duration: knownDuration }),
    [projectId, version, title, knownDuration],
  );
  const current = audio.isCurrent(track);
  const peaks = waveform?.available ? waveform.peaks : null;
  const fallbackDuration = knownDuration ?? waveform?.duration ?? 0;

  // Keyboard controls, scoped to the player so they do not fight text inputs.
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.target instanceof HTMLInputElement) return;
    if (event.key === "k" || (event.key === " " && event.target === event.currentTarget)) {
      event.preventDefault();
      audio.play(track);
    } else if (event.key === "m") {
      event.preventDefault();
      audio.setMuted(!audio.muted);
    }
  };

  return (
    <div
      className={cn("flex items-center gap-3 sm:gap-4", className)}
      onKeyDown={onKeyDown}
      role="group"
      aria-label={title ? `Player for ${title}` : "Audio player"}
    >
      <PlayButton
        size={compact ? "sm" : "md"}
        playing={current && audio.playing}
        buffering={current && audio.buffering}
        onClick={() => audio.play(track)}
        label={current && audio.playing ? "Pause" : "Play"}
      />

      <div className="min-w-0 flex-1">
        {current && audio.error ? (
          <p className="text-[13px] text-danger">{audio.error}</p>
        ) : current ? (
          <LiveTrack track={track} peaks={peaks} fallbackDuration={fallbackDuration} compact={compact} />
        ) : (
          <IdleTrack
            peaks={peaks}
            duration={fallbackDuration}
            compact={compact}
            onSeek={(fraction) => audio.playFrom(track, fraction)}
          />
        )}
      </div>

      {!compact && (
        <div className="hidden shrink-0 items-center gap-1 sm:flex">
          <IconControl
            label="Back to start"
            onClick={() => (current ? audio.seek(0) : audio.playFrom(track, 0))}
          >
            <SkipBack className="h-4 w-4" aria-hidden="true" />
          </IconControl>
          <VolumeControl />
        </div>
      )}
    </div>
  );
}

function Times({ current, duration }: { current: number; duration: number }) {
  return (
    <div className="mt-1 flex justify-between text-xs tabular-nums text-ink-faint">
      <span>{formatDuration(current)}</span>
      <span>{formatDuration(duration || null)}</span>
    </div>
  );
}

function LiveTrack({
  track,
  peaks,
  fallbackDuration,
  compact,
}: {
  track: Track;
  peaks: number[] | null;
  fallbackDuration: number;
  compact?: boolean;
}) {
  const audio = useAudio();
  const time = useAudioTime();
  const duration = time.duration || fallbackDuration;
  return (
    <>
      <WaveformTrack
        peaks={peaks}
        progress={duration > 0 ? time.current / duration : 0}
        duration={duration}
        height={compact ? 32 : 56}
        onSeek={(fraction) => audio.playFrom(track, fraction)}
      />
      <Times current={time.current} duration={duration} />
    </>
  );
}

function IdleTrack({
  peaks,
  duration,
  compact,
  onSeek,
}: {
  peaks: number[] | null;
  duration: number;
  compact?: boolean;
  onSeek: (fraction: number) => void;
}) {
  return (
    <>
      <WaveformTrack
        peaks={peaks}
        progress={0}
        duration={duration}
        height={compact ? 32 : 56}
        onSeek={onSeek}
      />
      <Times current={0} duration={duration} />
    </>
  );
}

function IconControl({
  label,
  onClick,
  children,
  className,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={cn(
        "flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-ink-muted transition-colors hover:bg-overlay hover:text-ink",
        className,
      )}
    >
      {children}
    </button>
  );
}

function VolumeControl({ className }: { className?: string }) {
  const audio = useAudio();
  const level = audio.muted ? 0 : audio.volume;
  const Icon = level === 0 ? VolumeX : level < 0.5 ? Volume1 : Volume2;
  return (
    <div className={cn("flex items-center gap-1", className)}>
      <IconControl
        label={audio.muted ? "Unmute" : "Mute"}
        onClick={() => audio.setMuted(!audio.muted)}
      >
        <Icon className="h-4 w-4" aria-hidden="true" />
      </IconControl>
      <Slider
        min={0}
        max={1}
        step={0.01}
        value={level}
        aria-label="Volume"
        onChange={(event) => audio.setVolume(Number(event.target.value))}
        className="w-20 lg:w-24"
      />
    </div>
  );
}

// ---------------------------------------------------------------------- dock

/**
 * The persistent player.
 *
 * Rendered by the shell at the bottom of the main column. It only exists
 * while a track is loaded, and closing it stops playback.
 */
export function PlayerDock() {
  const audio = useAudio();
  const track = audio.track;
  if (!track) return null;
  return <DockBody track={track} />;
}

function DockBody({ track }: { track: Track }) {
  const audio = useAudio();
  const time = useAudioTime();
  const waveform = useWaveform(track.projectId, track.version);
  const peaks = waveform?.available ? waveform.peaks : null;
  const duration = time.duration || track.duration || waveform?.duration || 0;
  const progress = duration > 0 ? time.current / duration : 0;

  return (
    <section
      aria-label="Now playing"
      className="sf-glass sf-rise relative border-t border-edge"
    >
      {/* On a phone the waveform has no room; a hairline shows the position. */}
      <div className="absolute inset-x-0 top-0 h-0.5 bg-elevated md:hidden" aria-hidden="true">
        <div className="h-full bg-accent" style={{ width: `${clamp(progress, 0, 1) * 100}%` }} />
      </div>

      <div className="mx-auto flex h-[4.25rem] max-w-[110rem] items-center gap-3 px-3 sm:px-5 lg:gap-5">
        <Link
          href={`/song/${track.projectId}`}
          className="group flex min-w-0 flex-1 items-center gap-3 md:w-64 md:flex-none"
          title="Open this song"
        >
          <span className="relative h-11 w-11 shrink-0">
            <Artwork seed={track.projectId} bars={9} rounded="rounded-lg" />
          </span>
          <span className="min-w-0">
            <span className="block truncate text-sm font-medium text-ink group-hover:text-accent">
              {track.title}
            </span>
            <span className="flex items-center gap-1.5 text-xs text-ink-faint">
              {audio.error ? (
                <span className="truncate text-danger">{audio.error}</span>
              ) : (
                <>
                  <span
                    className="sf-eq text-accent"
                    data-paused={!audio.playing}
                    aria-hidden="true"
                  >
                    <span />
                    <span />
                    <span />
                  </span>
                  {track.version != null ? `Version ${track.version}` : "Primary version"}
                </>
              )}
            </span>
          </span>
        </Link>

        <PlayButton
          size="sm"
          playing={audio.playing}
          buffering={audio.buffering}
          onClick={() => audio.toggle()}
          disabled={Boolean(audio.error)}
          label={audio.playing ? "Pause" : "Play"}
        />

        <div className="hidden min-w-0 flex-1 items-center gap-3 md:flex">
          <span className="w-10 text-right text-xs tabular-nums text-ink-faint">
            {formatDuration(time.current)}
          </span>
          <WaveformTrack
            className="flex-1"
            peaks={peaks}
            progress={progress}
            duration={duration}
            height={36}
            onSeek={(fraction) => audio.seek(fraction * duration)}
            label={`Seek in ${track.title}`}
          />
          <span className="w-10 text-xs tabular-nums text-ink-faint">
            {formatDuration(duration || null)}
          </span>
        </div>

        <VolumeControl className="hidden lg:flex" />

        <IconControl label="Close player" onClick={() => audio.close()}>
          <X className="h-4 w-4" aria-hidden="true" />
        </IconControl>
      </div>
    </section>
  );
}
