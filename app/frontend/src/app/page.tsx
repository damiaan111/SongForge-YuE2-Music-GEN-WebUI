"use client";

/** Library - the home page once any project exists. */
import Link from "next/link";
import * as React from "react";
import {
  Grid2x2,
  Heart,
  List,
  Music4,
  Search,
  Sparkles,
  X,
} from "lucide-react";

import { Player } from "@/components/player";
import { SongCard } from "@/components/song-card";
import {
  Button,
  buttonClasses,
  Chip,
  Dialog,
  EmptyState,
  Field,
  Input,
  Select,
  Skeleton,
} from "@/components/ui/primitives";
import * as api from "@/lib/api";
import { useStore } from "@/lib/store";
import type { Project, ProjectStatus, SortKey } from "@/lib/types";
import { cn, debounce, pluralize } from "@/lib/utils";

const STATUS_FILTERS: { value: ProjectStatus | "all"; label: string }[] = [
  { value: "all", label: "All" },
  { value: "draft", label: "Drafts" },
  { value: "queued", label: "Queued" },
  { value: "generating", label: "Generating" },
  { value: "completed", label: "Ready" },
  { value: "failed", label: "Failed" },
  { value: "cancelled", label: "Cancelled" },
];

const SORTS: { value: SortKey; label: string }[] = [
  { value: "newest", label: "Newest first" },
  { value: "oldest", label: "Oldest first" },
  { value: "alphabetical", label: "A – Z" },
  { value: "duration", label: "Longest" },
  { value: "most_played", label: "Most played" },
];

