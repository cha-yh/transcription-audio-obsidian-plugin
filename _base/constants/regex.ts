/** Audio formats the plugin can transcribe, as lowercase file extensions. */
export const AUDIO_FILE_EXTENSIONS = [
  "mp3",
  "mp4",
  "mpeg",
  "mpga",
  "m4a",
  "wav",
  "webm",
];

export function isAudioFileExtension(extension: string): boolean {
  return AUDIO_FILE_EXTENSIONS.indexOf(extension.toLowerCase()) >= 0;
}

const AUDIO_EXTENSION_GROUP = `(${AUDIO_FILE_EXTENSIONS.join("|")})`;

// Avoid lookbehind for iOS < 16.4 compatibility
// 1) Wiki/Embed: [[path.ext]] or ![[path.ext]] → capture group 1 is the full path with extension
// 2) Markdown link: [label](path.ext) → capture group 1 is the full path with extension
export const AUDIO_FILE_REGEX = [
  new RegExp(`\\[\\[([^\\[\\]]+\\.${AUDIO_EXTENSION_GROUP})\\]\\]`, "gi"),
  new RegExp(
    `\\[[^\\]]*\\]\\(((?:[^()\\r\\n]+)\\.${AUDIO_EXTENSION_GROUP})\\)`,
    "gi"
  ),
];
