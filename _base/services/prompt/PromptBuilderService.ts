export class PromptBuilderService {
  /**
   * Builds an enhanced prompt by combining the base prompt with contextual notes.
   * The contextual notes are formatted in a way that helps the AI understand
   * speaker names, terminology, and other context from the user's notes.
   *
   * @param basePrompt - The original transcription prompt
   * @param contextNotes - Extracted notes providing context (or null if none)
   * @returns The enhanced prompt with contextual notes appended, or the base prompt if no notes
   */
  buildPrompt(basePrompt: string, contextNotes: string | null): string {
    if (!contextNotes || contextNotes.trim().length === 0) {
      return basePrompt;
    }

    const contextSection = `
---
## Contextual Notes
The following notes provide context for the recording. Use them to:
- Identify speaker names and roles
- Understand the agenda/topics
- Ground technical terms and project names

<notes>
${contextNotes}
</notes>
---

The following is the transcribed audio:
`;

    // If the base prompt already ends with a transition phrase like
    // "The following is the transcribed audio:", we should replace it
    // to avoid duplication
    const transitionPattern =
      /The following is the transcribed audio:?\s*$/i;

    if (transitionPattern.test(basePrompt)) {
      return basePrompt.replace(transitionPattern, contextSection);
    }

    // Otherwise, append the context section
    return basePrompt + contextSection;
  }
}
