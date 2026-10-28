"use client";

import { DoDont, Example, Figures, LearnPage, Section } from "@/components/learn";

export default function LyricsLearnPage() {
  return (
    <LearnPage
      title="Writing lyrics YuE2 will sing"
      lede="Structure is most of what the planner has to work with, and the lyrics field is the only place it comes from."
    >
      <Section title="Shape">
        <p>
          A section tag on its own line, a blank line between sections, and nothing in
          the field but tags and words to be sung.
        </p>
        <Example label="A shape that renders reliably">{`[Intro]

[Verse]
The engine hums a low and lonely tune
Beneath the glow of a pale and fading moon
Headlights counting out the miles
I have been driving since noon

[Chorus]
City lights are blurring in the rain
I am driving home to numb the quiet pain
Every mile a little lighter
Every mile the same

[Verse]
...`}</Example>
        <p>
          An empty <code className="font-mono text-[12px]">[Intro]</code> or{" "}
          <code className="font-mono text-[12px]">[Instrumental]</code> asks for an
          instrumental stretch. Tags suggest structure rather than exact timing.
        </p>
      </Section>

      <Section title="Numbers worth remembering">
        <Figures
          rows={[
            ["Lines per section", "4 to 6"],
            ["Length of one section", "about 30 seconds"],
            ["Sections in a 3 minute song", "6 or 7"],
            ["Hard ceiling for one render", "6:00"],
          ]}
        />
        <p className="mt-3">
          Because a section is roughly half a minute, the section count is a better
          length control than word count. Twelve sections is already a six-minute song,
          whatever you do with the lines.
        </p>
      </Section>

      <Section title="The four habits that lose words">
        <p>
          When a song comes back with sentences missing or rushed, it is almost always
          one of these rather than bad luck with the seed:
        </p>
        <ol className="mt-1 list-inside list-decimal space-y-1.5">
          <li>
            <strong className="text-[var(--sf-text)]">Too many words for the time.</strong>{" "}
            YuE2 does not align lyrics to a clock; it sings until it runs out of budget.
            Past six minutes the rest is simply not sung.
          </li>
          <li>
            <strong className="text-[var(--sf-text)]">Repeat shorthand.</strong>{" "}
            <code className="font-mono text-[12px]">(repeat chorus)</code> and{" "}
            <code className="font-mono text-[12px]">x2</code> are sung aloud, not
            expanded. Write every chorus out in full. SongForge expands an{" "}
            <code className="font-mono text-[12px]">x2</code> on a section tag for you
            and tells you it did.
          </li>
          <li>
            <strong className="text-[var(--sf-text)]">Mismatched repeats.</strong> If the
            second chorus has a different syllable count from the first, the planned
            melody no longer fits and the delivery gets rushed or clipped.
          </li>
          <li>
            <strong className="text-[var(--sf-text)]">Non-sung text.</strong> Titles,
            production notes and stage directions in the lyrics field get sung. Keep
            them out; put the musical ones in the style box.
          </li>
        </ol>
      </Section>

      <Section title="Backing vocals and ad-libs">
        <p>
          Parenthesised lines such as{" "}
          <code className="font-mono text-[12px]">(ooh-ooh)</code> are ordinary lyrics
          and are kept. Only lines that read as production notes -{" "}
          <code className="font-mono text-[12px]">(guitar solo)</code>,{" "}
          <code className="font-mono text-[12px]">(fade out)</code> - are removed before
          the model sees them.
        </p>
        <DoDont
          good={[
            "Short lines with a steady rhythm, especially in a first test.",
            "A chorus that returns word for word, so the model has a clear anchor.",
            "Lyric language matching the language tag in the style box.",
            "One verse and one chorus first; add sections once it sounds right.",
          ]}
          bad={[
            "Hyphenating words to force syllables - it is unreliable.",
            "A title line at the top of the lyrics field.",
            "Translating a line word for word and keeping the original melody.",
            "Twelve sections on a first attempt.",
          ]}
        />
      </Section>

      <Section title="The local lyrics writer">
        <p>
          The writer on the Lyrics page is given these same rules, and the length you
          ask for sets both the section outline and how much it is allowed to write. If
          it stops mid-section it now says so - that warning means the song is
          unfinished, not that the model chose to end there.
        </p>
      </Section>
    </LearnPage>
  );
}
