/**
 * Lyric checks, with the reason attached.
 *
 * Every rule here is something that demonstrably costs you words or timing in a
 * YuE2 render: shorthand gets sung instead of expanded, over-long sections run
 * past their planned half minute, and repeats whose syllable counts drift no
 * longer fit the melody the planner wrote. None of it blocks a render - these
 * are notes, not validation.
 */

export interface LyricFinding {
  id: string;
  severity: "warning" | "note";
  /** What is wrong, in the user's terms. */
  message: string;
  /** Why it matters to the model. One sentence. */
  why: string;
}

const MAX_LINES_PER_SECTION = 6;
/** Past this a line tends to be delivered rushed. */
const LONG_LINE = 64;

export interface Section {
  tag: string;
  lines: string[];
}

/** Split lyrics into tagged sections. Text before the first tag has tag "". */
export function parseSections(lyrics: string): Section[] {
  const sections: Section[] = [];
  for (const raw of lyrics.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const tag = /^\[([^\]]+)\]$/.exec(line);
    if (tag) {
      sections.push({ tag: tag[1].trim(), lines: [] });
      continue;
    }
    if (sections.length === 0) sections.push({ tag: "", lines: [] });
    sections[sections.length - 1].lines.push(line);
  }
  return sections;
}

/**
 * Rough syllable count: vowel groups, with a silent trailing "e" discounted.
 * Good enough to compare two versions of the same line, which is all it is for.
 */
export function syllables(line: string): number {
  const words = line.toLowerCase().match(/[a-zÀ-ɏ']+/g) ?? [];
  let total = 0;
  for (const word of words) {
    const groups = word.match(/[aeiouyà-ü]+/g) ?? [];
    let count = groups.length;
    if (count > 1 && /e$/.test(word) && !/[aeiouy]e$/.test(word)) count -= 1;
    total += Math.max(1, count);
  }
  return total;
}

export function lintLyrics(lyrics: string): LyricFinding[] {
  const text = lyrics.trim();
  if (!text) return [];
  const findings: LyricFinding[] = [];
  const sections = parseSections(text);
  const tagged = sections.filter((section) => section.tag);

  if (tagged.length === 0) {
    findings.push({
      id: "no-tags",
      severity: "warning",
      message: "No [Verse] or [Chorus] tags",
      why: "Structure is most of what the planner has to work with; untagged lyrics become one long verse.",
    });
  } else if (!tagged.some((section) => /chorus/i.test(section.tag))) {
    findings.push({
      id: "no-chorus",
      severity: "note",
      message: "No chorus",
      why: "A chorus that returns gives the model an anchor to come back to.",
    });
  }

  // Shorthand is sung aloud rather than expanded.
  if (/\bx\s?\d\b|\(\s*repeat|\brepeat\s+chorus\b/i.test(text)) {
    findings.push({
      id: "shorthand",
      severity: "warning",
      message: 'Repeat shorthand like "x2"',
      why: "YuE2 sings these words instead of expanding them. Write the repeat out in full.",
    });
  }

  if (/\*\*|^#{1,6}\s|^\s*[-*]\s+/m.test(text)) {
    findings.push({
      id: "markdown",
      severity: "warning",
      message: "Markdown or bullet characters",
      why: "Anything in the lyrics field is treated as words to sing.",
    });
  }

  // Typed lyrics reach YuE2 verbatim - unlike the writer's output, nothing
  // strips a production note from them - so this warning is the only thing
  // standing between "(guitar solo)" and hearing it sung.
  //
  // Dutch is included because the words are glued into one token there
  // ("gitaarsolo"), so an English-only list silently misses them. "beat" is
  // deliberately absent: "(beat it)" is a lyric, and a false warning on a real
  // line is what teaches people to ignore the linter.
  const direction =
    /\((?:[^)]*\b(?:solo|instrumental|interlude|fade|spoken|whisper(?:ed)?|guitar|piano|drums|riff|ad[- ]?lib|gitaarsolo|pianosolo|drumsolo|gitaar|tussenspel|gesproken|gefluisterd|refrein|instrumentaal)\b[^)]*)\)/i;
  if (direction.test(text)) {
    findings.push({
      id: "stage-direction",
      severity: "note",
      message: "A production note in the lyrics",
      why: "Musical instructions belong in the style tags; here they get sung.",
    });
  }

  const long = tagged.find((section) => section.lines.length > MAX_LINES_PER_SECTION);
  if (long) {
    findings.push({
      id: "long-section",
      severity: "note",
      message: `[${long.tag}] has ${long.lines.length} lines`,
      why: "A section renders to roughly half a minute; four to six lines fits that.",
    });
  }

  if (text.split("\n").some((line) => line.trim().length > LONG_LINE)) {
    findings.push({
      id: "long-line",
      severity: "note",
      message: "Some lines are very long",
      why: "Long lines get rushed to fit the phrase the planner wrote for them.",
    });
  }

  // Repeats of the same section should keep their syllable count.
  const byTag = new Map<string, number[]>();
  for (const section of tagged) {
    if (section.lines.length === 0) continue;
    const key = section.tag.toLowerCase().replace(/\s*\d+$/, "");
    const total = section.lines.reduce((sum, line) => sum + syllables(line), 0);
    byTag.set(key, [...(byTag.get(key) ?? []), total]);
  }
  for (const [tag, counts] of byTag) {
    if (counts.length < 2) continue;
    const low = Math.min(...counts);
    const high = Math.max(...counts);
    if (low > 0 && (high - low) / low > 0.15) {
      findings.push({
        id: `drift-${tag}`,
        severity: "note",
        message: `The ${tag} sections differ in length`,
        why: "When a repeat has a different syllable count, the planned melody stops fitting and the words get rushed.",
      });
      break;
    }
  }

  const first = sections[0];
  if (first && !first.tag && first.lines.length === 1) {
    findings.push({
      id: "stray-first-line",
      severity: "note",
      message: "A line sits above the first section tag",
      why: "If that is a title, it will be sung. Move it out or tag the section.",
    });
  }

  // Four is as much as anyone reads; warnings first.
  return findings
    .sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "warning" ? -1 : 1))
    .slice(0, 4);
}
