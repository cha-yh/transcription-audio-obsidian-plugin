# Transcription Audio(Beta) Plugin for Obsidian

Turn your audio into structured Markdown notes inside Obsidian. This plugin detects an audio file linked in your current note, transcribes it with Gemini's dedicated speech-to-text model, optionally summarizes the transcript, and inserts the result back into your note. A right-hand progress panel shows what’s happening step by step.

## Features

- Smart audio detection from links or embeds in the active note
- Transcription with Google's dedicated speech-to-text model (`gemini-3.5-transcribe`), with optional speaker labels, timestamps, custom vocabulary and language hints
- Optional summarization of the transcript with a Gemini model of your choice, with category-specific prompts
- Long-audio transcription with time-based chunking and chunk retry handling
- Reusable transcript file creation and transcript file links
- Progress panel (sidebar) with live status:
  - Detected audio filename and size
  - Audio preparation status
  - API request start/completion times
  - Gemini usage logs (prompt/output/total tokens; the transcription model reports its output as 0)
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

Open Settings → Transcription Audio. Settings are grouped into four sections.

General:

- API Key: Configure the Gemini API key to use. The deprecated plain-text API key input has been removed.
- On older Obsidian versions, API key storage is disabled and you will see an update-required message (Obsidian 1.11.4+)

Transcription — always done by Google's dedicated speech-to-text model, `gemini-3.5-transcribe`. It does not follow prompts; only these options shape the transcript:

- Mode (default: Verbatim): Verbatim keeps fillers, repetitions and false starts. Smart removes them and tidies punctuation and lists, but cannot be combined with speaker labels or timestamps.
- Speaker labels (default: off): A labelled paragraph per speaker, up to 8 speakers (3 or more is experimental). Labels restart in every 20-minute chunk of a recording over 30 minutes.
- Timestamps (default: off): Each paragraph starts with its time in the recording. May lower overall accuracy.
- Custom vocabulary: Terms to recognize, one per line (up to 1,000; best around 100). Not used while speaker labels or timestamps are on.
- Language hints: Comma-separated BCP-47 codes such as `ko-KR, en-US`. Leave empty to detect the language automatically.
- Speaker labels and timestamps limit a request to 30 minutes, and Free Tier keys are limited to 10,000 input tokens per minute (about 7 minutes of audio).

Summary:

- Summarize transcript (default: on): transcription is always created; turn this off to create and link only the raw transcript.
- Model: The model that writes the summary (`gemini-3.8-flash`(default), `gemini-3.7-flash`, `gemini-3.6-flash`, `gemini-3.5-flash`, `gemini-3.5-flash-lite`, `gemini-3.1-pro-preview`, `gemini-3-flash-preview`)
- `gemini-3-pro-preview` is deprecated by Google and shuts down on March 9, 2026. Existing settings are automatically migrated to `gemini-3.1-pro-preview`.
- Default prompt: Customize the instruction used to summarize transcripts and as the fallback when a category does not match.
- Category classification: When enabled, the matching category prompt is used. The `General` category is not included; unmatched transcripts use the default prompt.

Run history:

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
5. When complete, a link to the transcript file is inserted at your starting cursor position, followed by the summary when `Summarize transcript` is on.

To bring the panel back later, run the command "Open progress panel". It reveals the panel in the right sidebar and restores the saved run history.

## Privacy & Data

Audio content is sent to Google’s Gemini API for transcription, and the transcript is sent again when it is summarized. The plugin does not store your audio or transcripts outside your vault. Keep your API key secure and review your organization’s data policies before use.

Run history is written to `progress-sessions.json` inside the plugin's own folder, alongside its settings. It holds the progress log — file paths, model names and API error messages — but never your API key or transcript text. Switch off "Keep run history" if you would rather nothing were written. Opening the same vault in two windows at once can leave whichever window writes last as the one that wins.

## Changelog

### Version 0.9.0

- **Dedicated transcription model**
  - Transcription now always runs on Google's speech-to-text model, `gemini-3.5-transcribe`. The `Model` setting now picks only the summary model
  - This model does not follow prompts, so the transcription prompt is gone. Without speaker labels the transcript comes back as one block of text
- **Transcription options**
  - `Mode`: Verbatim (default) keeps fillers and false starts; Smart removes them and tidies punctuation and lists
  - `Speaker labels`: a labelled paragraph per speaker, up to 8. Labels restart in every 20-minute chunk of a recording over 30 minutes
  - `Timestamps`: each paragraph starts with its time in the recording
  - `Custom vocabulary` and `Language hints` help with names, jargon and language detection
  - Options the API cannot combine are greyed out, with the reason in their description
- **Settings layout**
  - Settings are grouped into General, Transcription, Summary and Run history. The summary model shows only while `Summarize transcript` is on
- **Heads-up**
  - On a Free Tier API key this model allows 10,000 input tokens per minute — about 7 minutes of audio. A recording over 30 minutes is sent as parallel chunks and can hit that limit

### Version 0.8.1 — [release notes](https://github.com/cha-yh/transcription-audio-obsidian-plugin/releases/tag/0.8.1)

- **Settings layout**: run history settings got their own heading and no longer disappear when `Summarize transcript` is off

### Version 0.8.0 — [release notes](https://github.com/cha-yh/transcription-audio-obsidian-plugin/releases/tag/0.8.0)

- **Mobile support**
- **Simplified transcription settings**
- **Run history**
- **Model updates**: added `gemini-3.8-flash`, the new default
- **Fixes**

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
