# Transcription Audio(Beta) Plugin for Obsidian

Turn your audio into structured Markdown notes inside Obsidian. This plugin detects an audio file linked in your current note, sends it to Gemini for transcription and summarization, and inserts the result back into your note. A right-hand progress panel shows what’s happening step by step.

## Features

- Smart audio detection from links or embeds in the active note
- Google Gemini transcription and summarization
- Progress panel (sidebar) with live status:
  - Detected audio filename and size
  - Audio preparation status
  - API request start/completion times
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

- API Key: Your Google AI API key (get one at [https://aistudio.google.com/api-keys](https://aistudio.google.com/api-keys))
- Model: Select a Gemini-compatible model
- Prompt: Customize the instruction sent before your audio content

## Usage

1. In a note, linked file before your cursor, for example:
   - Wiki link: `![[example_audio.wav]]`
2. Place the cursor after the link.
3. Run the command: "Transcribe audio".
<img alt="Image" src="https://github.com/user-attachments/assets/254e3621-4733-4961-ab90-ce58792d6cc6" />
4. A progress panel will automatically open in the right sidebar, showing real-time status updates including file upload progress, API request status, and transcription progress.
<img alt="Image" src="https://github.com/user-attachments/assets/80010ac4-7473-4811-86d8-c84dc7fa05eb" />
5. When complete, the transcription and notes are inserted at your starting cursor position.

## Privacy & Data

Audio content is sent to Google’s Gemini API for processing. The plugin does not store your audio or transcripts outside your vault. Keep your API key secure and review your organization’s data policies before use.

## Changelog

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
