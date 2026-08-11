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
- Model: Select a Gemini-compatible model (`gemini-2.5-flash`, `gemini-2.5-pro`, `gemini-3-flash-preview`, `gemini-3.1-pro-preview`, `gemini-3.5-flash`)
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

### Version 0.7.0

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

### Version 0.6.0

- **Transcription workflows**
  - Added a transcribe-then-summarize workflow that creates reusable transcript files before summarization
  - Added Transcription only mode for raw transcript generation without summarization
  - Consolidated transcription mode settings and prompt/template prompt controls
- **Long-audio support**
  - Added time-based chunking for long audio files
  - Added parallel chunk processing, temp file updates, and chunk retry handling
- **Category prompts**
  - Added category classification and category-specific prompts for transcript summarization
  - Uses the same Prompt/Template prompt controls as Prompt only mode when category classification is disabled
- **Model and settings updates**
  - Added cached upload reuse and upload metadata logging
  - Added the `gemini-3.5-flash` model option
  - Removed the deprecated plain-text API key setting
  - Added transcript file links in generated output and removed embedded transcript links
- **Fixes**
  - Fixed cancellation and retry cleanup across transcription, chunk retry, classification, and summarization flows
  - Fixed quota error handling and temporary transcription file cleanup
  - Fixed Obsidian reload/resource cleanup issues that could trigger `offref` errors
  - Stabilized settings loading and propagated Obsidian file write failures to callers

### Version 0.5.0

- **Transcription mode enhancements**
  - Added Template prompt support so prompt and output template can be configured separately
- **Gemini 3 Pro Preview migration**
  - Added automatic migration from `gemini-3-pro-preview` to `gemini-3.1-pro-preview`
  - Updated related settings and documentation for current model options

### Version 0.4.1

- **Gemini 3 Pro Preview migration**
  - Replaced `gemini-3-pro-preview` with `gemini-3.1-pro-preview` in model selection
  - Automatically migrates previously saved `gemini-3-pro-preview` setting to `gemini-3.1-pro-preview`

### Version 0.4.0

- **Secure API key support**
  - Added Obsidian API key selection
- **Cancelable transcription flow**
  - Added cancel control in the progress panel
  - Improved cancellation handling for upload/request steps
- **Progress panel navigation improvements**
  - File and Target entries are clickable links
  - Target navigation moves to the exact line/character position
- **Progress log improvements**
  - Added localized timestamp to the initial `Log start` line
- **Gemini usage visibility**
  - Added token usage logs (prompt/output/total and related token fields) in progress detail

### Version 0.3.0

- **Add gemini-3-flash-preview(default) model to settings**
- **Enhanced Progress Tracking**: Improved transcription process with detailed progress tracking and UI updates
  - Enhanced progress panel with more detailed status information
  - Better visual feedback during transcription process
  - Improved error handling and status reporting
- **Updated Default Settings**: Updated default settings with new model and refined prompt structure
  - Optimized default model selection
  - Improved prompt structure for better transcription quality

## License

This project is licensed under the MIT License.
