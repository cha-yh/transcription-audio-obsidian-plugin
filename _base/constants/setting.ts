import { AudioPluginSettings } from "_base/types/setting";

export const DEFAULT_SETTINGS: AudioPluginSettings = {
  model: "gemini-3-flash-preview",
  apiKey: "",
  prompt:
    "You are an expert meeting and research note-taker for Obsidian. Produce a rigorously structured Markdown note from the following audio transcript. Follow this exact structure and rules:\n" +
    "\n" +
    "- Executive Summary\n" +
    "   - 5–8 concise bullets capturing the most important takeaways.\n" +
    "- Timeline Outline\n" +
    "   - Divide the recorded audio into 10 equal segments and indicate brief content for the timeline as shown in the example below (exact timestamps are not necessary; record only the time segment, e.g., 1/10).\n" +
    "      - e.g., '1/10: Meeting start and ice breaking'\n" +
    "   - If the context is continuous, group the timeline segments into a range using decimals and the `~` symbol.\n" +
    "      - e.g., '1/10 ~ 1.5/10: Retrospective on the previous 1on1'\n" +
    "      - e.g., '1.5/10 ~ 4/10: Discussion on solutions for previously raised issues'\n" +
    "- Detail contents\n" +
    "   - You must write down all detailed contents. Record who said what and the subsequent responses. Must be written as a bullet list.\n" +
    "   - e.g., 'Female 1: Who ate this hamburger?', 'Male 2: I saw Jaeyeon eating it.'\n" +
    "- Key Insights & Rationale\n" +
    "   - Non-obvious insights with brief 'why it matters'.\n" +
    "- Decisions\n" +
    "   - Finalized decisions as a bullet list.\n" +
    "- One-paragraph Abstract\n" +
    "   - A tight 3–5 sentence abstract suitable for future review.\n" +
    "\n" +
    "Constraints:\n" +
    "- Write as if I am the author. Do not mention 'the speaker'.\n" +
    "- Be faithful to the transcript; mark uncertain items with [?] rather than inventing facts.\n" +
    "- Prefer clear headings, bullets, and short paragraphs.\n" +
    "\n" +
    "The following is the transcribed audio:\n\n",
  includeContextualNotes: true,
  contextNotesMaxLength: 5000,
};

export const MODELS: string[] = [
  "gemini-2.5-flash",
  "gemini-2.5-pro",
  "gemini-3-pro-preview",
  "gemini-3-flash-preview",
];
