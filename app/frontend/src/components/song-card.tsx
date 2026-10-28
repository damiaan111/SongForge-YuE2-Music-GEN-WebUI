"use client";

/** A project in the Library, in grid or list form. */
import Link from "next/link";
import * as React from "react";
import {
  Archive,
  Copy,
  Download,
  Heart,
  ListMusic,
  MoreHorizontal,
  Music4,
  Pause,
  Play,
  Trash2,
} from "lucide-react";

import { Badge, Button } from "@/components/ui/primitives";
import * as api from "@/lib/api";
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
  duration?: number | null;
  playing?: boolean;
  selected?: boolean;
  selectable?: boolean;
  onPlay?: () => void;
  onToggleSelect?: () => void;
  onFavourite?: () => void;
  onArchive?: () => void;
  onDuplicate?: () => void;
  onDelete?: () => void;
}

export function SongCard({
  project,
  view,
  duration,
  playing,
  selected,
  selectable,
  onPlay,
  onToggleSelect,
  onFavourite,
  onArchive,
  onDuplicate,
  onDelete,
}: SongCardProps) {
  const [menuOpen, setMenuOpen] = React.useState(false);
  const menuRef = React.useRef<HTMLDivElement>(null);
  const menuTriggerRef = React.useRef<HTMLButtonElement>(null);
  const hasAudio = project.primary_version !== null || project.version_count > 0;

  React.useEffect(() => {
    if (!menuOpen) return;
    const close = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    // A keyboard user who opens this menu must be able to leave it.
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setMenuOpen(false);
      menuTriggerRef.current?.focus();
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  // Generated cover art was removed. A typographic tile keeps the cards
  // distinguishable at a glance and still carries the play overlay, the
  // selection checkbox and the "generating" shimmer that layer over it.
  const initials = project.title.trim().slice(0, 2).toUpperCase();
  const hue = [...project.id].reduce((total, ch) => (total * 31 + ch.charCodeAt(0)) % 360, 7);
  const tile = (size: "sm" | "lg") => (
    <div
      className="flex h-full w-full items-center justify-center bg-[var(--sf-bg-overlay)]"
      style={{
        backgroundImage: `linear-gradient(135deg, oklch(0.30 0.05 ${hue}), oklch(0.20 0.03 ${(hue + 50) % 360}))`,
      }}
    >
      {initials ? (
        <span
          aria-hidden="true"
          className={cn(
            "font-semibold tracking-wide text-white/75",
            size === "sm" ? "text-xs" : "text-3xl",
          )}
        >
          {initials}
        </span>
      ) : (
        <Music4
          className={cn("text-[var(--sf-text-faint)]", size === "sm" ? "h-4 w-4" : "h-8 w-8")}
          aria-hidden="true"
        />
      )}
    </div>
  );

  const overflow = (
    <div className="relative" ref={menuRef}>
      <Button
        ref={menuTriggerRef}
        variant="ghost"
        size="icon"
        className="h-7 w-7"
        onClick={(event) => {
          event.preventDefault();
          setMenuOpen((value) => !value);
        }}
        aria-label={`More actions for ${project.title}`}
        aria-expanded={menuOpen}
        aria-haspopup="menu"
      >
        <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
      </Button>
      {menuOpen && (
        <div
          role="menu"
          className="absolute right-0 top-8 z-20 w-44 overflow-hidden rounded-lg border border-[var(--sf-border-strong)] bg-[var(--sf-bg-raised)] py-1 shadow-xl"
        >
          <MenuItem
            icon={Copy}
            label="Duplicate"
            onClick={() => {
              setMenuOpen(false);
              onDuplicate?.();
            }}
          />
          {hasAudio && (
            <a
              role="menuitem"
              href={api.exportZipUrl(project.id)}
              onClick={() => setMenuOpen(false)}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-[var(--sf-text-muted)] hover:bg-[var(--sf-bg-overlay)] hover:text-[var(--sf-text)]"
            >
              <Download className="h-3.5 w-3.5" aria-hidden="true" />
              Export .zip
            </a>
          )}
          <MenuItem
            icon={Archive}
            label={project.archived ? "Restore" : "Archive"}
            onClick={() => {
              setMenuOpen(false);
              onArchive?.();
            }}
          />
          <MenuItem
            icon={Trash2}
            label="Delete…"
            danger
            onClick={() => {
              setMenuOpen(false);
              onDelete?.();
            }}
          />
        </div>
      )}
    </div>
  );

  const meta = (
    <>
      <Badge tone={STATUS_TONE[project.status]}>{STATUS_LABEL[project.status]}</Badge>
      {project.version_count > 0 && (
        <span className="text-[11px] text-[var(--sf-text-faint)]">
          v{project.latest_version}
        </span>
      )}
      {duration != null && (
        <span className="text-[11px] tabular-nums text-[var(--sf-text-faint)]">
          {formatDuration(duration)}
        </span>
      )}
    </>
  );

  if (view === "list") {
    return (
      <div
        className={cn(
          "group flex items-center gap-3 rounded-lg border border-[var(--sf-border)] bg-[var(--sf-bg-raised)] p-2.5 transition-colors hover:border-[var(--sf-border-strong)]",
          selected && "border-[var(--sf-accent)]",
        )}
      >
        {selectable && (
          <input
            type="checkbox"
            checked={Boolean(selected)}
            onChange={onToggleSelect}
            aria-label={`Select ${project.title}`}
            className="h-4 w-4 shrink-0 accent-[var(--sf-accent)]"
          />
        )}
        <div className="relative h-11 w-11 shrink-0 overflow-hidden rounded-md">
          {tile("sm")}
          {hasAudio && (
            <button
              type="button"
              onClick={onPlay}
              aria-label={playing ? `Pause ${project.title}` : `Play ${project.title}`}
              className="absolute inset-0 flex items-center justify-center bg-black/50 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
            >
              {playing ? (
                <Pause className="h-4 w-4 text-white" aria-hidden="true" />
              ) : (
                <Play className="ml-0.5 h-4 w-4 text-white" aria-hidden="true" />
              )}
            </button>
          )}
        </div>

        <div className="min-w-0 flex-1">
          <Link
            href={`/song/${project.id}`}
            className="block truncate text-sm font-medium hover:text-[var(--sf-accent)]"
          >
            {project.title}
          </Link>
          <p className="truncate text-xs text-[var(--sf-text-faint)]">
            {project.style_prompt || "No style prompt"}
          </p>
        </div>

        <div className="hidden shrink-0 items-center gap-2 sm:flex">{meta}</div>
        <span className="hidden w-20 shrink-0 text-right text-[11px] text-[var(--sf-text-faint)] md:block">
          {formatRelative(project.created_at)}
        </span>

        <FavouriteButton project={project} onFavourite={onFavourite} />
        {overflow}
      </div>
    );
  }

  return (
    <div
      className={cn(
        "group overflow-hidden rounded-xl border border-[var(--sf-border)] bg-[var(--sf-bg-raised)] transition-colors hover:border-[var(--sf-border-strong)]",
        selected && "border-[var(--sf-accent)]",
      )}
    >
      <div className="relative aspect-square w-full overflow-hidden">
        {tile("lg")}
        {selectable && (
          <input
            type="checkbox"
            checked={Boolean(selected)}
            onChange={onToggleSelect}
            aria-label={`Select ${project.title}`}
            className="absolute left-2 top-2 h-4 w-4 accent-[var(--sf-accent)]"
          />
        )}
        {hasAudio && (
          <button
            type="button"
            onClick={onPlay}
            aria-label={playing ? `Pause ${project.title}` : `Play ${project.title}`}
            className="absolute inset-0 flex items-center justify-center bg-black/45 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
          >
            <span className="flex h-12 w-12 items-center justify-center rounded-full bg-[var(--sf-accent)]">
              {playing ? (
                <Pause className="h-5 w-5 text-[var(--sf-accent-ink)]" aria-hidden="true" />
              ) : (
                <Play className="ml-0.5 h-5 w-5 text-[var(--sf-accent-ink)]" aria-hidden="true" />
              )}
            </span>
          </button>
        )}
        {project.status === "generating" && (
          <div className="absolute inset-x-0 bottom-0 h-1 bg-[var(--sf-bg-overlay)]">
            <div className="sf-shimmer h-full w-full" />
          </div>
        )}
      </div>

      <div className="p-3">
        <div className="flex items-start justify-between gap-2">
          <Link
            href={`/song/${project.id}`}
            className="min-w-0 flex-1 truncate text-sm font-medium hover:text-[var(--sf-accent)]"
          >
            {project.title}
          </Link>
          <div className="flex shrink-0 items-center">
            <FavouriteButton project={project} onFavourite={onFavourite} />
            {overflow}
          </div>
        </div>
        <p className="mt-0.5 line-clamp-1 text-xs text-[var(--sf-text-faint)]">
          {project.style_prompt || "No style prompt"}
        </p>
        <div className="mt-2.5 flex flex-wrap items-center gap-2">{meta}</div>
      </div>
    </div>
  );
}

function FavouriteButton({
  project,
  onFavourite,
}: {
  project: Project;
  onFavourite?: () => void;
}) {
  return (
    <Button
      variant="ghost"
      size="icon"
      className="h-7 w-7"
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
    >
      <Heart
        className={cn(
          "h-4 w-4",
          project.favourite
            ? "fill-[var(--sf-accent)] text-[var(--sf-accent)]"
            : "text-[var(--sf-text-faint)]",
        )}
        aria-hidden="true"
      />
    </Button>
  );
}

function MenuItem({
  icon: Icon,
  label,
  onClick,
  danger,
}: {
  icon: typeof ListMusic;
  label: string;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2 px-3 py-2 text-left text-xs hover:bg-[var(--sf-bg-overlay)]",
        danger
          ? "text-[var(--sf-danger)]"
          : "text-[var(--sf-text-muted)] hover:text-[var(--sf-text)]",
      )}
    >
      <Icon className="h-3.5 w-3.5" aria-hidden="true" />
      {label}
    </button>
  );
}
