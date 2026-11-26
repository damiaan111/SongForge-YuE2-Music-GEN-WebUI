/**
 * Composing the style field as tags.
 *
 * YuE2 reads the style as comma-separated tags and weights earlier ones more
 * heavily, so order is part of the prompt. The backend prefixes the language
 * and the vocal preference (see `compose_style` in runners/yue2.py); everything
 * else is assembled here, in the order the developers' own examples use:
 * genre and description, then mood, then exclusions, then key and tempo.
 */

export interface StyleDraft {
  /** The user's own text: the musical centre, usually genre plus instruments. */
  description: string;
  genres: string[];
  moods: string[];
  /** Things to keep out, written as "no guitar". */
  avoid: string[];
  /** Free text so unusual tempos and keys stay possible. */
  bpm: string;
  musicalKey: string;
}

export const EMPTY_STYLE: StyleDraft = {
  description: "",
  genres: [],
  moods: [],
  avoid: [],
  bpm: "",
  musicalKey: "",
};

export const GENRES = [
  "Pop", "Rock", "Indie", "Folk", "Jazz", "Funk", "Soul", "R&B", "Hip hop",
  "Electronic", "House", "Synthwave", "Ambient", "Lo-fi", "Metal", "Country",
  "Classical", "Bossa nova",
];

export const MOODS = [
  "Warm", "Melancholy", "Uplifting", "Dreamy", "Energetic", "Calm",
  "Nostalgic", "Cinematic", "Dark", "Playful", "Hopeful", "Intimate",
];

/** Instruments and treatments a genre tag would otherwise imply. */
export const AVOIDABLE = [
  "drums", "guitar", "electric guitar", "piano", "synths", "strings",
  "brass", "backing vocals", "autotune", "clapping",
];

export const VOCAL_GENDERS = ["female vocal", "male vocal", "androgynous vocal", "choir"];

export const VOCAL_TONES = [
  "warm", "airy", "breathy", "bright", "husky", "soft", "powerful",
  "raspy", "clear diction", "intimate",
];

/** True when the description already says this, so a chip would duplicate it. */
function alreadyMentioned(description: string, tag: string): boolean {
  return description.toLowerCase().includes(tag.toLowerCase());
}

/**
 * The style string to send, without the language and vocal tags the backend
 * puts in front of it.
 */
export function composeStyle(draft: StyleDraft): string {
  const description = draft.description.trim();
  const parts: string[] = [];
  if (description) parts.push(description);

  for (const group of [draft.genres, draft.moods]) {
    for (const tag of group) {
      if (!alreadyMentioned(description, tag)) parts.push(tag.toLowerCase());
    }
  }
  for (const item of draft.avoid) parts.push(`no ${item}`);

  const key = draft.musicalKey.trim();
  if (key) parts.push(key);
  const bpm = draft.bpm.trim();
  if (bpm) parts.push(/bpm/i.test(bpm) ? bpm : `${bpm} BPM`);

  return parts.join(", ");
}

/** What the composed tags will look like once the backend has prefixed its own. */
export function previewStyle(
  draft: StyleDraft,
  context: { language?: string; vocal?: string; instrumental?: boolean },
): string {
  const parts = [context.language?.trim(), context.vocal?.trim(), composeStyle(draft)];
  const style = parts.filter(Boolean).join(", ");
  if (!context.instrumental) return style;
  const kept = style
    .split(", ")
    .filter((part) => part && !part.toLowerCase().includes("vocal"));
  return [...kept, "instrumental, no vocals, no singing, no lyrics"].join(", ");
}

export interface StyleCheck {
  label: string;
  ok: boolean;
  hint: string;
}

/**
 * The four tags that change the result most. Not validation - a song renders
 * without any of them - but leaving them out makes the outcome a lottery.
 */
export function styleChecklist(
  draft: StyleDraft,
  context: { language?: string; vocal?: string; instrumental?: boolean },
): StyleCheck[] {
  const text = `${draft.description} ${draft.genres.join(" ")}`.toLowerCase();
  const checks: StyleCheck[] = [
    {
      label: "Language",
      ok: Boolean(context.language?.trim()),
      hint: "Name the language the lyrics are in, even when it is English.",
    },
    {
      label: "Genre",
      ok: draft.genres.length > 0 || text.trim().length > 3,
      hint: "One clear genre, with a few compatible details.",
    },
    {
      label: "Vocal",
      ok: Boolean(context.vocal?.trim()) || /vocal|voice|sings|choir/.test(text),
      hint: "Gender and tone, or the voice is a lottery.",
    },
    {
      label: "Tempo",
      ok: Boolean(draft.bpm.trim()) || /bpm|slow|fast|mid-?tempo|ballad/.test(text),
      hint: "A BPM is a hint, not a guarantee, but it anchors the feel.",
    },
  ];
  return context.instrumental
    ? checks.filter((check) => check.label !== "Vocal")
    : checks;
}
