"use client";

/**
 * Waveform audio player.
 *
 * The waveform is drawn from the backend's precomputed peaks, so nothing has to
 * decode the whole file in the browser. When no peak data exists the component
 * degrades to a plain progress bar rather than drawing a fake waveform.
 */
import * as React from "react";
import { Pause, Play, SkipBack, Volume2, VolumeX } from "lucide-react";

import { Button } from "@/components/ui/primitives";
import * as api from "@/lib/api";
import type { Waveform } from "@/lib/types";
import { clamp, cn, formatDuration } from "@/lib/utils";

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
  const audioRef = React.useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = React.useState(false);
  const [current, setCurrent] = React.useState(0);
  const [duration, setDuration] = React.useState(knownDuration ?? 0);
  const [volume, setVolume] = React.useState(1);
  const [muted, setMuted] = React.useState(false);
  // Tagged with the source it belongs to, so switching version shows no peaks
  // rather than the previous take's, without a synchronous reset in an effect.
  const [waveformFor, setWaveformFor] = React.useState<{
    key: string;
    data: Waveform | null;
  } | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const src = api.streamUrl(projectId, version);

  const waveformKey = `${projectId}:${version ?? "primary"}`;
  const waveform = waveformFor?.key === waveformKey ? waveformFor.data : null;

  // Load peak data for this version.
  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await api.getWaveform(projectId, version);
        if (!cancelled) setWaveformFor({ key: waveformKey, data });
      } catch {
        if (!cancelled) setWaveformFor({ key: waveformKey, data: null });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId, version, waveformKey]);

  // Reset when the source changes. Adjusted during render rather than in an
  // effect so the old position never paints against the new track.
  const [lastSrc, setLastSrc] = React.useState(src);
  if (src !== lastSrc) {
    setLastSrc(src);
    setPlaying(false);
    setCurrent(0);
    setDuration(knownDuration ?? 0);
    setError(null);
  }

  const toggle = React.useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) {
      void audio.play().catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : "Playback failed.");
      });
    } else {
      audio.pause();
    }
  }, []);

  const seekTo = React.useCallback(
    (seconds: number) => {
      const audio = audioRef.current;
      if (!audio || !Number.isFinite(seconds)) return;
      const target = clamp(seconds, 0, duration || audio.duration || 0);
      audio.currentTime = target;
      setCurrent(target);
    },
    [duration],
  );

  // Keyboard controls, scoped to the player so they do not fight text inputs.
  const onKeyDown = (event: React.KeyboardEvent) => {
    const audio = audioRef.current;
    if (!audio) return;
    // The volume slider is inside this group and needs its own arrow keys.
    if (event.target instanceof HTMLInputElement) return;
    switch (event.key) {
      case " ":
      case "k":
        event.preventDefault();
        toggle();
        break;
      case "ArrowRight":
        event.preventDefault();
        seekTo(audio.currentTime + (event.shiftKey ? 30 : 5));
        break;
      case "ArrowLeft":
        event.preventDefault();
        seekTo(audio.currentTime - (event.shiftKey ? 30 : 5));
        break;
      case "Home":
        event.preventDefault();
        seekTo(0);
        break;
      case "End":
        event.preventDefault();
        seekTo(duration);
        break;
      case "m":
        event.preventDefault();
        setMuted((value) => !value);
        break;
      default:
        break;
    }
  };

  // The element resets to volume 1 whenever src changes, and the mute button
  // only moves state - so the element is synced here rather than in handlers.
  React.useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.volume = volume;
    audio.muted = muted;
  }, [volume, muted, src]);

  const effectiveDuration = duration || waveform?.duration || 0;
  const progress = effectiveDuration > 0 ? current / effectiveDuration : 0;

  return (
    <div
      className={cn(
        "rounded-xl border border-[var(--sf-border)] bg-[var(--sf-bg-raised)] p-3",
        className,
      )}
      onKeyDown={onKeyDown}
      tabIndex={0}
      role="group"
      aria-label={title ? `Player for ${title}` : "Audio player"}
    >
      <audio
        ref={audioRef}
        src={src}
        preload="metadata"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onTimeUpdate={(event) => setCurrent(event.currentTarget.currentTime)}
        onLoadedMetadata={(event) => {
          const value = event.currentTarget.duration;
          if (Number.isFinite(value) && value > 0) setDuration(value);
        }}
        onError={() => setError("This version has no playable audio.")}
      />

      <div className="flex items-center gap-3">
        <Button
          variant="primary"
          size="icon"
          onClick={toggle}
          disabled={Boolean(error)}
          aria-label={playing ? "Pause" : "Play"}
          className="h-10 w-10 shrink-0 rounded-full"
        >
          {playing ? (
            <Pause className="h-4 w-4" aria-hidden="true" />
          ) : (
            <Play className="ml-0.5 h-4 w-4" aria-hidden="true" />
          )}
        </Button>

        <div className="min-w-0 flex-1">
          {error ? (
            <p className="text-xs text-[var(--sf-danger)]">{error}</p>
          ) : (
            <WaveformTrack
              peaks={waveform?.available ? waveform.peaks : null}
              progress={progress}
              duration={effectiveDuration}
              compact={compact}
              onSeek={(fraction) => seekTo(fraction * effectiveDuration)}
            />
          )}
          <div className="mt-1 flex justify-between text-[11px] tabular-nums text-[var(--sf-text-faint)]">
            <span>{formatDuration(current)}</span>
            <span>{formatDuration(effectiveDuration || null)}</span>
          </div>
        </div>

        {!compact && (
          <div className="flex shrink-0 items-center gap-1.5">
            <Button
              variant="ghost"
              size="icon"
              onClick={() => seekTo(0)}
              aria-label="Back to start"
              className="h-8 w-8"
            >
              <SkipBack className="h-3.5 w-3.5" aria-hidden="true" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setMuted((value) => !value)}
              aria-label={muted ? "Unmute" : "Mute"}
              className="h-8 w-8"
            >
              {muted || volume === 0 ? (
                <VolumeX className="h-3.5 w-3.5" aria-hidden="true" />
              ) : (
                <Volume2 className="h-3.5 w-3.5" aria-hidden="true" />
              )}
            </Button>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={muted ? 0 : volume}
              aria-label="Volume"
              onChange={(event) => {
                const value = Number(event.target.value);
                setVolume(value);
                setMuted(value === 0);
              }}
              className="h-1 w-20 cursor-pointer accent-[var(--sf-accent)]"
            />
          </div>
        )}
      </div>
    </div>
  );
}

