"use client";

/**
 * Lyrics studio: write and refine lyrics with the local model before any GPU
 * time goes to rendering. A draft can be opened in Create for full control, or
 * rendered straight away.
 */
import Link from "next/link";
import { useRouter } from "next/navigation";
import * as React from "react";
import { ArrowRight, Copy, NotebookPen, Sparkles, Trash2 } from "lucide-react";

import { LyricsEditor } from "@/components/lyrics-editor";
import { LyricsWriter } from "@/components/lyrics-writer";
import {
  Banner,
  Button,
  Card,
  EmptyState,
  Field,
  Input,
  Skeleton,
  Textarea,
} from "@/components/ui/primitives";
import * as api from "@/lib/api";
import { useStore } from "@/lib/store";
import type { LyricsResult } from "@/lib/types";
import { cn, formatDate, formatDuration } from "@/lib/utils";

const HISTORY_KEY = "songforge.lyrics-studio.history";
const DRAFT_KEY = "songforge.lyrics-studio.draft";
const HISTORY_LIMIT = 12;

interface Draft {
  title: string;
  style: string;
  lyrics: string;
  language: string;
}

interface HistoryItem extends Draft {
  id: string;
  at: string;
  estimatedSeconds: number;
}

const EMPTY_DRAFT: Draft = { title: "", style: "", lyrics: "", language: "English" };

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function estimateSeconds(lyrics: string): number {
  const characters = lyrics.replace(/\[[^\]]*\]/g, "").trim().length;
  return characters < 20 ? 0 : Math.round(27 + characters / 8.5);
}

