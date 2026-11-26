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
  Button,
  Card,
  Dialog,
  EmptyState,
  Field,
  Input,
  PageHeader,
  SectionTitle,
  Skeleton,
  Textarea,
} from "@/components/ui/primitives";
import * as api from "@/lib/api";
import { useStore } from "@/lib/store";
import type { LyricsResult } from "@/lib/types";
import { formatDate, formatDuration } from "@/lib/utils";

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
      <div className="mx-auto max-w-[84rem] space-y-5">
        <Skeleton className="h-9 w-48" />
        <Skeleton className="h-96 w-full rounded-2xl" />
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
  // Loading an earlier set over unsaved work asks first, in the app's own
  // dialog rather than the browser's.
  const [pendingLoad, setPendingLoad] = React.useState<HistoryItem | null>(null);

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

  const loadItem = (item: HistoryItem) =>
    setDraft({ title: item.title, style: item.style, lyrics: item.lyrics, language: item.language });

  return (
    <div className="mx-auto max-w-[84rem]">
      <PageHeader
        title="Lyrics"
        description="A scratchpad for words: write, revise and keep earlier drafts before any GPU time goes into a render. Everything stays on this computer."
      />

      <div className="grid gap-6 lg:grid-cols-2 lg:items-start">
        <Card className="p-5 sm:p-6">
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

        <Card className="p-5 sm:p-6">
          <SectionTitle
            className="mb-5"
            description={
              estimated > 0
                ? `Roughly ${formatDuration(estimated)} when sung.`
                : "Type or paste lyrics here, or use the writer and press “Use these lyrics”."
            }
            action={
              (draft.lyrics.trim() || draft.title || draft.style) && (
                <Button variant="ghost" size="sm" onClick={() => setDraft(EMPTY_DRAFT)}>
                  Clear
                </Button>
              )
            }
          >
            Draft
          </SectionTitle>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Title" htmlFor="studio-title">
              <Input
                id="studio-title"
                value={draft.title}
                placeholder="Untitled"
                onChange={(e) => edit({ title: e.target.value })}
              />
            </Field>
            <Field label="Language" htmlFor="studio-language">
              <Input
                id="studio-language"
                value={draft.language}
                onChange={(e) => edit({ language: e.target.value })}
              />
            </Field>
          </div>
          <Field
            className="mt-4"
            label="Style"
            htmlFor="studio-style"
            hint="Genre, instruments, mood, tempo, vocal. Needed to render; YuE2 reads this as its only style input."
          >
            <Textarea
              id="studio-style"
              rows={2}
              value={draft.style}
              placeholder="indie folk, fingerpicked acoustic guitar, soft female vocal"
              onChange={(e) => edit({ style: e.target.value })}
            />
          </Field>

          <div className="mt-5">
            <LyricsEditor
              id="studio-lyrics"
              value={draft.lyrics}
              onChange={(lyrics) => edit({ lyrics })}
              historyKey="lyrics-studio"
              rows={16}
            />
          </div>

          <div className="mt-5 flex flex-wrap gap-2 border-t border-edge pt-5">
            <Button
              variant="primary"
              loading={rendering}
              onClick={() => void render(draft)}
              disabled={!draft.lyrics.trim()}
            >
              {!rendering && <Sparkles className="h-4 w-4" aria-hidden="true" />}
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
          <p className="mt-3 text-xs leading-relaxed text-ink-faint">
            Rendering here uses your defaults. Open in Create for takes, seed, planning
            and sampling options.
          </p>
        </Card>
      </div>

      <section className="mt-10" aria-labelledby="studio-history">
        <SectionTitle
          className="mb-4"
          description="Every set of lyrics the writer produced and you used, kept in this browser."
        >
          <span id="studio-history">Earlier lyrics</span>
        </SectionTitle>
        {history.length === 0 ? (
          <EmptyState
            icon={<NotebookPen className="h-6 w-6" aria-hidden="true" />}
            title="Nothing here yet"
            description="Lyrics you take from the writer are kept here, so you can go back to an earlier idea."
          />
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {history.map((item) => (
              <Card key={item.id} className="flex flex-col p-4">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-ink">{item.title || "Untitled"}</p>
                    <p className="mt-0.5 text-xs text-ink-faint">
                      {formatDate(item.at)} · {item.language} · about {formatDuration(item.estimatedSeconds)}
                    </p>
                  </div>
                  <button
                    type="button"
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-ink-faint transition-colors hover:bg-danger/12 hover:text-danger"
                    aria-label={`Remove ${item.title || "these lyrics"} from history`}
                    onClick={() => setHistory((current) => current.filter((entry) => entry.id !== item.id))}
                  >
                    <Trash2 className="h-4 w-4" aria-hidden="true" />
                  </button>
                </div>
                <pre className="mt-3 line-clamp-6 flex-1 whitespace-pre-wrap font-mono text-xs leading-5 text-ink-muted">
                  {item.lyrics}
                </pre>
                <Button
                  size="sm"
                  className="mt-4 self-start"
                  onClick={() => {
                    if (draft.lyrics.trim() && draft.lyrics !== item.lyrics) {
                      setPendingLoad(item);
                      return;
                    }
                    loadItem(item);
                  }}
                >
                  Load into draft
                </Button>
              </Card>
            ))}
          </div>
        )}
      </section>

      <p className="mt-8 text-xs leading-relaxed text-ink-faint">
        The lyrics model and YuE2 share one graphics card, so the model is unloaded
        automatically before every render. Manage it in{" "}
        <Link href="/settings#lyrics-writer" className="font-medium text-accent underline-offset-2 hover:underline">
          Settings
        </Link>
        .
      </p>

      <Dialog
        open={pendingLoad !== null}
        onClose={() => setPendingLoad(null)}
        title="Replace the current draft?"
        description={`“${pendingLoad?.title || "Untitled"}” will replace the title, style and lyrics in the draft. The lyrics you have now stay available under History in the editor.`}
        footer={
          <>
            <Button variant="ghost" onClick={() => setPendingLoad(null)}>
              Keep my draft
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                if (pendingLoad) loadItem(pendingLoad);
                setPendingLoad(null);
              }}
            >
              Replace
            </Button>
          </>
        }
      />
    </div>
  );
}

/** The writer keeps its form in localStorage; read the language it was set to. */
function readWriterLanguage(): string {
  const saved = load<{ language?: string }>("songforge.lyrics-writer.studio", {});
  return saved.language?.trim() || "English";
}
