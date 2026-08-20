# Mobile support

Notes for maintaining the plugin on iOS and Android. Desktop Obsidian is
Electron and ships Node; mobile Obsidian is a Capacitor WebView and does not.
Anything that only exists on one side has to be kept out of the runtime path.

## The guard

`yarn check:mobile` scans the built bundle for globals that exist on desktop
but not on mobile — `Buffer`, `process`, `__dirname`, node builtin `require`,
and friends. It runs in CI and in the release workflow.

It scans the **bundle**, not the sources, on purpose. `esbuild.config.mjs`
marks every Node builtin as external, so a dependency doing `require("fs")`
survives typecheck, unit tests and the build without a word and only fails on a
phone. Source-level checks cannot see that.

Two details make the scanner usable: it strips the inline sourcemap (three
quarters of `main.js`) before matching, and its patterns use a lookbehind to
exclude a preceding identifier character or dot. Without the lookbehind,
`ArrayBuffer` and `audioBuffer` produce dozens of false hits.

Note what the unit tests do **not** prove: Vitest runs in a Node environment,
so `Buffer` is present there. Switching the environment to jsdom would not help
either — vitest leaves globals that already exist on `globalThis` alone.

## Decisions

**Uploads pass a `Blob`, never base64.** The resumable upload only needs `size`
and `slice`, and the bytes already arrive as an `ArrayBuffer` from
`vault.readBinary`. Encoding to base64 in between cost an extra copy at ~1.37x
and required `Buffer` to decode — the cause of
[#3](https://github.com/cha-yh/transcription-audio-obsidian-plugin/issues/3).

**`fetch`, not `requestUrl`.** Obsidian offers `requestUrl` to bypass CORS, and
the upload sends custom `X-Goog-Upload-*` headers and reads a response header,
which is exactly the shape CORS can block. It was measured on Android instead of
assumed: the request goes through and `x-goog-upload-url` is readable, so plain
`fetch` stays. If a future WebView blocks it, `requestUrl` can carry this
protocol — its response exposes all headers and it accepts an `ArrayBuffer`
body — but it has no `AbortSignal`, so cancellation would need to be layered on.

**No `audioContext.resume()`.** `decodeAudioData` works on a suspended context.
On iOS `resume()` waits for a user gesture and, when there is none, neither
resolves nor rejects — the run would hang at "preparing audio" with nothing to
show.

**Chunks are sliced by reference and capped at four in flight.** Slices are
`Blob.slice` views over the decoded WAV rather than copies, and the pool keeps
peak memory flat as recordings get longer. Neither depends on the platform:
desktop and mobile run the identical path.

## Testing on a device

Build with a separate plugin id so the test build can sit next to the real one:

```sh
OBSIDIAN_PLUGINS_PATH=<staging dir> yarn dev:test   # id: transcription-audio-test
```

**Android** — push the three files and restart Obsidian (a new plugin folder is
not picked up otherwise):

```sh
adb push main.js manifest.json styles.css \
  /sdcard/<Vault>/.obsidian/plugins/transcription-audio-test/
```

Attach a debugger from desktop Chrome at `chrome://inspect` → `md.obsidian`.
For memory problems: `adb logcat | grep -iE "lowmemorykiller|am_kill|OutOfMemory"`.

**iOS** — put the vault in iCloud Drive and point `OBSIDIAN_PLUGINS_PATH` at
`~/Library/Mobile Documents/iCloud~md~obsidian/Documents/<Vault>/.obsidian/plugins`,
so `yarn dev:test` syncs on every save. Inspect via Safari → Develop, after
enabling Web Inspector on the device.

The API key is stored per device; the desktop one does not travel.

## Probing a device before transcribing

Most platform risks can be settled in the console without running a
transcription:

```js
typeof Buffer                       // "undefined" on mobile
new AudioContext().state
(() => { try { new OfflineAudioContext(1, 16000, 16000); return "OK"; }
         catch (e) { return e.name + ": " + e.message; } })()
```

`OfflineAudioContext` at 16 kHz is the one worth checking on a new iOS version:
WebKit used to restrict the rate to 44100–96000 and would throw here. If it ever
does, drop `OfflineAudioContext` and resample from `decodedBuffer.getChannelData(0)`
directly.

To check the upload endpoint without a file, POST the resumable `start` request
by hand and look at `r.headers.get("x-goog-upload-url")`. A `null` there with a
200 status means the request went out but the header was not exposed. Check
`generateContent` separately — it goes through the SDK's own `fetch`, so fixing
the upload alone would not help if that is blocked.

## Verified

| | Result |
| --- | --- |
| Android 16, Galaxy S25 (SM-S931N) | Probe as expected, transcription succeeds |
| iOS | Not yet run on a device |

Sub-30-minute m4a and template mode have not been exercised on desktop either;
both differ from covered paths only by which branch selects them.