export default function LyricsStudioPage() {
  // Everything here lives in localStorage, which the server render cannot see.
  // Rendering only after mount avoids a hydration mismatch on every field.
  const mounted = React.useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );
  if (!mounted) {
    return (
      <div className="mx-auto max-w-6xl space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }
  return <Studio />;
}

function Studio() {
  const router = useRouter();
  const { notify, trackJob, settings } = useStore();
  const [draft, setDraft] = React.useState<Draft>(() => load(DRAFT_KEY, EMPTY_DRAFT));
  const [history, setHistory] = React.useState<HistoryItem[]>(() => load(HISTORY_KEY, []));
  const [rendering, setRendering] = React.useState(false);

  React.useEffect(() => {
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
    } catch {
      /* convenience only */
    }
  }, [draft]);

  React.useEffect(() => {
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
    } catch {
      /* convenience only */
    }
  }, [history]);

  const remember = (result: LyricsResult, language: string) => {
    const item: HistoryItem = {
      id: `${Date.now()}`,
      at: new Date().toISOString(),
      title: result.title,
      style: result.style,
      lyrics: result.lyrics,
      language,
      estimatedSeconds: result.estimated_seconds,
    };
    setHistory((current) => [item, ...current].slice(0, HISTORY_LIMIT));
  };

  const edit = (patch: Partial<Draft>) => setDraft((current) => ({ ...current, ...patch }));

  const openInCreate = () => {
    try {
      localStorage.setItem(
        "songforge.create-draft",
        JSON.stringify({ title: draft.title, style: draft.style, lyrics: draft.lyrics, genres: [], moods: [] }),
      );
    } catch {
      notify({ tone: "danger", title: "Could not hand the lyrics to Create" });
      return;
    }
    router.push("/create");
  };

  const render = async (values: Draft) => {
    if (!values.lyrics.trim()) {
      notify({ tone: "warning", title: "Write or paste lyrics first" });
      return;
    }
    if (!values.style.trim()) {
      notify({ tone: "warning", title: "Add a style", body: "YuE2 needs a style prompt: genre, instruments, mood." });
      return;
    }
    setRendering(true);
    try {
      const project = await api.createProject({
        title: values.title.trim() || undefined,
        style_prompt: values.style,
        lyrics: values.lyrics,
        language: values.language.trim() || null,
        tags: ["lyrics-studio"],
      });
      // The backend unloads the lyrics model before the render starts.
      const job = await api.generate(project.id, { stage: "audio" });
      trackJob(job);
      notify({
        tone: "info",
        title: "Rendering started",
        body: `About ${formatDuration(estimateSeconds(values.lyrics))} of music; expect roughly 3-4 minutes of generation per minute of song.`,
        href: `/song/${project.id}`,
      });
      router.push(`/song/${project.id}`);
    } catch (cause) {
      notify({
        tone: "danger",
        title: "Could not start the render",
        body: cause instanceof Error ? cause.message : String(cause),
      });
    } finally {
      setRendering(false);
    }
  };

  const estimated = estimateSeconds(draft.lyrics);

  return (
    <div className="mx-auto max-w-6xl">
      <header className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold tracking-tight">
            <NotebookPen className="h-5 w-5 text-[var(--sf-accent)]" aria-hidden="true" />
            Lyrics
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-[var(--sf-text-muted)]">
            Write and refine lyrics with the local model before spending GPU time on a
            render. Everything stays on this computer.
          </p>
        </div>
      </header>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <Card className="p-5">
          <LyricsWriter
            storageKey="songforge.lyrics-writer.studio"
            defaults={{ styleHint: draft.style, language: settings?.default_language ?? "English" }}
            currentLyrics={draft.lyrics}
            onUse={(result, { applyStyle, applyTitle }) => {
              const language = readWriterLanguage();
              remember(result, language);
              edit({
                lyrics: result.lyrics,
                language,
                ...(applyStyle && result.style ? { style: result.style } : {}),
                ...(applyTitle && result.title ? { title: result.title } : {}),
              });
            }}
            onWriteAndRender={async (result) => {
              const language = readWriterLanguage();
              remember(result, language);
              const next: Draft = {
                lyrics: result.lyrics,
                language,
                style: draft.style.trim() || result.style,
                title: draft.title.trim() || result.title,
              };
              setDraft(next);
              await render(next);
            }}
          />
        </Card>

        <Card className="p-5">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-semibold">Draft</h2>
            {estimated > 0 && (
              <span className="text-xs text-[var(--sf-text-faint)]">
                roughly {formatDuration(estimated)} when sung
              </span>
            )}
          </div>

          {!draft.lyrics.trim() && !draft.title && (
            <div className="mb-4">
              <Banner tone="info">
                Generated lyrics land here when you press <strong>Use these lyrics</strong>.
                You can also paste your own and use the writer to revise them.
              </Banner>
            </div>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Title" htmlFor="studio-title">
              <Input id="studio-title" value={draft.title} onChange={(e) => edit({ title: e.target.value })} />
            </Field>
            <Field label="Language" htmlFor="studio-language">
              <Input id="studio-language" value={draft.language} onChange={(e) => edit({ language: e.target.value })} />
            </Field>
          </div>
          <Field
            className="mt-4"
            label="Style"
            htmlFor="studio-style"
            hint="Genre, instruments, mood, tempo, vocal. YuE2 reads this as its only style input."
          >
            <Textarea id="studio-style" rows={2} value={draft.style} onChange={(e) => edit({ style: e.target.value })} />
          </Field>

          <div className="mt-4">
            <LyricsEditor
              id="studio-lyrics"
              value={draft.lyrics}
              onChange={(lyrics) => edit({ lyrics })}
              historyKey="lyrics-studio"
              rows={16}
            />
          </div>

          <div className="mt-4 flex flex-wrap gap-2">
            <Button variant="primary" loading={rendering} onClick={() => void render(draft)} disabled={!draft.lyrics.trim()}>
              <Sparkles className="h-4 w-4" aria-hidden="true" />
              Render as a new song
            </Button>
            <Button onClick={openInCreate} disabled={!draft.lyrics.trim()}>
              Open in Create
              <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </Button>
            <Button
              variant="ghost"
              disabled={!draft.lyrics.trim()}
              onClick={() => {
                void navigator.clipboard?.writeText(draft.lyrics).then(
                  () => notify({ tone: "success", title: "Lyrics copied" }),
                  () => notify({ tone: "warning", title: "Copying needs a secure page; select the text instead" }),
                );
              }}
            >
              <Copy className="h-4 w-4" aria-hidden="true" />
              Copy
            </Button>
          </div>
          <p className="mt-2 text-xs text-[var(--sf-text-faint)]">
            Open in Create for seed, planning and sampling options; rendering here uses your defaults.
          </p>
        </Card>
      </div>

      <section className="mt-8" aria-labelledby="studio-history">
        <h2 id="studio-history" className="mb-3 text-sm font-semibold">
          Earlier lyrics
        </h2>
        {history.length === 0 ? (
          <EmptyState
            title="Nothing written yet"
            description="Every set of lyrics you use is kept here, in this browser, so you can go back to an earlier idea."
          />
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {history.map((item) => (
              <Card key={item.id} className={cn("flex flex-col p-4")}>
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{item.title || "Untitled"}</p>
                    <p className="mt-0.5 text-[11px] text-[var(--sf-text-faint)]">
                      {formatDate(item.at)} · {item.language} · about {formatDuration(item.estimatedSeconds)}
                    </p>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    aria-label={`Remove ${item.title || "these lyrics"} from history`}
                    onClick={() => setHistory((current) => current.filter((entry) => entry.id !== item.id))}
                  >
                    <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                  </Button>
                </div>
                <pre className="mt-2 line-clamp-6 flex-1 whitespace-pre-wrap font-mono text-[11px] leading-5 text-[var(--sf-text-muted)]">
                  {item.lyrics}
                </pre>
                <Button
                  size="sm"
                  className="mt-3 self-start"
                  onClick={() => {
                    if (draft.lyrics.trim() && draft.lyrics !== item.lyrics && !window.confirm("Replace the current draft with these lyrics?")) {
                      return;
                    }
                    setDraft({ title: item.title, style: item.style, lyrics: item.lyrics, language: item.language });
                  }}
                >
                  Load into draft
                </Button>
              </Card>
            ))}
          </div>
        )}
      </section>

      <p className="mt-8 text-xs text-[var(--sf-text-faint)]">
        The lyrics model and YuE2 share one graphics card, so the model is unloaded
        automatically before every render. Manage the model in{" "}
        <Link href="/settings" className="underline hover:text-[var(--sf-text)]">
          Settings
        </Link>
        .
      </p>
    </div>
  );
}

/** The writer keeps its form in localStorage; read the language it was set to. */
function readWriterLanguage(): string {
  const saved = load<{ language?: string }>("songforge.lyrics-writer.studio", {});
  return saved.language?.trim() || "English";
}