function WaveformTrack({
  peaks,
  progress,
  duration,
  compact,
  onSeek,
}: {
  peaks: number[] | null;
  progress: number;
  duration: number;
  compact?: boolean;
  onSeek: (fraction: number) => void;
}) {
  const ref = React.useRef<HTMLDivElement>(null);
  const height = compact ? 28 : 48;

  const seekFromEvent = (clientX: number) => {
    const element = ref.current;
    if (!element) return;
    const rect = element.getBoundingClientRect();
    onSeek(clamp((clientX - rect.left) / rect.width, 0, 1));
  };

  // No peaks: a plain progress bar, honestly, rather than an invented shape.
  if (!peaks || peaks.length === 0) {
    return (
      <div
        ref={ref}
        role="slider"
        tabIndex={0}
        aria-label="Seek"
        aria-valuemin={0}
        aria-valuemax={Math.round(duration)}
        aria-valuenow={Math.round(progress * duration)}
        aria-valuetext={formatDuration(progress * duration)}
        onClick={(event) => seekFromEvent(event.clientX)}
        className="h-2 cursor-pointer overflow-hidden rounded-full bg-[var(--sf-bg-overlay)]"
      >
        <div
          className="h-full rounded-full bg-[var(--sf-accent)]"
          style={{ width: `${Math.round(progress * 100)}%` }}
        />
      </div>
    );
  }

  // Downsample so a 800-bucket waveform stays readable in a narrow card.
  const columns = compact ? 64 : 150;
  const step = Math.max(1, Math.floor(peaks.length / columns));
  const bars: number[] = [];
  for (let i = 0; i < peaks.length; i += step) {
    bars.push(Math.max(...peaks.slice(i, i + step)));
  }
  const playedIndex = Math.floor(progress * bars.length);

  return (
    <div
      ref={ref}
      role="slider"
      tabIndex={0}
      aria-label="Seek"
      aria-valuemin={0}
      aria-valuemax={Math.round(duration)}
      aria-valuenow={Math.round(progress * duration)}
      aria-valuetext={formatDuration(progress * duration)}
      onClick={(event) => seekFromEvent(event.clientX)}
      className="flex cursor-pointer items-center gap-px"
      style={{ height }}
    >
      {bars.map((peak, index) => (
        <span
          key={index}
          className="flex-1 rounded-full transition-colors"
          style={{
            height: `${Math.max(8, peak * 100)}%`,
            minWidth: 1,
            backgroundColor:
              index <= playedIndex ? "var(--sf-accent)" : "var(--sf-border-strong)",
          }}
        />
      ))}
    </div>
  );
}
