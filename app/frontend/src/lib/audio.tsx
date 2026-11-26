"use client";

/**
 * One audio engine for the whole app.
 *
 * Playback used to belong to whichever page mounted a player, so opening a
 * song from the Library stopped the music, and two players on one page could
 * talk over each other. There is now a single <audio> element, owned here and
 * mounted once in the layout: every play button anywhere drives it, the dock
 * at the bottom of the screen shows it, and navigating between pages never
 * interrupts it.
 *
 * The state is split across two contexts on purpose. `timeupdate` fires several
 * times a second; the handful of components that draw a playhead subscribe to
 * the time context, and everything else (every card with a play button) only
 * re-renders when the track or the play state actually changes.
 */
import * as React from "react";

import * as api from "./api";
import type { Waveform } from "./types";
import { clamp } from "./utils";

export interface Track {
  projectId: string;
  /** Omitted means "the project's primary version". */
  version?: number;
  title: string;
  /** Known length, shown until the audio element reports its own. */
  duration?: number | null;
}

export function trackKey(track: Pick<Track, "projectId" | "version">): string {
  return `${track.projectId}:${track.version ?? "primary"}`;
}

interface AudioState {
  track: Track | null;
  playing: boolean;
  /** True between asking for audio and the first frame being ready. */
  buffering: boolean;
  error: string | null;
  volume: number;
  muted: boolean;
  /** Start this track, or toggle it if it is already the loaded one. */
  play: (track: Track) => void;
  toggle: () => void;
  pause: () => void;
  /** Seek within the loaded track, in seconds. */
  seek: (seconds: number) => void;
  /** Load this track if needed, then seek to a fraction of it and play. */
  playFrom: (track: Track, fraction: number) => void;
  setVolume: (value: number) => void;
  setMuted: (value: boolean) => void;
  /** Stop and dismiss the dock. */
  close: () => void;
  isCurrent: (track: Pick<Track, "projectId" | "version">) => boolean;
}

interface AudioTime {
  current: number;
  duration: number;
}

const StateContext = React.createContext<AudioState | null>(null);
const TimeContext = React.createContext<AudioTime>({ current: 0, duration: 0 });

export function useAudio(): AudioState {
  const value = React.useContext(StateContext);
  if (!value) throw new Error("useAudio must be used inside <AudioProvider>");
  return value;
}

/** Position and length of the loaded track. Re-renders on every time update. */
export function useAudioTime(): AudioTime {
  return React.useContext(TimeContext);
}

function readStoredVolume(): { volume: number; muted: boolean } {
  try {
    const raw = JSON.parse(localStorage.getItem("songforge.volume") ?? "null") as
      | { volume?: unknown; muted?: unknown }
      | null;
    const volume = typeof raw?.volume === "number" ? clamp(raw.volume, 0, 1) : 1;
    return { volume, muted: raw?.muted === true };
  } catch {
    return { volume: 1, muted: false };
  }
}

