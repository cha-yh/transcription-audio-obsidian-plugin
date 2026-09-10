# Audio-to-Note Transcription Pipeline

## Initialization

- User invokes the "Transcribe audio" command while the cursor is in a Markdown note
- Plugin resolves the API key from the selected API key entry
- A transcript is always generated; the summary setting controls whether it is summarized afterwards
- `TranscriptionController.run()` is called with the editor context and a `TranscriptionRunOptions` object carrying the resolved API key, default prompt, model, and the summary/classification settings

## Pre-flight Validation

- The active file and cursor position are captured
- Text from the start of the file to the cursor is scanned with `AUDIO_FILE_REGEX` to find the last audio link (wiki-link or markdown-link)
- The audio file path is resolved through the Obsidian vault — first by exact path, then by filename lookup across all files
- Validation gates check for: active file exists, audio file extension is recognized, no concurrent transcription is running, and API key is present
- An `AbortController` is created and wired to the progress bus so the user can cancel at any point

## Audio Reading and Format Detection

- The progress view panel is opened in the right sidebar
- The audio file is read as a binary `ArrayBuffer` from the vault
- The MIME type is resolved from the file extension (mp3, mp4, m4a, wav, webm, etc.)
- The buffer is inspected to determine if it is a PCM 16-bit WAV file (checks RIFF/WAVE header and fmt chunk)

## Transcription

The transcription step always runs, and always leaves a `_transcription_*.md`
file beside the note. There is one pipeline: the two audio sources differ only
in how the chunk ranges are chosen, and everything after that is shared.

### Reusing an existing transcript

- Looks for a previously saved `_transcription_*.md` file for the same audio; if found, the transcription step is skipped entirely and the category stored in its frontmatter is reused (read through `metadataCache`, so a cold cache just means the transcript is classified again)
- Files still named `_temp.md` are ignored, which is how an unfinished transcript avoids being reused
- A file whose chunks are all unresolved placeholders reads as empty and is not reused either

### Preparation: getting a PCM16 WAV and a duration

- A PCM16 WAV is already what the chunker cuts, so its header supplies the duration and the buffer is used as-is — no decode
- Anything else is decoded via `AudioContext` and re-encoded to 16 kHz mono PCM16 WAV. This is the only step that depends on a browser audio API, and the only one whose behaviour can differ between desktop and a mobile WebView
- Either step can fail — an unreadable WAV header, or a format the platform cannot decode. Both leave no duration to compare and no WAV to cut, and the file goes up whole in a single request rather than failing the run

### Choosing the chunk ranges

- **Source PCM16 WAV**: `computeWavChunkRanges()` cuts by size (targeting 8 MB, clamped to 2–8 minutes, 1.5 s overlap), and cuts regardless of duration. The recorder chose the bitrate and it can be ten times the decoder's 16 kHz mono, so duration alone says little about how large one request would be
- **Decoded audio**: cut only once it reaches 30 minutes, into speech-aware 20-minute segments with 1.5 s overlap — ranges holding no speech are marked skipped and never sent to the model
- Under those thresholds, or when the plan comes out empty, the file goes up whole in a single request whose raw transcript is saved to a temp file and immediately finalized

### Running the chunks (shared)

- A temp file is created up front with `{{CHUNK_PENDING:N}}` placeholders, each already wrapped in its `%%chunk:N%%` markers, so completed work is on disk before the run ends
- Chunks are transcribed `MAX_CONCURRENT_CHUNKS` (4) at a time — each slices the WAV, uploads, and transcribes independently
- A serial write queue ensures concurrent completions update the temp file without racing; each completion replaces its pending placeholder with actual text
- Failed chunks are marked `{{CHUNK_FAILED:N}}` and queued for user-initiated retry via the progress bus; the run finalizes normally so every chunk that succeeded survives
- After all chunks settle, quota errors are surfaced immediately; cancellation aborts the entire flow
- The file is finalized (renamed from `_temp.md` to `.md`) and a rerun session is recorded, which is what makes the Retry button on a chunk's log line work

## Classification and Summarization

Both steps are skipped when the summary setting is off, and when the transcript
came out empty because every chunk failed — the transcript file is linked into
the note and nothing else runs, rather than billing two requests to summarize
nothing.

The transcript handed to the model has its `%%chunk:n%%` markers, skip notes and
pending/failed placeholders stripped by `stripChunkMarkers`; the file keeps them,
because they are what makes per-chunk retry possible.

- **Classification step** (if category classification is enabled):
  - The raw transcript is sent to the Gemini model with a list of enabled category names
  - The model returns a single category name; if unrecognized, the default prompt is used
  - The detected category is written into the transcription file's YAML frontmatter through `fileManager.processFrontMatter`, so Obsidian serializes the value — the name is unvalidated model output and could otherwise break the block. A block it cannot parse is logged and skipped rather than failing the step, and the `audio:` path the plugin writes is quoted so it stays parseable
  - On failure, the step pauses and waits for a retry event from the progress bus
- **Prompt selection without classification**:
  - The configured default prompt is used for all transcripts
- **Summarization step**:
  - The prompt for the matched category, or the configured default prompt when classification is disabled or matched nothing, is selected
  - The raw transcript is sent to the Gemini model with that prompt
  - On failure, the step pauses and waits for a retry event from the progress bus
  - The transcript file link followed by the summarized text becomes the final output

## File Upload (shared across all strategies)

- A resumable upload session is initiated against `generativelanguage.googleapis.com`
- The audio blob is sent in 8 MB chunks; each chunk includes an upload offset header
- The final chunk receives a `finalize` command and returns the file URI, MIME type, and expiration time
- The uploaded file info can be cached and reused for retries within the same run to avoid re-uploading

## Output and Completion

- The final transcript text is inserted into the active Markdown file at the original cursor position via `appendTextToFile()`
- A success event is published to the progress bus
- The `writing` lock is released

## Cancellation and Error Handling

- Cancellation can occur at any checkpoint: before upload, between chunks, and during API requests
  - The `AbortSignal` is propagated to both `fetch` calls and Gemini SDK calls
  - On cancel, the temp file (if any) is deleted and a "cancelled" event is published
- Quota errors (`429` / `RESOURCE_EXHAUSTED`) are wrapped into `TranscriptionQuotaError` and surfaced to the user; the temp file is cleaned up
- General API errors are caught, logged, and reported through the progress bus as an error event
