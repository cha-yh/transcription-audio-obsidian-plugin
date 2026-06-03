# Audio-to-Note Transcription Pipeline

## Initialization

- User invokes the "Transcribe audio" command while the cursor is in a Markdown note
- Plugin resolves the API key from the selected API key entry
- The processing mode selects Prompt only, Transcription, or Transcription only behavior
- Prompt only mode can optionally use a template prompt and output template
- `TranscriptionController.run()` is called with the editor context, resolved API key, prompt, model, output template, and mode-derived feature flags

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

## Transcription — Branch by Processing Mode

### Path A: PCM16 WAV Chunking (PCM16 WAV file without output template)

- The WAV header is parsed to extract sample rate, channels, bit depth, and data size
- `computeWavChunkRanges()` divides the audio into byte-sized chunks (targeting 10 MB each, clamped to 2–8 minutes, with 1.5 s overlap)
- Each chunk is processed sequentially:
  - The WAV is sliced into a new valid WAV buffer for the chunk's time range
  - The chunk buffer is base64-encoded and uploaded to Google via the resumable upload API
  - The Gemini model transcribes the chunk using a transcription-only prompt with thinking disabled
- Chunk results are concatenated with part markers; failed chunks embed an inline error placeholder
- The combined text becomes the final transcript

### Path B: Transcription Mode

- **Existing transcript check**: Looks for a previously saved `_transcription_*.md` file for the same audio; if found, the transcription step is skipped entirely
- **Audio preparation**: If the file is not already PCM16 WAV, it is decoded via `AudioContext` and re-encoded to 16 kHz mono PCM16 WAV
- **Short audio (< 30 min)**: A single transcription request is made using the original file format with a transcription-only prompt
  - The raw transcript is saved to a temp file and immediately finalized (renamed from `_temp.md` to `.md`)
- **Long audio (≥ 30 min)**: Time-based chunking splits the audio into 20-minute segments with 1.5 s overlap
  - A temp file is created with `{{CHUNK_PENDING:N}}` placeholders for each chunk
  - All chunks are launched in parallel — each slices the WAV, uploads, and transcribes independently
  - A serial write queue ensures concurrent chunk completions update the temp file without race conditions; each completion replaces its pending placeholder with actual text
  - Failed chunks are marked as `{{CHUNK_FAILED:N}}` in the temp file and queued for user-initiated retry via the progress bus
  - After all chunks settle, quota errors are surfaced immediately; cancellation aborts the entire flow
- **Classification step** (if category classification is enabled):
  - The raw transcript is sent to the Gemini model with a list of enabled category names
  - The model returns a single category name; if unrecognized, it falls back to General
  - The detected category is written into the transcription file's YAML frontmatter
  - On failure, the step pauses and waits for a retry event from the progress bus
- **Prompt selection without classification**:
  - The same Prompt/Template prompt settings used by Prompt only mode are used for all transcripts
- **Summarization step**:
  - The prompt for the matched category, or the configured prompt when classification is disabled, is selected
  - The raw transcript is sent to the Gemini model with the category-specific prompt
  - On failure, the step pauses and waits for a retry event from the progress bus
  - The summarized text becomes the final transcript
- **Transcription only mode**:
  - The raw transcript file is finalized and linked without running classification or summarization

### Path C: Prompt Only Mode

- The audio buffer is base64-encoded and uploaded via the resumable upload API
- A single Gemini request is made with the user's prompt (or template-augmented prompt if an output template is set)
- The response text becomes the final transcript

## File Upload (shared across all paths)

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
