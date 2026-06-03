import {
  AudioPluginSettings,
  TranscriptionCategory,
} from "_base/types/setting";

export const DEFAULT_BASIC_MODE_PROMPT =
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
  "   - Non-obvious insights with brief “why it matters”.\n" +
  "- Decisions\n" +
  "   - Finalized decisions as a bullet list.\n" +
  "- One-paragraph Abstract\n" +
  "   - A tight 3–5 sentence abstract suitable for future review.\n" +
  "\n" +
  "Constraints:\n" +
  "- Write as if I am the author. Do not mention “the speaker”.\n" +
  "- Be faithful to the transcript; mark uncertain items with [?] rather than inventing facts.\n" +
  "- Prefer clear headings, bullets, and short paragraphs.\n" +
  "\n" +
  "The following is the transcribed audio:\n\n";

export const DEFAULT_TEMPLATE_MODE_PROMPT =
  "Use the transcript to fill the provided markdown template exactly.\n" +
  "\n" +
  "Template rules:\n" +
  "- Keep headings/order from the template exactly.\n" +
  "- Keep bullet style/checklist style from the template exactly.\n" +
  "- Replace placeholder values with concise, factual content from transcript.\n" +
  "- In Timeline, use dynamic ranges with 0.5-step boundaries (e.g., 1/10 ~ 2/10, 2/10 ~ 3.5/10, 3.5/10 ~ 6.5/10, 6.5/10 ~ 10/10).\n" +
  "- Timeline ranges must be contiguous, non-overlapping, and cover 1/10 through 10/10.\n" +
  "- If information is missing, write `N/A`.\n" +
  "- Output only the final markdown note.\n";

export const DEFAULT_OUTPUT_TEMPLATE =
  "## Executive Summary\n" +
  "- {{summary-1}}\n" +
  "- {{summary-2}}\n" +
  "- {{summary-3}}\n" +
  "\n" +
  "## Timeline\n" +
  "{{timeline-segments}}\n" +
  "\n" +
  "## Key Details\n" +
  "- {{detail-1}}\n" +
  "- {{detail-2}}\n" +
  "- {{detail-3}}\n" +
  "\n" +
  "## Decisions\n" +
  "- {{decision-1}}\n" +
  "\n" +
  "## Action Items\n" +
  "- [ ] {{owner-1}} - {{action-1}} (Due: {{due-1}})\n" +
  "\n" +
  "## Abstract\n" +
  "{{abstract-3-5-sentences}}";

export const DEFAULT_TRANSCRIPTION_ONLY_PROMPT =
  "Transcribe the following audio exactly as spoken. " +
  "Output only the raw transcript text. " +
  "Preserve the original language. " +
  "Do not summarize, interpret, add commentary, or format with headings.\n\n" +
  "Formatting rules:\n" +
  "- Insert a line break (blank line) every time the speaker changes.\n" +
  "- Each speaker's continuous speech must be on a single paragraph without line breaks.\n" +
  "- Do not add speaker labels (e.g., 'Speaker 1:', 'Male:', 'Female:').\n" +
  "- Do not add timestamps.\n\n" +
  "Example output:\n" +
  "I think we should go with option A. It makes more sense given the timeline.\n\n" +
  "But what about the budget? We haven't checked the numbers yet.\n\n" +
  "Right, let me pull up the spreadsheet and we can review it together.";

const CATEGORY_PROMPT_BASE =
  "\n\nConstraints:\n" +
  "- Write as if I am the author. Do not mention \"the speaker\".\n" +
  "- Be faithful to the transcript; mark uncertain items with [?] rather than inventing facts.\n" +
  "- Prefer clear headings, bullets, and short paragraphs.\n" +
  "- Write in the same language as the transcript.\n\n" +
  "The following is the transcript:\n\n";

