"use client";

/** A project in the Library, as a grid card or a list row. */
import Link from "next/link";
import * as React from "react";
import {
  Archive,
  ArchiveRestore,
  Copy,
  Download,
  Heart,
  MoreHorizontal,
  Pause,
  Play,
  Trash2,
} from "lucide-react";

import { Artwork } from "@/components/artwork";
import { Badge, Menu, MenuItem, Spinner } from "@/components/ui/primitives";
import * as api from "@/lib/api";
import { useAudio } from "@/lib/audio";
import type { Project, ProjectStatus } from "@/lib/types";
import { cn, formatDuration, formatRelative } from "@/lib/utils";

const STATUS_TONE: Record<
  ProjectStatus,
  "neutral" | "accent" | "success" | "warning" | "danger" | "info"
> = {
  draft: "neutral",
  queued: "info",
  generating: "accent",
  completed: "success",
  failed: "danger",
  cancelled: "warning",
  archived: "neutral",
};

const STATUS_LABEL: Record<ProjectStatus, string> = {
  draft: "Draft",
  queued: "Queued",
  generating: "Generating",
  completed: "Ready",
  failed: "Failed",
  cancelled: "Cancelled",
  archived: "Archived",
};

export interface SongCardProps {
  project: Project;
  view: "grid" | "list";
  selected?: boolean;
  /** True once anything is selected: checkboxes then stay visible. */
  selecting?: boolean;
  onToggleSelect?: () => void;
  onFavourite?: () => void;
  onArchive?: () => void;
  onDuplicate?: () => void;
  onDelete?: () => void;
}

