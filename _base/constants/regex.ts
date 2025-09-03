// Avoid lookbehind for iOS < 16.4 compatibility
// 1) Wiki/Embed: [[path.ext]] or ![[path.ext]] → capture group 1 is the full path with extension
// 2) Markdown link: [label](path.ext) → capture group 1 is the full path with extension
export const AUDIO_FILE_REGEX = [
  /\[\[([^\[\]]+\.(mp3|mp4|mpeg|mpga|m4a|wav|webm))\]\]/gi,
  /\[[^\]]*\]\(((?:[^()\r\n]+)\.(mp3|mp4|mpeg|mpga|m4a|wav|webm))\)/gi,
];
