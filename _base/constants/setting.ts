import { AudioPluginSettings } from "_base/types/setting";

export const DEFAULT_SETTINGS: AudioPluginSettings = {
  model: "gemini-2.5-flash",
  apiKey: "",
  prompt:
    "You are an expert meeting and research note-taker for Obsidian. Produce a rigorously structured Markdown note from the following audio transcript. Follow this exact structure and rules:\n\n" +
    "1) Executive Summary\n" +
    "   - 5–8 concise bullets capturing the most important takeaways.\n" +
    "2) Timeline Outline\n" +
    "   - Chronological outline using headings and nested bullets.\n" +
    "   - If any time hints exist, add approximate timecodes like (≈12:30).\n" +
    "3) Key Insights & Rationale\n" +
    "   - Non-obvious insights with brief “why it matters”.\n" +
    "4) Decisions\n" +
    "   - Finalized decisions as a bullet list.\n" +
    "5) Action Items\n" +
    "   - Markdown table with columns: Task | Owner | Due | Status.\n" +
    "6) Open Questions & Risks\n" +
    "   - Items that require follow-up, unknowns, blockers, and risks.\n" +
    "7) Terms & Entities\n" +
    "   - Glossary of people, projects, tools, and domain terms.\n" +
    "8) Link Suggestions\n" +
    "   - Suggested Obsidian wikilinks and tags (use [[Wiki Links]] and #tags).\n" +
    "9) One-paragraph Abstract\n" +
    "   - A tight 3–5 sentence abstract suitable for future review.\n\n" +
    "Constraints:\n" +
    "- Write as if I am the author. Do not mention “the speaker”.\n" +
    "- Be faithful to the transcript; mark uncertain items with [?] rather than inventing facts.\n" +
    "- Prefer clear headings, bullets, and short paragraphs.\n" +
    "- Use English for the note content.\n\n" +
    "The following is the transcribed audio:\n\n",
};

export const MODELS: string[] = ["gemini-2.5-flash", "gemini-2.5-pro"];
