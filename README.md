# Transcription Audio(Beta) Plugin for Obsidian

Turn your audio into structured Markdown notes inside Obsidian. This plugin detects an audio file linked in your current note, sends it to Gemini for transcription, summarization, or transcript generation, and inserts the result back into your note. A right-hand progress panel shows what’s happening step by step.

## Features

- Smart audio detection from links or embeds in the active note
- Google Gemini transcription, transcript generation, and summarization
- Prompt only, transcription, and transcription only modes
- Long-audio transcription with time-based chunking and chunk retry handling
- Category classification for transcript-based summarization
- Template prompt controls for consistent Markdown output
- Reusable transcript file creation and transcript file links
- Progress panel (sidebar) with live status:
  - Detected audio filename and size
  - Audio preparation status
  - API request start/completion times
  - Gemini usage logs (prompt/output/total tokens)
  - Cancel button to stop upload/API request in progress
  - Success/error result
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
- Transcription mode:
  - Prompt only mode (default): sends audio directly with the configured prompt
  - Transcription mode: transcribes audio first, then summarizes the raw transcript
  - Transcription only mode: creates the raw transcript and skips summarization
- Model: Select a Gemini-compatible model (`gemini-3.7-flash`(default), `gemini-3.6-flash`, `gemini-3.5-flash`, `gemini-3.5-flash-lite`, `gemini-3.1-pro-preview`, `gemini-3-flash-preview`)
- `gemini-3-pro-preview` is deprecated by Google and shuts down on March 9, 2026. Existing settings are automatically migrated to `gemini-3.1-pro-preview`.
- Prompt: Customize the instruction for Prompt only mode and transcript summarization
- Template prompt: Toggle in Prompt only mode to show Instructions and Output template fields for a consistent final markdown structure
- Category classification: Available in Transcription mode. When disabled, Transcription mode uses the same Prompt/Template prompt settings as Prompt only mode.

## Usage

1. In a note, linked file before your cursor, for example:
   - Wiki link: `![[example_audio.wav]]`
2. Place the cursor after the link.
3. Run the command: "Transcribe audio".
   <img alt="Image" src="https://github.com/user-attachments/assets/254e3621-4733-4961-ab90-ce58792d6cc6" />
4. A progress panel will automatically open in the right sidebar, showing real-time status updates including file upload progress, API request status, and transcription progress.
   <img alt="Image" src="https://github.com/user-attachments/assets/80010ac4-7473-4811-86d8-c84dc7fa05eb" />
5. When complete, the transcription, summary, or transcript link is inserted at your starting cursor position.

## Privacy & Data

Audio content is sent to Google’s Gemini API for processing. The plugin does not store your audio or transcripts outside your vault. Keep your API key secure and review your organization’s data policies before use.

## Changelog

### Version 0.7.1

- **Failed chunks no longer discard the run**
  - A chunk that fails stays in the transcription file as a placeholder and the run finalizes normally, so every chunk that already succeeded survives
  - Retry has no deadline — the Retry button on the chunk's log line re-runs it whenever you get to it, including while summarization is still running
  - Fixed a second failed chunk becoming impossible to retry once the first one had succeeded
- **Model updates**
  - Added `gemini-3.7-flash` (the new default), `gemini-3.6-flash`, and `gemini-3.5-flash-lite`, listed newest first
  - Removed `gemini-2.5-flash` and `gemini-2.5-pro`; a setting still pointing at either falls back to the default
- **Fixes**
  - Progress counts only the chunks actually sent, so a skipped range no longer inflates the numbering
  - Skipped ranges no longer show their `[No speech detected ...]` note in reading view

### Version 0.7.0

<img width="425" height="234" alt="Speech activity sparkline with chunk boundaries and a skipped range" src="https://github.com/user-attachments/assets/5a72875c-ffd3-4b6c-9ce0-dbf1449ed264" />

- **Speech-aware chunking**
  - Detects where speech actually occurs and plans chunks around it, so silent stretches are never sent to the model
  - Long silences split the recording into speech islands chunked independently, keeping a late remark after a long gap without dragging the gap along
  - Skipped ranges are recorded in the transcription file and can be transcribed later
- **Per-chunk retry**
  - Each chunk's log line gains a Retry button that re-runs only that chunk and rewrites only its region, leaving manual edits to other chunks intact
  - Reuses the uploaded file when it is still valid, so most retries skip the upload entirely
- **Progress log**
  - Added a sparkline showing speech activity, chunk boundaries, skipped ranges, and a per-chunk timeline
  - Log lines are prefixed with the chunk number and carry the chunk's time range, so parallel chunks can be told apart
- **Fixes**
  - Trailing chunks shorter than two minutes now fold into the previous chunk instead of costing a request that returns nothing
  - Fixed a `removeChild` error when the progress view was open while the plugin was disabled
  - Disabling the plugin no longer discards the progress view's sidebar placement
  - Transcript text containing `$&` or `` $` `` is no longer mangled when written to the transcription file

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
