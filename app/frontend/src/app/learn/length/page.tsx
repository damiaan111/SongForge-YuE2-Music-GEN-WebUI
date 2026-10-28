"use client";

import { Figures, LearnPage, Section } from "@/components/learn";

export default function LengthLearnPage() {
  return (
    <LearnPage
      title="Why songs get cut short"
      lede="There is no duration dial. Length follows the lyrics, and two separate ceilings decide whether the song survives intact."
    >
      <Section title="Ceiling one: the music budget">
        <p>
          YuE2 generates audio as codec tokens, roughly 25 of them per second of music,
          and stops after 9,000 of them. That is a hard six-minute song. When it stops
          before reaching the end of the lyrics, the remaining words are never sung and
          the audio ends mid-phrase.
        </p>
        <Figures
          rows={[
            ["Tokens per second of audio", "25"],
            ["Music budget per render", "9,000 tokens"],
            ["Longest possible song", "6:00"],
            ["Minimum before it may end", "200 tokens (~8 s)"],
          ]}
        />
        <p className="mt-3">
          Afterwards this shows up on the song page as{" "}
          <em>The song hit the six-minute ceiling</em>. The fix is fewer or shorter
          sections, not a different seed.
        </p>
      </Section>

      <Section title="Ceiling two: the shared context">
        <p>
          The instruction, your style tags, your lyrics and the score plan all share one
          24,576-token window with the music. If the prompt grows large enough to eat
          into the music budget, YuE2 refuses the request outright rather than quietly
          truncating it - so this one appears as a failed job, not a short song.
        </p>
        <Figures
          rows={[
            ["Context window", "24,576 tokens"],
            ["Reserved for music", "9,000 tokens"],
            ["Score plan ceiling", "4,096 tokens"],
            ["Left for style and lyrics", "about 11,480 tokens"],
          ]}
        />
        <p className="mt-3">
          In practice only an enormous lyric reaches this. Style tags are the cheapest
          thing to cut when it happens.
        </p>
      </Section>

      <Section title="When the plan runs out instead">
        <p>
          With planning on, YuE2 writes a score before it sings, and that score has its
          own 4,096-token ceiling. If the plan is cut off, the later sections have no
          plan to sing from, and sections can go missing from the middle of a song that
          is otherwise the right length. That is reported separately as{" "}
          <em>The score plan ran out of room</em>.
        </p>
      </Section>

      <Section title="Reading the meter on Create">
        <p>
          The meter estimates sung length from the lyrics - about 27 seconds of
          intro and outro, plus a second for every 8.5 characters, fitted to real
          renders on this machine. The bar is always the full six minutes, so the
          ceiling stays visible.
        </p>
        <ul className="mt-1 list-inside list-disc space-y-1">
          <li>
            <strong className="text-[var(--sf-text)]">Fits</strong> - comfortably inside
            the ceiling.
          </li>
          <li>
            <strong className="text-[var(--sf-text)]">Close to the limit</strong> - past
            about 5:06. The estimate is accurate to roughly 10%, so the ending may still
            be cut.
          </li>
          <li>
            <strong className="text-[var(--sf-text)]">Too long</strong> - the end of the
            lyrics will not be sung.
          </li>
          <li>
            <strong className="text-[var(--sf-text)]">Will be refused</strong> - the
            prompt does not fit the context and the job would fail.
          </li>
        </ul>
        <p className="mt-2">
          The estimate is lyric-driven, so it says nothing about instrumentals: with no
          words to follow, YuE2 chooses its own length and stops at six minutes at the
          latest.
        </p>
      </Section>

      <Section title="Why not just raise the limit">
        <p>
          The audio token budget is adjustable under Advanced, but 9,000 tokens is what
          the model was trained and evaluated at, and the context window is fixed in the
          weights. Raising the budget past what the context leaves free makes YuE2
          refuse the request. Shortening the song is the reliable answer.
        </p>
      </Section>
    </LearnPage>
  );
}
