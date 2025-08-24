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

- A Google AI API key for Gemini

## Getting started

1. Open Obsidian Settings
2. Navigate to "Community plugins" and click "Browse"
3. Search for "Transcription Audio" and click Install
4. Enable the plugin in Community plugins
5. Set up your API key in plugin settings

## Configuration

Open Settings → Transcription Audio:

- API Key: Your Google AI API key
- Model: Select a Gemini-compatible model
- Prompt: Customize the instruction sent before your audio content

## Usage

1. In a note, linked file before your cursor, for example:
   - Wiki link: `![[example_audio.wav]]`
2. Place the cursor after the link.
3. Run the command: “Transcribe audio”.
4. Watch progress in the right sidebar panel. When complete, the transcription and notes are inserted at your starting cursor position.

## License

This project is licensed under the MIT License.
