"use client";

/** Library - the home page: every song, searchable and playable in place. */
import Link from "next/link";
import * as React from "react";
import {
  Archive,
  AudioLines,
  Grid2x2,
  Heart,
  List,
  ListFilter,
  NotebookPen,
  Play,
  Search,
  SearchX,
  Sparkles,
  Tag,
  X,
} from "lucide-react";

import { Artwork } from "@/components/artwork";
import { SongCard } from "@/components/song-card";
import {
  Banner,
  Button,
  buttonClasses,
  Chip,
  Dialog,
  EmptyState,
  Field,
  Input,
  PageHeader,
  Segmented,
  Select,
  Skeleton,
} from "@/components/ui/primitives";
import * as api from "@/lib/api";
import { useAudio } from "@/lib/audio";
import { useStore } from "@/lib/store";
import type { Project, ProjectStatus, SortKey } from "@/lib/types";
import { cn, debounce, pluralize } from "@/lib/utils";

const STATUS_FILTERS: { value: ProjectStatus | "all"; label: string }[] = [
  { value: "all", label: "Any status" },
  { value: "completed", label: "Ready" },
  { value: "generating", label: "Generating" },
  { value: "queued", label: "Queued" },
  { value: "draft", label: "Drafts" },
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

/** Columns grow with the window instead of stepping at breakpoints. */
const GRID =
  "grid gap-3 sm:gap-4 grid-cols-2 sm:grid-cols-[repeat(auto-fill,minmax(12.5rem,1fr))] 2xl:grid-cols-[repeat(auto-fill,minmax(13.5rem,1fr))]";

export default function LibraryPage() {
  const { notify, onJobSettled, settings } = useStore();
  const audio = useAudio();

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
  const [filtersOpen, setFiltersOpen] = React.useState(false);
  const [bulkTagOpen, setBulkTagOpen] = React.useState(false);
  const [bulkTag, setBulkTag] = React.useState("");
  const [favouritesOnly, setFavouritesOnly] = React.useState(false);
  const [archived, setArchived] = React.useState(false);
  // How many songs sit in the archive, so an emptied library can say where
  // they went instead of greeting their owner as a newcomer.
  const [archivedCount, setArchivedCount] = React.useState(0);
  const [sort, setSort] = React.useState<SortKey>("newest");

  const [selected, setSelected] = React.useState<Set<string>>(new Set());
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

  const chooseView = (next: "grid" | "list") => {
    setView(next);
    try {
      localStorage.setItem("songforge.view", next);
    } catch {
      /* not important enough to surface */
    }
  };

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
      try {
        const archive = await api.listProjects({ archived: true, limit: 1 });
        setArchivedCount(archive.total);
      } catch {
        /* only decides which empty state to show; the list above is what matters */
      }
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
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 18);
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
        .filter((p) => p.last_played_at && p.play_count > 0 && p.duration_seconds != null)
        .sort((a, b) => (b.last_played_at ?? "").localeCompare(a.last_played_at ?? ""))
        .slice(0, 8),
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

  const applyBulkTag = async () => {
    const value = bulkTag.trim();
    if (!value || busy) return;
    setBulkTagOpen(false);
    await mutate("Could not tag", async () => {
      // The API replaces the whole tag list, so merge per project.
      for (const project of projects.filter((p) => selected.has(p.id))) {
        if (project.tags.includes(value)) continue;
        await api.updateProject(project.id, { tags: [...project.tags, value] });
      }
      setBulkTag("");
    });
  };

  const moreFilters = (language ? 1 : 0) + (vocal ? 1 : 0) + (archived ? 1 : 0);
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
  const emptyLibrary = !loading && !error && total === 0 && !hasFilters && !archived;
  const allSelected = projects.length > 0 && projects.every((p) => selected.has(p.id));

  return (
    <div className="mx-auto max-w-[110rem]">
      <PageHeader
        title={archived ? "Archive" : "Library"}
        description={
          loading
            ? "Loading your songs…"
            : emptyLibrary
              ? undefined
              : `${total} ${pluralize(total, "song")}${archived ? " archived" : ""}${hasFilters ? " match" : ""}`
        }
        actions={
          <Link href="/create" className={buttonClasses("primary", "md", "lg:hidden")}>
            <Sparkles className="h-4 w-4" aria-hidden="true" />
            New song
          </Link>
        }
      />

      {emptyLibrary && archivedCount > 0 ? (
        // Everything was archived. The welcome screen here would read as "your
        // songs are gone", with the only door to the archive hidden behind it.
        <EmptyState
          icon={<Archive className="h-6 w-6" aria-hidden="true" />}
          title="Your library is empty"
          description={`${archivedCount} ${pluralize(archivedCount, "song")} ${
            archivedCount === 1 ? "is" : "are"
          } in the archive. Nothing was deleted.`}
          action={
            <div className="flex flex-wrap justify-center gap-2">
              <Button variant="primary" onClick={() => setArchived(true)}>
                Open the archive
              </Button>
              <Link href="/create" className={buttonClasses("secondary", "md")}>
                Make a new song
              </Link>
            </div>
          }
        />
      ) : emptyLibrary ? (
        <Welcome mock={settings?.runner_kind === "mock"} />
      ) : (
        <>
          {/* --- Toolbar --- */}
          <div className="mb-5 space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative min-w-[14rem] flex-1">
                <Search
                  className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-faint"
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
                  className="pl-10 pr-9"
                />
                {search && (
                  <button
                    type="button"
                    onClick={() => {
                      setSearch("");
                      setDebouncedSearch("");
                    }}
                    aria-label="Clear search"
                    className="absolute right-1.5 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md text-ink-faint hover:bg-overlay hover:text-ink"
                  >
                    <X className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                )}
              </div>

              <Select
                value={status}
                onChange={(event) => setStatus(event.target.value as ProjectStatus | "all")}
                aria-label="Filter by status"
                className="w-auto min-w-[9.5rem]"
              >
                {STATUS_FILTERS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Select>

              <Select
                value={sort}
                onChange={(event) => setSort(event.target.value as SortKey)}
                aria-label="Sort order"
                className="w-auto min-w-[9.5rem]"
              >
                {SORTS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Select>

              <Button
                variant={favouritesOnly ? "secondary" : "subtle"}
                aria-pressed={favouritesOnly}
                onClick={() => setFavouritesOnly((value) => !value)}
                className={cn(favouritesOnly && "border-accent/60 text-accent")}
              >
                <Heart className={cn("h-4 w-4", favouritesOnly && "fill-current")} aria-hidden="true" />
                <span className="hidden sm:inline">Favourites</span>
              </Button>

              <Button
                variant={moreFilters > 0 ? "secondary" : "subtle"}
                onClick={() => setFiltersOpen(true)}
                className={cn(moreFilters > 0 && "border-accent/60 text-accent")}
              >
                <ListFilter className="h-4 w-4" aria-hidden="true" />
                <span className="hidden sm:inline">Filters</span>
                {moreFilters > 0 && (
                  <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-accent px-1 text-xs font-semibold tabular-nums text-accent-ink">
                    {moreFilters}
                  </span>
                )}
              </Button>

              <Segmented
                label="View"
                value={view}
                onChange={chooseView}
                options={[
                  {
                    value: "grid",
                    label: <span className="sr-only">Grid</span>,
                    icon: <Grid2x2 className="h-4 w-4" aria-hidden="true" />,
                    title: "Grid view",
                  },
                  {
                    value: "list",
                    label: <span className="sr-only">List</span>,
                    icon: <List className="h-4 w-4" aria-hidden="true" />,
                    title: "List view",
                  },
                ]}
              />
            </div>

            {(allTags.length > 0 || hasFilters) && (
              <div className="flex items-center gap-2">
                {allTags.length > 0 && (
                  <>
                    <Tag className="h-3.5 w-3.5 shrink-0 text-ink-faint" aria-hidden="true" />
                    <div
                      className="sf-scroll-x flex min-w-0 flex-1 gap-1.5 py-0.5"
                      role="group"
                      aria-label="Filter by tag"
                    >
                      {allTags.map(([value, count]) => (
                        <Chip
                          key={value}
                          selected={tag === value}
                          onClick={() => setTag(tag === value ? null : value)}
                          className="shrink-0"
                        >
                          {value}
                          <span className="text-xs tabular-nums opacity-60">{count}</span>
                        </Chip>
                      ))}
                    </div>
                  </>
                )}
                {hasFilters && (
                  <Button variant="ghost" size="sm" onClick={clearFilters} className="ml-auto shrink-0">
                    <X className="h-3.5 w-3.5" aria-hidden="true" />
                    Clear filters
                  </Button>
                )}
              </div>
            )}
          </div>

          {/* --- Jump back in --- */}
          {recentlyPlayed.length > 0 && !hasFilters && !archived && (
            <section className="mb-7" aria-labelledby="recent-heading">
              <h2 id="recent-heading" className="mb-3 text-base font-semibold text-ink">
                Jump back in
              </h2>
              <div className="sf-scroll-x -mx-1 flex gap-2.5 px-1 py-1">
                {recentlyPlayed.map((project) => {
                  const track = {
                    projectId: project.id,
                    version: project.primary_version ?? undefined,
                    title: project.title,
                    duration: project.duration_seconds,
                  };
                  const current = audio.isCurrent(track);
                  return (
                    <button
                      key={project.id}
                      type="button"
                      onClick={() => audio.play(track)}
                      aria-label={`Play ${project.title}`}
                      className={cn(
                        "group flex w-56 shrink-0 items-center gap-3 rounded-xl border bg-raised p-2 pr-3 text-left transition-colors",
                        current
                          ? "border-accent/45"
                          : "border-edge hover:border-edge-strong hover:bg-overlay",
                      )}
                    >
                      <span className="relative h-11 w-11 shrink-0">
                        <Artwork seed={project.id} bars={9} rounded="rounded-lg" />
                        <span className="absolute inset-0 flex items-center justify-center rounded-lg bg-black/50 text-white opacity-0 transition-opacity group-hover:opacity-100">
                          <Play className="ml-0.5 h-4 w-4 fill-current" aria-hidden="true" />
                        </span>
                      </span>
                      <span className="min-w-0">
                        <span
                          className={cn(
                            "block truncate text-[13px] font-medium",
                            current ? "text-accent" : "text-ink",
                          )}
                        >
                          {project.title}
                        </span>
                        <span className="block truncate text-xs text-ink-faint">
                          {project.play_count} {pluralize(project.play_count, "play")}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </section>
          )}

          {/* --- Results --- */}
          {error ? (
            <Banner tone="danger" title="Could not load the library">
              {error}
            </Banner>
          ) : loading ? (
            <div className={view === "grid" ? GRID : "space-y-2"}>
              {Array.from({ length: 10 }).map((_, index) => (
                <Skeleton
                  key={index}
                  className={view === "grid" ? "aspect-[4/5] rounded-2xl" : "h-16"}
                />
              ))}
            </div>
          ) : projects.length === 0 ? (
            <EmptyState
              icon={
                archived && !hasFilters ? (
                  <Archive className="h-6 w-6" aria-hidden="true" />
                ) : (
                  <SearchX className="h-6 w-6" aria-hidden="true" />
                )
              }
              title={archived && !hasFilters ? "Nothing archived" : "Nothing matches"}
              description={
                archived && !hasFilters
                  ? "Archived songs are kept out of the library without deleting anything."
                  : "Try a different search term, or clear the filters to see everything."
              }
              action={
                archived && !hasFilters ? (
                  <Button onClick={() => setArchived(false)}>Back to the library</Button>
                ) : (
                  <Button onClick={clearFilters}>Clear filters</Button>
                )
              }
            />
          ) : (
            <div className={view === "grid" ? GRID : "space-y-2"}>
              {projects.map((project) => (
                <SongCard
                  key={project.id}
                  project={project}
                  view={view}
                  selected={selected.has(project.id)}
                  selecting={selected.size > 0}
                  onToggleSelect={() => toggleSelect(project.id)}
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

      {/* --- Bulk actions: floats above the player, never under it --- */}
      {selected.size > 0 && (
        <div
          className="sf-pop pointer-events-none sticky z-30 mt-6 flex justify-center"
          style={{ bottom: "calc(var(--sf-footer, 0px) + 1rem)" }}
        >
          <div
            role="toolbar"
            aria-label="Actions for the selected songs"
            className="sf-glass pointer-events-auto flex max-w-full flex-wrap items-center gap-2 rounded-2xl border border-accent/50 p-2 pl-4 shadow-[var(--sf-shadow-lg)]"
          >
            <span className="text-sm font-medium text-ink">{selected.size} selected</span>
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                setSelected(allSelected ? new Set() : new Set(projects.map((p) => p.id)))
              }
            >
              {allSelected ? "Select none" : "Select all"}
            </Button>
            <span className="mx-1 hidden h-5 w-px bg-edge-strong sm:block" aria-hidden="true" />
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
              Export .zip
            </a>
            <Button size="sm" variant="danger" onClick={() => setConfirmBulk(true)}>
              Delete…
            </Button>
            <Button
              size="icon"
              variant="ghost"
              className="h-8 w-8"
              onClick={() => setSelected(new Set())}
              aria-label="Clear selection"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </Button>
          </div>
        </div>
      )}

      {/* --- More filters --- */}
      <Dialog
        open={filtersOpen}
        onClose={() => setFiltersOpen(false)}
        title="Filters"
        description="Narrow the library by the language and voice a song was made with."
        footer={
          <>
            <Button
              variant="ghost"
              onClick={() => {
                setLanguage(null);
                setVocal(null);
                setArchived(false);
              }}
              disabled={moreFilters === 0}
            >
              Reset
            </Button>
            <Button variant="primary" onClick={() => setFiltersOpen(false)}>
              Show results
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Field label="Language" htmlFor="filter-language">
            <Select
              id="filter-language"
              value={language ?? ""}
              onChange={(event) => setLanguage(event.target.value || null)}
            >
              <option value="">All languages</option>
              {languages.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Vocal type" htmlFor="filter-vocal">
            <Select
              id="filter-vocal"
              value={vocal ?? ""}
              onChange={(event) => setVocal(event.target.value || null)}
              disabled={vocals.length === 0}
            >
              <option value="">
                {vocals.length === 0 ? "No vocal types set yet" : "Any vocal type"}
              </option>
              {vocals.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Show" htmlFor="filter-archive">
            <Select
              id="filter-archive"
              value={archived ? "archived" : "active"}
              onChange={(event) => setArchived(event.target.value === "archived")}
            >
              <option value="active">Songs in the library</option>
              <option value="archived">Archived songs</option>
            </Select>
          </Field>
        </div>
      </Dialog>

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
                  if (audio.track?.projectId === target.id) audio.close();
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
                  for (const id of selected) {
                    if (audio.track?.projectId === id) audio.close();
                    await api.deleteProject(id);
                  }
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
              onClick={() => void applyBulkTag()}
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
            // One field, one answer: Enter is the obvious way to finish.
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                event.preventDefault();
                void applyBulkTag();
              }
            }}
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

/** The first screen a new install shows: what this is, and the three steps. */
function Welcome({ mock }: { mock: boolean }) {
  const steps = [
    {
      icon: Sparkles,
      title: "Describe it",
      body: "Pick a genre and a mood, or type the sound you hear in your head.",
    },
    {
      icon: NotebookPen,
      title: "Add the words",
      body: "Write your own lyrics, start from a template, or go instrumental.",
    },
    {
      icon: AudioLines,
      title: "Forge the song",
      body: "YuE2 writes a score, then performs it. A full song takes a few minutes.",
    },
  ];
  return (
    <div className="sf-card relative overflow-hidden px-6 py-12 sm:px-12 sm:py-16">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -right-24 -top-24 h-80 w-80 rounded-full opacity-25 blur-3xl"
        style={{ backgroundImage: "var(--sf-ember)" }}
      />
      <div className="relative max-w-3xl">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-accent">
          Welcome to SongForge
        </p>
        <h2 className="mt-3 text-3xl font-semibold leading-[1.1] text-ink sm:text-[2.6rem]">
          Full songs, made on <span className="sf-ember-text">your own machine</span>.
        </h2>
        <p className="mt-4 max-w-xl text-base leading-relaxed text-ink-muted">
          Vocals, instruments and structure from a description and a lyric sheet.
          Everything runs locally — nothing you write or generate leaves this computer.
        </p>
        <div className="mt-7 flex flex-wrap gap-3">
          <Link href="/create" className={buttonClasses("primary", "lg")}>
            <Sparkles className="h-[1.1rem] w-[1.1rem]" aria-hidden="true" />
            Create your first song
          </Link>
          <Link href="/learn" className={buttonClasses("secondary", "lg")}>
            How it works
          </Link>
        </div>
        {mock && (
          <p className="mt-5 text-[13px] text-ink-faint">
            Simulation mode is on: songs you make now are placeholder tones, so you can
            try the app before the model is installed.
          </p>
        )}
      </div>

      <ol className="relative mt-12 grid gap-4 sm:grid-cols-3">
        {steps.map((step, index) => (
          <li key={step.title} className="rounded-xl border border-edge bg-sunken/60 p-5">
            <div className="flex items-center gap-3">
              <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-overlay text-accent">
                <step.icon className="h-[1.1rem] w-[1.1rem]" aria-hidden="true" />
              </span>
              <span className="text-xs font-semibold uppercase tracking-[0.14em] text-ink-faint">
                Step {index + 1}
              </span>
            </div>
            <h3 className="mt-4 text-base font-semibold text-ink">{step.title}</h3>
            <p className="mt-1 text-[13px] leading-relaxed text-ink-muted">{step.body}</p>
          </li>
        ))}
      </ol>
    </div>
  );
}
