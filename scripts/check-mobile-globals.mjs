/**
 * Fails when the production bundle references a global that exists on desktop
 * Obsidian (Electron, which ships Node) but not on mobile (a Capacitor WebView).
 *
 * esbuild marks every Node builtin as external, so a dependency that requires
 * "fs" — or our own code touching `Buffer` — passes typecheck, unit tests and
 * the build without a word, then throws at runtime on a phone. Scanning the
 * bundle is the only check that covers dependencies too.
 *
 * See docs/mobile-support.md. Reported by issue #3 ("Buffer is not defined").
 */
import { readFileSync, existsSync } from "fs";
import path from "path";

const BUNDLE = path.resolve(process.argv[2] || "main.js");

const NODE_BUILTINS = [
  "assert", "buffer", "child_process", "cluster", "console", "crypto", "dgram",
  "dns", "domain", "events", "fs", "http", "http2", "https", "module", "net",
  "os", "path", "perf_hooks", "process", "punycode", "querystring", "readline",
  "repl", "stream", "string_decoder", "timers", "tls", "tty", "url", "util",
  "v8", "vm", "worker_threads", "zlib",
].join("|");

/**
 * The lookbehind is what makes this usable: a naive /Buffer/ matches
 * `ArrayBuffer`, `audioBuffer`, `decodedBuffer` and friends — 54 hits on a
 * bundle whose only real problem was a single `Buffer.from`.
 */
const FORBIDDEN = [
  { name: "Buffer", re: /(?<![A-Za-z0-9_$.])Buffer\s*[.(]/g },
  { name: "new Buffer", re: /new\s+Buffer\s*\(/g },
  { name: "process", re: /(?<![A-Za-z0-9_$.])process\s*\./g },
  { name: "__dirname", re: /(?<![A-Za-z0-9_$.])__dirname\b/g },
  { name: "__filename", re: /(?<![A-Za-z0-9_$.])__filename\b/g },
  { name: "global", re: /(?<![A-Za-z0-9_$.])global\s*\./g },
  { name: "setImmediate", re: /(?<![A-Za-z0-9_$.])setImmediate\s*\(/g },
  {
    name: "node builtin require",
    re: new RegExp(`require\\s*\\(\\s*["'](?:node:[a-z_/]+|${NODE_BUILTINS})["']\\s*\\)`, "g"),
  },
  { name: "electron require", re: /require\s*\(\s*["']electron["']\s*\)/g },
];

if (!existsSync(BUNDLE)) {
  console.error(`check-mobile-globals: ${BUNDLE} not found. Run the build first.`);
  process.exit(1);
}

const raw = readFileSync(BUNDLE, "utf8");

// The inline sourcemap is ~3x the size of the code and embeds the original
// TypeScript, so scanning it would be slow and would match our own comments.
const mapIndex = raw.indexOf("//# sourceMappingURL=");
const code = mapIndex >= 0 ? raw.slice(0, mapIndex) : raw;

const lineStarts = [0];
for (let i = 0; i < code.length; i++) {
  if (code[i] === "\n") lineStarts.push(i + 1);
}
const lineOf = (index) => {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStarts[mid] <= index) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
};

const hits = [];
for (const { name, re } of FORBIDDEN) {
  for (const match of code.matchAll(re)) {
    const line = lineOf(match.index);
    const start = lineStarts[line - 1];
    // Dev builds inline the API keys via `define`, so never print a whole line.
    const snippet = code.slice(start, start + 100).trimEnd();
    hits.push({ name, line, snippet });
  }
}

if (hits.length === 0) {
  console.log(
    `check-mobile-globals: ${path.basename(BUNDLE)} is free of desktop-only globals ` +
      `(${(code.length / 1024).toFixed(0)} KB scanned).`
  );
  process.exit(0);
}

console.error(
  `check-mobile-globals: ${hits.length} desktop-only global reference(s) in ${path.basename(BUNDLE)}.\n` +
    `These work in Electron but throw in the mobile WebView.\n`
);
for (const { name, line, snippet } of hits) {
  console.error(`  ${name}  ${path.basename(BUNDLE)}:${line}`);
  console.error(`    ${snippet}\n`);
}
process.exit(1);
