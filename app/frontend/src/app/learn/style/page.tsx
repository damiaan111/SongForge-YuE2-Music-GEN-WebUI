"use client";

import { DoDont, Example, LearnPage, Section } from "@/components/learn";

export default function StyleLearnPage() {
  return (
    <LearnPage
      title="Writing style tags"
      lede="The style box is one of only two things YuE2 is given. It is read as tags, not as a sentence."
    >
      <Section title="What the model actually receives">
        <p>
          YuE2 builds its own prompt from two fields and wraps them in headers of its
          own. Whatever you type in the style box lands under{" "}
          <code className="font-mono text-[12px]">[Tags]</code>, and the lyrics land
          under <code className="font-mono text-[12px]">[Lyrics]</code>:
        </p>
        <Example label="The prompt YuE2 assembles">{`Generate a chord-annotated ABC transcription, then generate music with codec tokens from the given conditions.
[Tags]
English, warm female vocal, indie folk, 92 BPM, fingerpicked acoustic guitar, intimate
[Lyrics]
[Verse]
...`}</Example>
        <p>
          That is why musical instructions belong in the style box and never in the
          lyrics: anything under <code className="font-mono text-[12px]">[Lyrics]</code>{" "}
          is treated as words to sing.
        </p>
      </Section>

      <Section title="Order matters">
        <p>
          Write comma-separated tags with the most important first; earlier tags carry
          more weight. A reliable order, and the one the developers&apos; own examples
          use:
        </p>
        <Example label="Language, genre, vocal, instruments, mood, tempo">{`English, contemporary pop, warm female vocal with clear diction, piano,
rounded electric bass, restrained drums, hopeful, 96 BPM`}</Example>
        <p>
          Write the tags in English even when the lyrics are in another language, and
          name the lyric language as a tag. Tempo is a hint, not a guarantee.
        </p>
      </Section>

      <Section title="One musical centre">
        <p>
          Give the model one clear idea plus a few compatible details. Conflicting
          directions do not blend - they fight, and the result is usually a muddle of
          both. If you have asked for quiet acoustic folk and a festival drop, remove
          one.
        </p>
        <DoDont
          good={[
            "Describe audible qualities: airy, brushed drums, close-mic'd, analog pads.",
            "Name the vocal gender and tone; leaving them out makes the voice a lottery.",
            "Use the Avoid row for instruments a genre would otherwise imply.",
            "Change one tag at a time, with the same seed, when comparing.",
          ]}
          bad={[
            "Naming a living artist as shorthand for a sound.",
            "Stacking three genres and hoping for a blend.",
            "Telling the story of the song - that is what the lyrics are for.",
            "Writing a paragraph where six tags would do.",
          ]}
        />
      </Section>

      <Section title="The style builder on Create">
        <p>
          The builder composes these tags in the order above and shows you the exact
          string that will be sent. The checklist beside it marks the four tags that
          most change the result - language, genre, vocal and tempo - so you can see at
          a glance what you have not said.
        </p>
      </Section>
    </LearnPage>
  );
}
