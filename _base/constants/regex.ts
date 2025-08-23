export const AUDIO_FILE_REGEX = [
  /(?<=\[\[)(([^\[\]])+)\.(mp3|mp4|mpeg|mpga|m4a|wav|webm)(?=]])/g,
  /(?<=\[(.*)]\()(([^\[\]])+)\.(mp3|mp4|mpeg|mpga|m4a|wav|webm)(?=\))/g,
];