export const DEFAULT_CATEGORY_PROMPT_1ON1 =
  "Produce a structured Markdown note from this 1-on-1 meeting transcript.\n\n" +
  "## Follow-ups from Last Meeting\n" +
  "- List items carried over from the previous session and their current status.\n\n" +
  "## Key Discussion Points\n" +
  "- Record each topic discussed with who raised it and the outcome.\n\n" +
  "## Feedback & Coaching\n" +
  "- Any feedback given or received, mentoring moments, or growth observations.\n\n" +
  "## Blockers & Concerns\n" +
  "- Issues blocking progress or personal/professional concerns raised.\n\n" +
  "## Action Items\n" +
  "- [ ] Owner — action — due date\n\n" +
  "## Mood / Sentiment\n" +
  "- Brief note on overall tone and energy of the conversation." +
  CATEGORY_PROMPT_BASE;

export const DEFAULT_CATEGORY_PROMPT_TECH_MEETING =
  "Produce a structured Markdown note from this technical meeting transcript.\n\n" +
  "## Executive Summary\n" +
  "- 3–5 bullets of the most important technical outcomes.\n\n" +
  "## Technical Decisions\n" +
  "- Each decision with rationale and alternatives considered.\n\n" +
  "## Architecture & Design\n" +
  "- Any architecture or design discussions, diagrams described, or patterns chosen.\n\n" +
  "## Code & Review\n" +
  "- Code review outcomes, PR references, or implementation details discussed.\n\n" +
  "## Tech Debt & Risks\n" +
  "- Technical debt items identified, performance concerns, or infrastructure risks.\n\n" +
  "## Action Items\n" +
  "- [ ] Owner — action — due date" +
  CATEGORY_PROMPT_BASE;

export const DEFAULT_CATEGORY_PROMPT_PROJECT =
  "Produce a structured Markdown note from this project discussion transcript.\n\n" +
  "## Project Status\n" +
  "- Current status of the project, progress against milestones.\n\n" +
  "## Timeline & Milestones\n" +
  "- Any changes to timeline, upcoming milestones, or deadline adjustments.\n\n" +
  "## Risks & Issues\n" +
  "- Risks identified, blockers, and mitigation strategies discussed.\n\n" +
  "## Resource & Scope Changes\n" +
  "- Changes to team allocation, budget, or project scope.\n\n" +
  "## Stakeholder Feedback\n" +
  "- Feedback from stakeholders, clients, or cross-team partners.\n\n" +
  "## Decisions\n" +
  "- Finalized decisions as a bullet list.\n\n" +
  "## Action Items\n" +
  "- [ ] Owner — action — due date" +
  CATEGORY_PROMPT_BASE;

export const DEFAULT_CATEGORY_PROMPT_GENERAL = DEFAULT_BASIC_MODE_PROMPT;

export const GENERAL_CATEGORY_ID = "general";

export const DEFAULT_CATEGORIES: TranscriptionCategory[] = [
  {
    id: "1on1",
    name: "1on1",
    prompt: DEFAULT_CATEGORY_PROMPT_1ON1,
    enabled: true,
  },
  {
    id: "tech-meeting",
    name: "Tech Meeting",
    prompt: DEFAULT_CATEGORY_PROMPT_TECH_MEETING,
    enabled: true,
  },
  {
    id: "project-discussion",
    name: "Project Discussion",
    prompt: DEFAULT_CATEGORY_PROMPT_PROJECT,
    enabled: true,
  },
  {
    id: GENERAL_CATEGORY_ID,
    name: "General",
    prompt: DEFAULT_CATEGORY_PROMPT_GENERAL,
    enabled: true,
  },
];

export const DEFAULT_SETTINGS: AudioPluginSettings = {
  mode: "basic",
  model: "gemini-3-flash-preview",
  secretApiKeyName: "",
  enableTemplatePrompt: false,
  templatePrompt: DEFAULT_TEMPLATE_MODE_PROMPT,
  outputTemplate: DEFAULT_OUTPUT_TEMPLATE,
  prompt: DEFAULT_BASIC_MODE_PROMPT,
  enableCategoryClassification: false,
  categories: DEFAULT_CATEGORIES,
};

export const MODELS: string[] = [
  "gemini-2.5-flash",
  "gemini-2.5-pro",
  "gemini-3.1-pro-preview",
  "gemini-3-flash-preview",
  "gemini-3.5-flash",
];

export const MODEL_MIGRATIONS: Record<string, string> = {
  "gemini-3-pro-preview": "gemini-3.1-pro-preview",
};