export function SongCard({
  project,
  view,
  selected,
  selecting,
  onToggleSelect,
  onFavourite,
  onArchive,
  onDuplicate,
  onDelete,
}: SongCardProps) {
  const audio = useAudio();
  const hasAudio = project.primary_version !== null && project.duration_seconds != null;
  const track = React.useMemo(
    () => ({
      projectId: project.id,
      version: project.primary_version ?? undefined,
      title: project.title,
      duration: project.duration_seconds,
    }),
    [project.id, project.primary_version, project.title, project.duration_seconds],
  );
  const current = audio.isCurrent(track);
  const playing = current && audio.playing;
  const buffering = current && audio.buffering;
  const working = project.status === "generating" || project.status === "queued";
  // "Ready" is the normal state of a finished song; saying so on every card is
  // noise. The badge is for the states that need a second look.
  const showStatus = project.status !== "completed";

  const menu = (
    <Menu
      label={`Actions for ${project.title}`}
      trigger={(props) => (
        <button
          {...props}
          type="button"
          aria-label={`More actions for ${project.title}`}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-ink-faint transition-colors hover:bg-overlay hover:text-ink"
        >
          <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
        </button>
      )}
    >
      {(close) => (
        <>
          <MenuItem
            icon={<Copy className="h-4 w-4" aria-hidden="true" />}
            onClick={() => {
              close();
              onDuplicate?.();
            }}
          >
            Duplicate
          </MenuItem>
          {hasAudio && (
            <MenuItem
              icon={<Download className="h-4 w-4" aria-hidden="true" />}
              href={api.exportZipUrl(project.id)}
              onClick={close}
            >
              Export .zip
            </MenuItem>
          )}
          <MenuItem
            icon={
              project.archived ? (
                <ArchiveRestore className="h-4 w-4" aria-hidden="true" />
              ) : (
                <Archive className="h-4 w-4" aria-hidden="true" />
              )
            }
            onClick={() => {
              close();
              onArchive?.();
            }}
          >
            {project.archived ? "Restore" : "Archive"}
          </MenuItem>
          <div className="my-1 h-px bg-edge" role="separator" />
          <MenuItem
            danger
            icon={<Trash2 className="h-4 w-4" aria-hidden="true" />}
            onClick={() => {
              close();
              onDelete?.();
            }}
          >
            Delete…
          </MenuItem>
        </>
      )}
    </Menu>
  );

  const favourite = (
    <button
      type="button"
      onClick={(event) => {
        event.preventDefault();
        onFavourite?.();
      }}
      aria-pressed={project.favourite}
      aria-label={
        project.favourite
          ? `Remove ${project.title} from favourites`
          : `Add ${project.title} to favourites`
      }
      className={cn(
        "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-colors hover:bg-overlay",
        project.favourite ? "text-accent" : "text-ink-faint hover:text-ink",
      )}
    >
      <Heart
        className={cn("h-4 w-4", project.favourite && "fill-current")}
        aria-hidden="true"
      />
    </button>
  );

  const checkbox = onToggleSelect && (
    <input
      type="checkbox"
      className="sf-check"
      checked={Boolean(selected)}
      onChange={onToggleSelect}
      aria-label={`Select ${project.title}`}
    />
  );

  const playGlyph = buffering ? (
    <Spinner className="h-5 w-5" />
  ) : playing ? (
    <Pause className="h-5 w-5 fill-current" aria-hidden="true" />
  ) : (
    <Play className="ml-0.5 h-5 w-5 fill-current" aria-hidden="true" />
  );

  const meta = [
    formatRelative(project.created_at),
    project.version_count > 1 ? `${project.version_count} versions` : null,
  ].filter(Boolean);

  if (view === "list") {
    return (
      <div
        className={cn(
          "group flex items-center gap-3 rounded-xl border bg-raised p-2 pr-2.5 transition-colors sm:gap-4",
          selected
            ? "border-accent/70 bg-accent/5"
            : current
              ? "border-accent/40"
              : "border-edge hover:border-edge-strong",
        )}
      >
        {checkbox && <span className="pl-1.5">{checkbox}</span>}

        <div className="relative h-12 w-12 shrink-0">
          <Artwork seed={project.id} bars={9} rounded="rounded-lg" />
          {hasAudio && (
            <button
              type="button"
              onClick={() => audio.play(track)}
              aria-label={playing ? `Pause ${project.title}` : `Play ${project.title}`}
              className={cn(
                // The tile clips its corners; keep the focus ring inside.
                "sf-focus-inset absolute inset-0 flex items-center justify-center rounded-lg bg-black/55 text-white transition-opacity",
                current ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100",
              )}
            >
              {playGlyph}
            </button>
          )}
        </div>

        <div className="min-w-0 flex-1">
          <Link
            href={`/song/${project.id}`}
            className={cn(
              "block truncate text-sm font-medium hover:text-accent",
              current ? "text-accent" : "text-ink",
            )}
          >
            {project.title}
          </Link>
          <p className="truncate text-[13px] text-ink-faint">
            {project.style_prompt || "No style yet"}
          </p>
        </div>

        {showStatus && (
          <Badge
            tone={STATUS_TONE[project.status]}
            dot={working ? "live" : undefined}
            className="hidden shrink-0 sm:inline-flex"
          >
            {STATUS_LABEL[project.status]}
          </Badge>
        )}
        <span className="hidden w-28 shrink-0 truncate text-right text-[13px] text-ink-faint md:block">
          {meta[0]}
        </span>
        <span className="hidden w-12 shrink-0 text-right text-[13px] tabular-nums text-ink-muted sm:block">
          {project.duration_seconds != null ? formatDuration(project.duration_seconds) : ""}
        </span>

        <div className="flex shrink-0 items-center">
          {favourite}
          {menu}
        </div>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "group relative flex flex-col rounded-2xl border bg-raised p-2.5 transition-[border-color,box-shadow,transform] duration-200",
        "shadow-[var(--sf-highlight)] hover:-translate-y-0.5 hover:shadow-[var(--sf-highlight),var(--sf-shadow-md)]",
        selected
          ? "border-accent/70 bg-accent/5"
          : current
            ? "border-accent/45"
            : "border-edge hover:border-edge-strong",
      )}
    >
      <div className="relative aspect-square w-full">
        <Link href={`/song/${project.id}`} tabIndex={-1} aria-hidden="true" className="block h-full w-full">
          <Artwork seed={project.id} />
        </Link>

        {checkbox && (
          <span
            className={cn(
              "absolute left-2 top-2 flex rounded-md bg-black/45 p-1 backdrop-blur-sm transition-opacity",
              selecting || selected
                ? "opacity-100"
                : "opacity-0 focus-within:opacity-100 group-hover:opacity-100",
            )}
          >
            {checkbox}
          </span>
        )}

        {showStatus && (
          <span className="absolute right-2 top-2">
            <Badge
              tone={STATUS_TONE[project.status]}
              dot={working ? "live" : undefined}
              className="border-transparent bg-black/55 backdrop-blur-sm"
            >
              {STATUS_LABEL[project.status]}
            </Badge>
          </span>
        )}

        {project.duration_seconds != null && (
          <span className="absolute bottom-2 left-2 rounded-md bg-black/55 px-1.5 py-0.5 text-xs font-medium tabular-nums text-white backdrop-blur-sm">
            {formatDuration(project.duration_seconds)}
          </span>
        )}

        {hasAudio && (
          <button
            type="button"
            onClick={() => audio.play(track)}
            aria-label={playing ? `Pause ${project.title}` : `Play ${project.title}`}
            className={cn(
              "sf-ember absolute bottom-2 right-2 flex h-11 w-11 items-center justify-center rounded-full",
              "shadow-[0_1px_0_oklch(1_0_0/0.3)_inset,0_8px_20px_-6px_oklch(0_0_0/0.7)]",
              "transition-[opacity,transform] duration-200 hover:scale-105 active:scale-95",
              current
                ? "opacity-100"
                : "translate-y-1 opacity-0 focus-visible:translate-y-0 focus-visible:opacity-100 group-hover:translate-y-0 group-hover:opacity-100",
              // Touch screens have no hover: the button is simply there.
              "[@media(hover:none)]:translate-y-0 [@media(hover:none)]:opacity-100",
            )}
          >
            {playGlyph}
          </button>
        )}

        {project.status === "generating" && (
          <div className="sf-indeterminate absolute inset-x-2 bottom-2 h-1 rounded-full bg-black/50" />
        )}
      </div>

      <div className="flex items-start gap-1 px-1 pb-0.5 pt-3">
        <div className="min-w-0 flex-1">
          <Link
            href={`/song/${project.id}`}
            title={project.title}
            className={cn(
              "flex items-center gap-1.5 text-sm font-medium hover:text-accent",
              current ? "text-accent" : "text-ink",
            )}
          >
            {current && (
              <span className="sf-eq shrink-0" data-paused={!playing} aria-hidden="true">
                <span />
                <span />
                <span />
              </span>
            )}
            <span className="truncate">{project.title}</span>
          </Link>
          <p className="mt-0.5 truncate text-[13px] text-ink-faint" title={project.style_prompt}>
            {project.style_prompt || "No style yet"}
          </p>
          {/* A grid card is narrow: the long form cut "2 versions" to "2 versio...". */}
          <p className="mt-1.5 truncate text-xs text-ink-faint">
            {[formatRelative(project.created_at, "short"), ...meta.slice(1)].join(" · ")}
          </p>
        </div>
        <div className="-mr-1 flex shrink-0 flex-col items-center">
          {favourite}
          {menu}
        </div>
      </div>
    </div>
  );
}
