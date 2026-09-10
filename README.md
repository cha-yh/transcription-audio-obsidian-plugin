# Transcription Audio(Beta) Plugin for Obsidian

Turn your audio into structured Markdown notes inside Obsidian. This plugin detects an audio file linked in your current note, sends it to Gemini for transcription, summarization, or transcript generation, and inserts the result back into your note. A right-hand progress panel shows what’s happening step by step.

## Features

- Smart audio detection from links or embeds in the active note
- Google Gemini transcription, transcript generation, and summarization
- Always-on transcription with optional transcript summarization
- Long-audio transcription with time-based chunking and chunk retry handling
- Category classification for transcript-based summarization
- Reusable transcript file creation and transcript file links
- Progress panel (sidebar) with live status:
  - Detected audio filename and size
  - Audio preparation status
  - API request start/completion times
  - Gemini usage logs (prompt/output/total tokens)
  - Cancel button to stop upload/API request in progress
  - Success/error result
  - Records kept across plugin reloads and updates, each stamped with when the run started and removable individually
  - "Open progress panel" command reopens the panel with those records, without starting a transcription
- Writes the final output to the file and cursor position where you started the command

## Requirements

- A Google AI API key for Gemini. You can obtain one at [https://aistudio.google.com/api-keys](https://aistudio.google.com/api-keys)

## Getting started

1. Open Obsidian Settings
2. Navigate to "Community plugins" and click "Browse"
3. Search for "Transcription Audio" and click Install
4. Enable the plugin in Community plugins
5. Set up your API key in plugin settings

## Configuration

Open Settings → Transcription Audio:

- API Key: Configure the Gemini API key to use. The deprecated plain-text API key input has been removed.
- On older Obsidian versions, API key storage is disabled and you will see an update-required message (Obsidian 1.11.4+)
- Summarize transcript (default: on): transcription is always created; turn this off to create and link only the raw transcript.
- Model: Select a Gemini-compatible model (`gemini-3.8-flash`(default), `gemini-3.7-flash`, `gemini-3.6-flash`, `gemini-3.5-flash`, `gemini-3.5-flash-lite`, `gemini-3.1-pro-preview`, `gemini-3-flash-preview`)
- `gemini-3-pro-preview` is deprecated by Google and shuts down on March 9, 2026. Existing settings are automatically migrated to `gemini-3.1-pro-preview`.
- Default prompt: Customize the instruction used to summarize transcripts and as the fallback when a category does not match.
- Category classification: When enabled, the matching category prompt is used. The `General` category is not included; unmatched transcripts use the default prompt.
- Keep run history: Keeps the progress panel's records across plugin reloads and updates. Turning it off stops new records being saved; records already on disk are left alone and come back when you turn it on again.
  - Auto-remove old records: Drops the oldest records once the panel passes the limit.
  - Records to keep: How many runs stay in the panel (1-200, default 20). A run in progress is always kept.

## Usage

1. In a note, linked file before your cursor, for example:
   - Wiki link: `![[example_audio.wav]]`
2. Place the cursor after the link.
3. Run the command: "Transcribe audio".
   <img alt="Image" src="https://github.com/user-attachments/assets/254e3621-4733-4961-ab90-ce58792d6cc6" />
4. A progress panel will automatically open in the right sidebar, showing real-time status updates including file upload progress, API request status, and transcription progress.
   <img alt="Image" src="https://github.com/user-attachments/assets/80010ac4-7473-4811-86d8-c84dc7fa05eb" />
5. When complete, the transcription, summary, or transcript link is inserted at your starting cursor position.

To bring the panel back later, run the command "Open progress panel". It reveals the panel in the right sidebar and restores the saved run history.

## Privacy & Data

Audio content is sent to Google’s Gemini API for processing. The plugin does not store your audio or transcripts outside your vault. Keep your API key secure and review your organization’s data policies before use.

Run history is written to `progress-sessions.json` inside the plugin's own folder, alongside its settings. It holds the progress log — file paths, model names and API error messages — but never your API key or transcript text. Switch off "Keep run history" if you would rather nothing were written. Opening the same vault in two windows at once can leave whichever window writes last as the one that wins.

## Changelog

### Version 0.8.0

- **Mobile support**
  - Transcription used to fail on every attempt in the Obsidian mobile app. It now runs there the same way it does on desktop
  - Long recordings use noticeably less memory, so a phone is less likely to run out of it mid-run
- **Simplified transcription settings**
  - The three transcription modes are replaced by one `Summarize transcript` toggle. A transcript file is always created; turn the toggle off to keep only the transcript
  - Template prompt settings are gone. The `Default prompt` is used for summarization, and as the fallback when category classification matches nothing
  - The `General` category is retired — an unmatched transcript uses the default prompt instead. A prompt you had customized in `General` is carried over
  - `.wav` recordings now produce a transcript file and a summary like every other format, and gained per-chunk retry
- **Run history**
  - Records stay in the panel after the plugin reloads or updates, each showing when the run started
  - Remove a record with the × on its card, or run the `Open progress panel` command to bring the panel back without starting a transcription
  - New settings control this: `Keep run history` (on) → `Auto-remove old records` (on) → `Records to keep` (20)
  - A run cut short by a reload is marked `Interrupted`. Closing and reopening the sidebar while a run is going no longer loses it
- **Model updates**
  - Added `gemini-3.8-flash`, the new default
- **Fixes**
  - A short recording that failed can now be retried from the panel. Previously the Retry button never appeared for one
  - A run that produced no transcript is reported as failed instead of successful
  - When a transcription fails, summarization is skipped rather than run against an empty transcript
  - An audio file whose name contains `: ` no longer breaks the note's properties
  - A `.wav` recording no longer ignores the summarization setting
  - Settings survive being edited or corrupted by hand: a cleared category list stays cleared, and a malformed entry is repaired rather than dropped

### Version 0.7.1 — [release notes](https://github.com/cha-yh/transcription-audio-obsidian-plugin/releases/tag/0.7.1)

- **Failed chunks no longer discard the run**
- **Model updates**: added `gemini-3.7-flash` (then the default), `gemini-3.6-flash`, and `gemini-3.5-flash-lite`
- **Fixes**: skipped ranges no longer inflate the chunk numbering or show their note in reading view

### Version 0.7.0 — [release notes](https://github.com/cha-yh/transcription-audio-obsidian-plugin/releases/tag/0.7.0)

- **Speech-aware chunking**: plans chunks around where people actually talk, so silent stretches are never sent to the model
- **Per-chunk retry**: each chunk's log line gains a Retry button that rewrites only that chunk's region
- **Progress log**: added a speech-activity sparkline, chunk boundaries, skipped ranges, and a per-chunk timeline

### Version 0.6.0 — [release notes](https://github.com/cha-yh/transcription-audio-obsidian-plugin/releases/tag/0.6.0)

- **Transcription workflows**
- **Long-audio support**
- **Category prompts**
- **Model and settings updates**
- **Fixes**

### Version 0.5.0 — [release notes](https://github.com/cha-yh/transcription-audio-obsidian-plugin/releases/tag/0.5.0)

- **Transcription mode enhancements**
- **Gemini 3 Pro Preview migration**

### Version 0.4.1 — [release notes](https://github.com/cha-yh/transcription-audio-obsidian-plugin/releases/tag/0.4.1)

- **Gemini 3 Pro Preview migration**

### Version 0.4.0 — [release notes](https://github.com/cha-yh/transcription-audio-obsidian-plugin/releases/tag/0.4.0)

- **Secure API key support**
- **Cancelable transcription flow**
- **Progress panel navigation improvements**
- **Progress log improvements**
- **Gemini usage visibility**

### Version 0.3.0 — [release notes](https://github.com/cha-yh/transcription-audio-obsidian-plugin/releases/tag/0.3.0)

- **Add gemini-3-flash-preview(default) model to settings**
- **Enhanced Progress Tracking**: Improved transcription process with detailed progress tracking and UI updates
- **Updated Default Settings**: Updated default settings with new model and refined prompt structure

## License

This project is licensed under the MIT License.