export function AudioProvider({ children }: { children: React.ReactNode }) {
  const audioRef = React.useRef<HTMLAudioElement | null>(null);
  const [track, setTrack] = React.useState<Track | null>(null);
  const [playing, setPlaying] = React.useState(false);
  const [buffering, setBuffering] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [volume, setVolumeState] = React.useState(1);
  const [muted, setMutedState] = React.useState(false);
  const [time, setTime] = React.useState<AudioTime>({ current: 0, duration: 0 });

  // What to do once the element has metadata for a freshly loaded source.
  const pendingRef = React.useRef<{ fraction: number | null; autoplay: boolean } | null>(null);
  const trackRef = React.useRef<Track | null>(null);
  React.useEffect(() => {
    trackRef.current = track;
  }, [track]);

  // The volume is a per-browser preference; restored after mount because
  // localStorage cannot be read during a server render.
  React.useEffect(() => {
    const stored = readStoredVolume();
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setVolumeState(stored.volume);
    setMutedState(stored.muted);
  }, []);

  React.useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.volume = volume;
    audio.muted = muted;
    try {
      localStorage.setItem("songforge.volume", JSON.stringify({ volume, muted }));
    } catch {
      /* a preference, not worth surfacing */
    }
  }, [volume, muted]);

  const start = React.useCallback((next: Track, fraction: number | null) => {
    const audio = audioRef.current;
    if (!audio) return;
    const src = api.streamUrl(next.projectId, next.version);
    pendingRef.current = { fraction, autoplay: true };
    setTrack(next);
    setError(null);
    setBuffering(true);
    setTime({ current: 0, duration: next.duration ?? 0 });
    audio.src = src;
    audio.load();
    void audio.play().catch((cause: unknown) => {
      // AbortError is the element telling us a newer load() replaced this
      // one - the expected outcome of clicking two songs quickly.
      if (cause instanceof DOMException && cause.name === "AbortError") return;
      setBuffering(false);
      setPlaying(false);
      setError(cause instanceof Error ? cause.message : "Playback failed.");
    });
  }, []);

  const toggle = React.useCallback(() => {
    const audio = audioRef.current;
    if (!audio || !trackRef.current) return;
    if (audio.paused) {
      void audio.play().catch((cause: unknown) => {
        if (cause instanceof DOMException && cause.name === "AbortError") return;
        setError(cause instanceof Error ? cause.message : "Playback failed.");
      });
    } else {
      audio.pause();
    }
  }, []);

  const play = React.useCallback(
    (next: Track) => {
      const loaded = trackRef.current;
      if (loaded && trackKey(loaded) === trackKey(next) && !audioRef.current?.error) {
        toggle();
        return;
      }
      start(next, null);
    },
    [start, toggle],
  );

  const pause = React.useCallback(() => audioRef.current?.pause(), []);

  const seek = React.useCallback((seconds: number) => {
    const audio = audioRef.current;
    if (!audio || !Number.isFinite(seconds)) return;
    const length = Number.isFinite(audio.duration) ? audio.duration : 0;
    const target = clamp(seconds, 0, length || seconds);
    audio.currentTime = target;
    setTime((previous) => ({ ...previous, current: target }));
  }, []);

  const playFrom = React.useCallback(
    (next: Track, fraction: number) => {
      const audio = audioRef.current;
      const loaded = trackRef.current;
      if (audio && loaded && trackKey(loaded) === trackKey(next) && !audio.error) {
        const length = Number.isFinite(audio.duration) ? audio.duration : (next.duration ?? 0);
        seek(clamp(fraction, 0, 1) * length);
        return;
      }
      start(next, clamp(fraction, 0, 1));
    },
    [seek, start],
  );

  const close = React.useCallback(() => {
    const audio = audioRef.current;
    if (audio) {
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
    }
    pendingRef.current = null;
    setTrack(null);
    setPlaying(false);
    setBuffering(false);
    setError(null);
    setTime({ current: 0, duration: 0 });
  }, []);

  const setVolume = React.useCallback((value: number) => {
    const next = clamp(value, 0, 1);
    setVolumeState(next);
    setMutedState(next === 0);
  }, []);

  const setMuted = React.useCallback((value: boolean) => setMutedState(value), []);

  const isCurrent = React.useCallback(
    (candidate: Pick<Track, "projectId" | "version">) =>
      track !== null && trackKey(track) === trackKey(candidate),
    [track],
  );

  // Space toggles playback when nothing else has the keyboard - the one
  // shortcut every media app shares. A focused button, link or text field
  // keeps Space for itself.
  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== " " || event.repeat) return;
      if (!trackRef.current) return;
      const target = event.target;
      if (target instanceof HTMLElement && target !== document.body) return;
      event.preventDefault();
      toggle();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [toggle]);

  // Lock-screen and media-key controls, where the browser supports them.
  React.useEffect(() => {
    if (typeof navigator === "undefined" || !("mediaSession" in navigator)) return;
    if (!track) {
      navigator.mediaSession.metadata = null;
      return;
    }
    navigator.mediaSession.metadata = new MediaMetadata({
      title: track.title,
      artist: "SongForge",
    });
    navigator.mediaSession.setActionHandler("play", () => toggle());
    navigator.mediaSession.setActionHandler("pause", () => pause());
  }, [track, toggle, pause]);

  const state = React.useMemo<AudioState>(
    () => ({
      track,
      playing,
      buffering,
      error,
      volume,
      muted,
      play,
      toggle,
      pause,
      seek,
      playFrom,
      setVolume,
      setMuted,
      close,
      isCurrent,
    }),
    [
      track, playing, buffering, error, volume, muted,
      play, toggle, pause, seek, playFrom, setVolume, setMuted, close, isCurrent,
    ],
  );

  return (
    <StateContext.Provider value={state}>
      <TimeContext.Provider value={time}>
        {children}
        <audio
          ref={audioRef}
          preload="metadata"
          onPlay={() => setPlaying(true)}
          onPlaying={() => setBuffering(false)}
          onWaiting={() => setBuffering(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => setPlaying(false)}
          onTimeUpdate={(event) => {
            const element = event.currentTarget;
            setTime((previous) => ({ ...previous, current: element.currentTime }));
          }}
          onLoadedMetadata={(event) => {
            const element = event.currentTarget;
            const length = element.duration;
            if (Number.isFinite(length) && length > 0) {
              setTime((previous) => ({ ...previous, duration: length }));
              const pending = pendingRef.current;
              if (pending?.fraction != null) {
                element.currentTime = pending.fraction * length;
              }
            }
            pendingRef.current = null;
          }}
          onCanPlay={() => setBuffering(false)}
          onError={() => {
            // Clearing the source in close() also lands here; that is not an
            // error anyone needs to read.
            if (!trackRef.current) return;
            setBuffering(false);
            setPlaying(false);
            setError("This version has no playable audio.");
          }}
        />
      </TimeContext.Provider>
    </StateContext.Provider>
  );
}

// ---------------------------------------------------------------- waveforms

const waveformCache = new Map<string, Waveform | null>();

/**
 * Peak data for a version, cached for the session.
 *
 * Tagged with the key it belongs to, so switching version shows no peaks
 * rather than the previous take's while the new ones load.
 */
export function useWaveform(projectId: string, version?: number): Waveform | null {
  const key = `${projectId}:${version ?? "primary"}`;
  const [loaded, setLoaded] = React.useState<{ key: string; data: Waveform | null } | null>(
    () => (waveformCache.has(key) ? { key, data: waveformCache.get(key) ?? null } : null),
  );

  React.useEffect(() => {
    if (waveformCache.has(key)) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setLoaded({ key, data: waveformCache.get(key) ?? null });
      return;
    }
    let cancelled = false;
    api
      .getWaveform(projectId, version)
      .then((data) => {
        // Only a real answer is cached: "not available yet" can change the
        // moment a render finishes.
        if (data.available) waveformCache.set(key, data);
        if (!cancelled) setLoaded({ key, data });
      })
      .catch(() => {
        if (!cancelled) setLoaded({ key, data: null });
      });
    return () => {
      cancelled = true;
    };
  }, [key, projectId, version]);

  return loaded?.key === key ? loaded.data : null;
}