export default function LibraryPage() {
  const { notify, onJobSettled } = useStore();

  const [projects, setProjects] = React.useState<Project[]>([]);
  const [total, setTotal] = React.useState(0);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  const [view, setView] = React.useState<"grid" | "list">("grid");
  const [search, setSearch] = React.useState("");
  const [debouncedSearch, setDebouncedSearch] = React.useState("");
  const [status, setStatus] = React.useState<ProjectStatus | "all">("all");
  const [tag, setTag] = React.useState<string | null>(null);
  const [language, setLanguage] = React.useState<string | null>(null);
  const [vocal, setVocal] = React.useState<string | null>(null);
  const [bulkTagOpen, setBulkTagOpen] = React.useState(false);
  const [bulkTag, setBulkTag] = React.useState("");
  const [favouritesOnly, setFavouritesOnly] = React.useState(false);
  const [archived, setArchived] = React.useState(false);
  const [sort, setSort] = React.useState<SortKey>("newest");

  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [nowPlaying, setNowPlaying] = React.useState<Project | null>(null);
  const [confirmDelete, setConfirmDelete] = React.useState<Project | null>(null);
  const [confirmBulk, setConfirmBulk] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  // Restore the view preference; it is a per-browser convenience only.
  React.useEffect(() => {
    try {
      const stored = localStorage.getItem("songforge.view");
      // localStorage cannot be read during render or in a lazy initialiser
      // without breaking hydration, so a stored preference is restored after
      // mount. One extra render, once.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (stored === "grid" || stored === "list") setView(stored);
    } catch {
      /* private windows can throw on storage access */
    }
  }, []);

  React.useEffect(() => {
    try {
      localStorage.setItem("songforge.view", view);
    } catch {
      /* not important enough to surface */
    }
  }, [view]);

  const applySearch = React.useMemo(
    () => debounce((value: string) => setDebouncedSearch(value), 250),
    [],
  );

  const load = React.useCallback(async () => {
    try {
      const result = await api.listProjects({
        search: debouncedSearch,
        status: status === "all" ? undefined : status,
        tag: tag ?? undefined,
        language: language ?? undefined,
        vocal: vocal ?? undefined,
        favourite: favouritesOnly ? true : undefined,
        archived,
        sort,
        limit: 120,
      });
      setProjects(result.items);
      setTotal(result.total);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [debouncedSearch, status, tag, language, vocal, favouritesOnly, archived, sort]);

  React.useEffect(() => {
    // The state is set after an await inside load(); the rule cannot see across
    // the async boundary, so there is no synchronous cascade to avoid here.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  // Refresh when any job finishes, so a finished song appears without a reload.
  React.useEffect(() => onJobSettled(() => void load()), [onJobSettled, load]);

  const allTags = React.useMemo(() => {
    const counts = new Map<string, number>();
    for (const project of projects) {
      for (const value of project.tags) {
        counts.set(value, (counts.get(value) ?? 0) + 1);
      }
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14);
  }, [projects]);

  // Facets offered are the values present in the library, never a fixed list.
  // The active selection stays listed even when it is the only value left.
  const facetValues = (pick: (project: Project) => string | null, active: string | null) => {
    const values = new Set<string>();
    for (const project of projects) {
      const value = pick(project)?.trim();
      if (value) values.add(value);
    }
    if (active) values.add(active);
    return [...values].sort((a, b) => a.localeCompare(b));
  };
  const languages = facetValues((project) => project.language, language);
  const vocals = facetValues((project) => project.vocal_preference, vocal);

  const recentlyPlayed = React.useMemo(
    () =>
      projects
        .filter((p) => p.last_played_at && p.play_count > 0)
        .sort((a, b) => (b.last_played_at ?? "").localeCompare(a.last_played_at ?? ""))
        .slice(0, 6),
    [projects],
  );

  const toggleSelect = (id: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const mutate = async (label: string, action: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await action();
      await load();
    } catch (cause) {
      notify({
        tone: "danger",
        title: label,
        body: cause instanceof Error ? cause.message : String(cause),
      });
    } finally {
      setBusy(false);
    }
  };

  const hasFilters =
    Boolean(debouncedSearch) ||
    status !== "all" ||
    tag !== null ||
    language !== null ||
    vocal !== null ||
    favouritesOnly;

  const clearFilters = () => {
    setSearch("");
    setDebouncedSearch("");
    setStatus("all");
    setTag(null);
    setLanguage(null);
    setVocal(null);
    setFavouritesOnly(false);
  };

  // A genuinely empty library, as opposed to filters matching nothing.
  const emptyLibrary = !loading && total === 0 && !hasFilters && !archived;

  return (
    <div className="mx-auto max-w-7xl">
      <header className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Library</h1>
          <p className="mt-0.5 text-sm text-[var(--sf-text-muted)]">
            {loading
              ? "Loading…"
              : `${total} ${pluralize(total, "song")}${archived ? " archived" : ""}`}
          </p>
        </div>
        <Link href="/create" className={buttonClasses("primary", "md", "gap-2")}>
          <Sparkles className="h-4 w-4" aria-hidden="true" />
          New song
        </Link>
      </header>

      {emptyLibrary ? (
        <EmptyState
          icon={<Music4 className="h-10 w-10" aria-hidden="true" />}
          title="No songs yet"
          description="Describe a song, add lyrics, and SongForge will generate it on your own GPU. Nothing leaves this machine."
          action={
            <Link href="/create" className={buttonClasses("primary", "lg", "gap-2")}>
              <Sparkles className="h-4 w-4" aria-hidden="true" />
              Create your first song
            </Link>
          }
        />
      ) : (
        <>
          {/* --- Controls --- */}
          <div className="mb-4 space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative min-w-52 flex-1">
                <Search
                  className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--sf-text-faint)]"
                  aria-hidden="true"
                />
                <Input
                  value={search}
                  onChange={(event) => {
                    setSearch(event.target.value);
                    applySearch(event.target.value);
                  }}
                  placeholder="Search titles, styles and lyrics"
                  aria-label="Search songs"
                  className="pl-9"
                />
              </div>

              <Select
                value={sort}
                onChange={(event) => setSort(event.target.value as SortKey)}
                aria-label="Sort order"
                className="w-40"
              >
                {SORTS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Select>

              <div
                className="flex overflow-hidden rounded-lg border border-[var(--sf-border)]"
                role="group"
                aria-label="View"
              >
                {(["grid", "list"] as const).map((mode) => {
                  const Icon = mode === "grid" ? Grid2x2 : List;
                  return (
                    <button
                      key={mode}
                      type="button"
                      onClick={() => setView(mode)}
                      aria-pressed={view === mode}
                      aria-label={`${mode} view`}
                      className={cn(
                        "px-2.5 py-2",
                        view === mode
                          ? "bg-[var(--sf-bg-overlay)] text-[var(--sf-text)]"
                          : "text-[var(--sf-text-muted)] hover:text-[var(--sf-text)]",
                      )}
                    >
                      <Icon className="h-4 w-4" aria-hidden="true" />
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-1.5">
              {STATUS_FILTERS.map((filter) => (
                <Chip
                  key={filter.value}
                  selected={status === filter.value}
                  onClick={() => setStatus(filter.value)}
                >
                  {filter.label}
                </Chip>
              ))}
              <span className="mx-1 h-4 w-px bg-[var(--sf-border)]" aria-hidden="true" />
              <Chip selected={favouritesOnly} onClick={() => setFavouritesOnly((v) => !v)}>
                <Heart className="h-3 w-3" aria-hidden="true" /> Favourites
              </Chip>
              <Chip selected={archived} onClick={() => setArchived((v) => !v)}>
                Archived
              </Chip>
              {hasFilters && (
                <Button variant="ghost" size="sm" onClick={clearFilters}>
                  <X className="h-3 w-3" aria-hidden="true" />
                  Clear
                </Button>
              )}
            </div>

            {(languages.length > 1 || language || vocals.length > 0) && (
              <div className="flex flex-wrap items-center gap-2">
                {(languages.length > 1 || language) && (
                  <Select
                    value={language ?? ""}
                    onChange={(event) => setLanguage(event.target.value || null)}
                    aria-label="Filter by language"
                    className="h-8 w-44 py-1 text-xs"
                  >
                    <option value="">All languages</option>
                    {languages.map((value) => (
                      <option key={value} value={value}>
                        {value}
                      </option>
                    ))}
                  </Select>
                )}
                {vocals.length > 0 && (
                  <Select
                    value={vocal ?? ""}
                    onChange={(event) => setVocal(event.target.value || null)}
                    aria-label="Filter by vocal type"
                    className="h-8 w-52 py-1 text-xs"
                  >
                    <option value="">Any vocal type</option>
                    {vocals.map((value) => (
                      <option key={value} value={value}>
                        {value}
                      </option>
                    ))}
                  </Select>
                )}
              </div>
            )}

            {allTags.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-[11px] text-[var(--sf-text-faint)]">Tags</span>
                {allTags.map(([value, count]) => (
                  <Chip
                    key={value}
                    selected={tag === value}
                    onClick={() => setTag(tag === value ? null : value)}
                  >
                    {value}
                    <span className="text-[var(--sf-text-faint)]">{count}</span>
                  </Chip>
                ))}
              </div>
            )}
          </div>

          {/* --- Bulk actions --- */}
          {selected.size > 0 && (
            <div className="mb-4 flex flex-wrap items-center gap-2 rounded-lg border border-[var(--sf-accent)] bg-[var(--sf-accent)]/10 px-3 py-2">
              <span className="text-sm">
                {selected.size} selected
              </span>
              <div className="ml-auto flex flex-wrap gap-2">
                <Button
                  size="sm"
                  loading={busy}
                  onClick={() =>
                    mutate("Could not archive", async () => {
                      for (const id of selected) await api.archiveProject(id, !archived);
                      setSelected(new Set());
                    })
                  }
                >
                  {archived ? "Restore" : "Archive"}
                </Button>
                <Button size="sm" onClick={() => setBulkTagOpen(true)}>
                  Tag…
                </Button>
                <a
                  href={api.bulkExportZipUrl([...selected])}
                  className={buttonClasses("secondary", "sm")}
                  download
                >
                  Export ZIP
                </a>
                <Button size="sm" variant="danger" onClick={() => setConfirmBulk(true)}>
                  Delete…
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
                  Cancel
                </Button>
              </div>
            </div>
          )}

          {/* --- Recently played --- */}
          {recentlyPlayed.length > 0 && !hasFilters && (
            <section className="mb-6" aria-label="Recently played">
              <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-[var(--sf-text-faint)]">
                Recently played
              </h2>
              <div className="flex gap-2 overflow-x-auto pb-1">
                {recentlyPlayed.map((project) => (
                  <Link
                    key={project.id}
                    href={`/song/${project.id}`}
                    className="flex shrink-0 items-center gap-2 rounded-lg border border-[var(--sf-border)] bg-[var(--sf-bg-raised)] p-2 pr-3 hover:border-[var(--sf-border-strong)]"
                  >
                    <span className="max-w-44 truncate text-xs">{project.title}</span>
                  </Link>
                ))}
              </div>
            </section>
          )}

          {/* --- Results --- */}
          {error ? (
            <p className="rounded-lg border border-[var(--sf-danger)] p-4 text-sm text-[var(--sf-danger)]">
              {error}
            </p>
          ) : loading ? (
            <div
              className={cn(
                view === "grid"
                  ? "grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5"
                  : "space-y-2",
              )}
            >
              {Array.from({ length: 10 }).map((_, index) => (
                <Skeleton
                  key={index}
                  className={view === "grid" ? "aspect-[4/5]" : "h-16"}
                />
              ))}
            </div>
          ) : projects.length === 0 ? (
            <EmptyState
              title="Nothing matches those filters"
              description="Try a different search term, or clear the filters to see everything."
              action={
                <Button onClick={clearFilters}>Clear filters</Button>
              }
            />
          ) : (
            <div
              className={cn(
                view === "grid"
                  ? "grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5"
                  : "space-y-2",
              )}
            >
              {projects.map((project) => (
                <SongCard
                  key={project.id}
                  project={project}
                  view={view}
                  duration={project.duration_seconds}
                  selectable
                  selected={selected.has(project.id)}
                  playing={nowPlaying?.id === project.id}
                  onToggleSelect={() => toggleSelect(project.id)}
                  onPlay={() =>
                    setNowPlaying((current) =>
                      current?.id === project.id ? null : project,
                    )
                  }
                  onFavourite={() =>
                    mutate("Could not update favourite", () =>
                      api.updateProject(project.id, { favourite: !project.favourite }),
                    )
                  }
                  onArchive={() =>
                    mutate("Could not archive", () =>
                      api.archiveProject(project.id, !project.archived),
                    )
                  }
                  onDuplicate={() =>
                    mutate("Could not duplicate", () => api.duplicateProject(project.id))
                  }
                  onDelete={() => setConfirmDelete(project)}
                />
              ))}
            </div>
          )}
        </>
      )}

      {/* --- Docked player --- */}
      {nowPlaying && (
        <div className="fixed inset-x-0 bottom-14 z-30 border-t border-[var(--sf-border)] bg-[var(--sf-bg-raised)]/95 p-3 backdrop-blur lg:bottom-0 lg:left-60">
          <div className="mx-auto flex max-w-5xl items-center gap-3">
            <div className="min-w-0 flex-1">
              <p className="mb-1 truncate text-xs font-medium">{nowPlaying.title}</p>
              <Player
                projectId={nowPlaying.id}
                version={nowPlaying.primary_version ?? undefined}
                title={nowPlaying.title}
                compact
                className="border-0 bg-transparent p-0"
              />
            </div>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setNowPlaying(null)}
              aria-label="Close player"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </Button>
          </div>
        </div>
      )}

      {/* --- Confirmations --- */}
      <Dialog
        open={confirmDelete !== null}
        onClose={() => setConfirmDelete(null)}
        title={`Delete “${confirmDelete?.title ?? ""}”?`}
        description="This permanently removes the project, every version and all its audio files from disk. It cannot be undone."
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmDelete(null)}>
              Keep it
            </Button>
            <Button
              variant="danger"
              loading={busy}
              onClick={async () => {
                const target = confirmDelete;
                setConfirmDelete(null);
                if (target) {
                  await mutate("Could not delete", () => api.deleteProject(target.id));
                }
              }}
            >
              Delete permanently
            </Button>
          </>
        }
      />

      <Dialog
        open={confirmBulk}
        onClose={() => setConfirmBulk(false)}
        title={`Delete ${selected.size} ${pluralize(selected.size, "song")}?`}
        description="This permanently removes every selected project and all their audio from disk. It cannot be undone."
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmBulk(false)}>
              Keep them
            </Button>
            <Button
              variant="danger"
              loading={busy}
              onClick={async () => {
                setConfirmBulk(false);
                await mutate("Could not delete", async () => {
                  for (const id of selected) await api.deleteProject(id);
                  setSelected(new Set());
                });
              }}
            >
              Delete permanently
            </Button>
          </>
        }
      />

      <Dialog
        open={bulkTagOpen}
        onClose={() => setBulkTagOpen(false)}
        title={`Tag ${selected.size} ${pluralize(selected.size, "song")}`}
        description="Adds the tag to every selected song. Existing tags are kept."
        footer={
          <>
            <Button variant="ghost" onClick={() => setBulkTagOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              loading={busy}
              disabled={!bulkTag.trim()}
              onClick={async () => {
                const value = bulkTag.trim();
                setBulkTagOpen(false);
                await mutate("Could not tag", async () => {
                  // The API replaces the whole tag list, so merge per project.
                  for (const project of projects.filter((p) => selected.has(p.id))) {
                    if (project.tags.includes(value)) continue;
                    await api.updateProject(project.id, { tags: [...project.tags, value] });
                  }
                  setBulkTag("");
                });
              }}
            >
              Add tag
            </Button>
          </>
        }
      >
        <Field label="Tag" htmlFor="bulk-tag" hint="Up to 40 characters.">
          <Input
            id="bulk-tag"
            value={bulkTag}
            maxLength={40}
            onChange={(event) => setBulkTag(event.target.value)}
            placeholder="e.g. demo, favourite-takes"
            list="bulk-tag-options"
          />
        </Field>
        <datalist id="bulk-tag-options">
          {allTags.map(([value]) => (
            <option key={value} value={value} />
          ))}
        </datalist>
      </Dialog>
    </div>
  );
}
