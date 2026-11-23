# SABR/UMP proof of concept

A working PoC of the technique described in r/ReverseEngineering thread
[`1y2p3im`](https://www.reddit.com/r/ReverseEngineering/comments/1y2p3im/githubreversing_youtubes_sabr_ump_container/)
("Reversing YouTube's SABR: UMP container, PO-token binding, and playing it
on-device through a hidden youtube.com page"), which documents how
[biolend83/tubehaus](https://github.com/biolend83/tubehaus) streams YouTube
through SABR, the protocol youtube.com itself uses.

Full thread capture (all 5 comments, nothing missing) is in `thread/`.

## What the PoC proves, end to end

Run against a live video (Big Buck Bunny, CC-BY) on 2026-11-23:

1. **Watch-page player response** (`ytInitialPlayerResponse`, WEB client) gives
   `serverAbrStreamingUrl` — one address for the whole stream, with an `n`
   parameter that is scrambled.
2. **`n` unscrambled** with the player `base.js` transform (youtubei.js
   `Player.decipher`). In-page this needs a Trusted Types default policy:
   `new Function` is blocked on youtube.com otherwise.
3. **BotGuard challenge** pulled from the youtube.com home page (`ytAtN`),
   interpreter VM loaded through a `<script>` tag, snapshot taken, integrity
   token from `GenerateIT` (ttl ~12 h), **PO token minted bound to the video
   ID**.
4. **`window.yt.config_` must hold the home page's `ytcfg`** — without it every
   token is turned down (`STREAM_PROTECTION_STATUS status=3`, nine in a row in
   testing). With it: `status=1` (accepted) for the whole session.
5. **SABR conversation**: protobuf `VideoPlaybackAbrRequest` POSTs, body sent
   as `text/plain` so the browser skips the CORS preflight (one of the
   thread's "cost a day to find" notes, confirmed).
6. **UMP parsed**: `FORMAT_INITIALIZATION_METADATA`, `MEDIA`/`MEDIA_END`
   pieces, `NEXT_REQUEST_POLICY`, `STREAM_PROTECTION_STATUS`.
7. Result of a 30 s capture: **54.5 MB video in 117 UMP pieces + 9.9 MB audio
   in 62 pieces**, first video bytes `1a 45 df a3` — EBML magic, valid WebM.

Observed logs from the validated in-page run:

```
[player] playability: OK | title: Big Buck Bunny 60fps 4K
[player] serverAbrStreamingUrl host rr2---sn-npobuxa-npoey.googlevideo.com | n param locked: true
[player] n param unscrambled with player base.js (EJS solver)
[botguard] challenge fetched, interpreter VM loaded via <script> tag
[botguard] integrity token via GenerateIT, ttl ~43200s
[po-token] minted, bound to video ID (120 chars)
[sabr] video itag 247 video/webm; codecs="vp9"
[sabr] audio itag 251 audio/webm; codecs="opus"
[ump] STREAM_PROTECTION_STATUS status=2 (pending)
[ump] FORMAT_INITIALIZATION_METADATA
[ump] STREAM_PROTECTION_STATUS status=1 (PO token ACCEPTED)   <- repeats for the whole session
[done] video: 54561862 bytes in 117 UMP MEDIA pieces | audio: 9877427 bytes in 62 pieces
```

## Files

- `poc-page.mjs` — the in-page version. Runs on a `youtube.com` origin page
  (this is the thread's "hidden youtube.com page" architecture: BotGuard and
  YouTube's servers see a real browser on youtube.com). Bundle it and inject
  it into any youtube.com tab:
  ```bash
  npm install
  npx esbuild poc-page.mjs --bundle --minify --format=iife \
    --platform=browser --target=es2022 --outfile=poc-bundle.js
  # load poc-bundle.js in a youtube.com tab, then in the console:
  trustedTypes.createPolicy('default', { createScript: (s) => s, createScriptURL: (s) => s });
  await sabrPocRun('aqz-KE-bpKQ', 30)   // videoId, seconds
  ```
- `poc.mjs` — Node version (jsdom for BotGuard, same stack). Works only from
  an IP YouTube hasn't walled; from a datacenter IP the WEB player endpoint
  answers `LOGIN_REQUIRED` ("Sign in to confirm you're not a bot"), which is
  the wall the thread's WARP section is about. The in-page version from a
  normal browser session is the reliable path.
  ```bash
  node poc.mjs [videoId] [seconds]
  ```

## Stack / credits

- [youtubei.js](https://github.com/LuanRT/YouTube.js) — InnerTube client,
  player `n`-param decipher
- [googlevideo](https://github.com/LuanRT/googlevideo) (MIT) — UMP
  reader/writer, SABR protobufs, `SabrStream`
- [bgutils-js](https://github.com/LuanRT/BgUtils) — BotGuard client, PO-token
  minter
- Thread author: u/lovespeedtest; project: AGPL-3.0 TubeHaus

## Notes / limits

- Personal-research PoC. It talks to YouTube the way YouTube's own site does,
  without an account. YouTube's ToS is its own thing; don't use this to
  hammer them, and expect it to break when they rotate client versions.
- Age-restricted and members-only videos are out of scope (no account).
- If `status=3` (attestation failed) appears three times in a row, re-check
  that `window.yt.config_` carries the home page's fresh `ytcfg`.

## Shorts Lab site (`docs/`)

A static Skool-style learning site built on this PoC: paste a YouTube video,
clip it into captioned vertical shorts in the browser, and file them under
DataCamp course topics. No server: video bytes come from the bridge below,
all rendering happens in-page with ffmpeg.wasm, clips live in IndexedDB.

- `docs/index.html` - Library. Sidebar of topics (config: `docs/topics.json`),
  grid of playable/downloadable shorts.
- `docs/studio.html` - Studio. Source -> pick clips on the transcript
  (or auto-split) -> render 9:16 captioned MP4s -> save to the library.
- `bridge/bridge.mjs` - console-paste bridge derived from `poc-page.mjs`.
  Run it on a youtube.com watch page: it mints the PO token, pulls the SABR
  stream plus the caption track, downloads the files and postMessages the
  buffers to an open studio tab. Build with `npm run build:bridge`.
- `docs/assets/` - a 24 s sample clip + VTT so the render pipeline can be
  tried with no YouTube fetch at all.

Limits: the bridge needs a normal browser session on youtube.com (datacenter
IPs get walled), so the capture step is desktop-only; on mobile, drop files
in instead. ffmpeg.wasm is the single-thread build (static hosts like
surge.sh cannot send COOP/COEP headers), so a 45 s 720p clip renders in
roughly 1-3 min on desktop. YouTube ToS is its own thing - this is a
personal-research project, do not hammer them.
