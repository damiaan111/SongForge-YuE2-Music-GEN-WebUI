"use client";

/**
 * Files tab.
 *
 * Only files that genuinely exist are offered: the backend reports has_flac /
 * has_mp3 / has_wav from what is actually on disk, so nothing here is a link
 * that would 404.
 */
import * as React from "react";
import { Download, FileArchive } from "lucide-react";

import { Badge, Card, buttonClasses } from "@/components/ui/primitives";
import * as api from "@/lib/api";
import { useStore } from "@/lib/store";
import type { DownloadKey, ProjectDetail, Version } from "@/lib/types";

interface Entry {
  key: DownloadKey;
  label: string;
  description: string;
  available: boolean;
  badge?: string;
}

export function FilesTab({
  project,
  version,
}: {
  project: ProjectDetail;
  version: Version | undefined;
}) {
  const { settings } = useStore();

  if (!version) {
    return (
      <Card className="p-6 text-center text-sm text-[var(--sf-text-muted)]">
        Generate a version to see its files.
      </Card>
    );
  }

  const hasScore = Boolean(version.score_abc);
  const receipt = version.result ?? {};

  const audio: Entry[] = [
    {
      key: "flac",
      label: "song.flac",
      description: "Lossless master, 24-bit / 48 kHz",
      available: version.has_flac,
      badge: "Master",
    },
    {
      key: "mp3",
      label: "song.mp3",
      description: settings?.ffmpeg_available
        ? `Compressed, ${settings.mp3_bitrate} kbps`
        : "Needs FFmpeg",
      available: version.has_mp3,
    },
    {
      key: "wav",
      label: "song.wav",
      description: "Uncompressed",
      available: version.has_wav,
    },
  ];

  const symbolic: Entry[] = [
    {
      key: "score",
      label: "score.abc",
      description: "The symbolic score, editable and re-renderable",
      available: hasScore,
    },
    {
      key: "plan",
      label: "plan.json",
      description: "The planner's full output",
      available: Boolean(receipt.identity) || hasScore,
    },
  ];

  const provenance: Entry[] = [
    {
      key: "request",
      label: "request.json",
      description: "Exactly what was asked of the model",
      available: true,
    },
    {
      key: "result",
      label: "result.json",
      description: "Timing, truncation and weight checksums",
      available: Boolean(receipt.identity ?? receipt.timing),
    },
    {
      key: "config",
      label: "config.json",
      description: "The effective generation configuration",
      available: Boolean(receipt.identity),
    },
    {
      key: "metadata",
      label: "metadata.json",
      description: "SongForge's own record of this version",
      available: true,
    },
    {
      key: "command",
      label: "runner-command.txt",
      description: "The exact command that produced this version",
      available: Boolean(version.runner_command),
    },
    {
      key: "log",
      label: "generation.log",
      description: "Full runner output",
      available: true,
    },
  ];

  const extras: Entry[] = [
    {
      key: "waveform",
      label: "waveform.json",
      description: "Peak data used by the player",
      available: version.has_waveform,
    },
  ];

  return (
    <div className="space-y-4">
      <Card className="p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold">Everything at once</h2>
            <p className="mt-0.5 text-xs text-[var(--sf-text-muted)]">
              Every version, input and log for this project, as one archive.
            </p>
          </div>
          <a
            href={api.exportZipUrl(project.id)}
            className={buttonClasses("primary", "md", "gap-2")}
          >
            <FileArchive className="h-4 w-4" aria-hidden="true" />
            Download .zip
          </a>
        </div>
      </Card>

      <FileGroup
        title="Audio"
        description={`Version ${version.number}`}
        entries={audio}
        projectId={project.id}
        version={version.number}
      />
      <FileGroup
        title="Score"
        description="YuE2 writes the music down before it sings it"
        entries={symbolic}
        projectId={project.id}
        version={version.number}
      />
      <FileGroup
        title="Provenance"
        description="What was asked, what ran, and how to reproduce it"
        entries={provenance}
        projectId={project.id}
        version={version.number}
      />
      <FileGroup
        title="Extras"
        entries={extras}
        projectId={project.id}
        version={version.number}
      />
    </div>
  );
}

function FileGroup({
  title,
  description,
  entries,
  projectId,
  version,
}: {
  title: string;
  description?: string;
  entries: Entry[];
  projectId: string;
  version: number;
}) {
  const available = entries.filter((entry) => entry.available);
  const missing = entries.filter((entry) => !entry.available);

  return (
    <Card className="p-5">
      <h2 className="text-sm font-semibold">{title}</h2>
      {description && (
        <p className="mt-0.5 text-xs text-[var(--sf-text-muted)]">{description}</p>
      )}

      <div className="mt-3 space-y-1.5">
        {available.map((entry) => (
          <a
            key={entry.key}
            href={api.downloadUrl(projectId, entry.key, version)}
            className="flex items-center gap-3 rounded-lg border border-[var(--sf-border)] p-2.5 transition-colors hover:border-[var(--sf-accent)]"
          >
            <Download
              className="h-4 w-4 shrink-0 text-[var(--sf-text-faint)]"
              aria-hidden="true"
            />
            <span className="min-w-0 flex-1">
              <span className="block font-mono text-xs">{entry.label}</span>
              <span className="block text-[11px] text-[var(--sf-text-faint)]">
                {entry.description}
              </span>
            </span>
            {entry.badge && <Badge tone="accent">{entry.badge}</Badge>}
          </a>
        ))}

        {available.length === 0 && (
          <p className="text-xs text-[var(--sf-text-faint)]">
            Nothing in this group for this version.
          </p>
        )}

        {missing.length > 0 && (
          <p className="pt-1 text-[11px] text-[var(--sf-text-faint)]">
            Not available:{" "}
            {missing.map((entry) => `${entry.label} (${entry.description})`).join(", ")}
          </p>
        )}
      </div>
    </Card>
  );
}
