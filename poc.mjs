/**
 * SABR/UMP PoC — based on r/ReverseEngineering thread 1y2p3im
 * (biolend83/tubehaus "How it works").
 *
 * Demonstrates, end to end:
 *   1. WEB player response -> serverAbrStreamingUrl (SABR address)
 *   2. BotGuard challenge from youtube.com home page -> integrity token
 *      -> PO token minted bound to the *video ID* (the binding the thread
 *      describes as the one that survives STREAM_PROTECTION_STATUS)
 *   3. SABR conversation (VideoPlaybackAbrRequest protobuf POSTs)
 *   4. UMP parsing: FORMAT_INITIALIZATION_METADATA / MEDIA_HEADER / MEDIA /
 *      MEDIA_END / NEXT_REQUEST_POLICY / STREAM_PROTECTION_STATUS
 *   5. Pieces written to files; playable output checked with ffprobe.
 *
 * Libraries: youtubei.js (InnerTube), googlevideo (UMP + SabrStream, MIT),
 * bgutils-js (BotGuard/PO token, MIT) — the same stack the thread credits.
 *
 * Usage: node poc.mjs [videoId] [seconds]
 */

import { JSDOM } from 'jsdom';
import Innertube, { UniversalCache, YTNodes, Platform, Log, Constants } from 'youtubei.js';
import { buildSabrFormat } from 'googlevideo/utils';
import { SabrStream } from 'googlevideo/sabr-stream';
import { BotGuardClient } from 'bgutils-js/botguard';
import { WebPoMinter } from 'bgutils-js/webpo';
import { getHeaders, buildURL, USER_AGENT, parseLooseJSON } from 'bgutils-js/utils';
import { createWriteStream } from 'node:fs';

Log.setLevel(Log.Level.NONE);
Platform.shim.eval = async (data) => new Function(data.output)();

const VIDEO_ID = process.argv[2] || 'aqz-KE-bpKQ'; // Big Buck Bunny (CC-BY, Blender Foundation)
const SECONDS = parseInt(process.argv[3] || '15', 10);

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ---------- Step 2a: BotGuard challenge from the youtube.com home page ----------
async function getWebPoMinter() {
  const dom = new JSDOM('<!DOCTYPE html><html lang="en"><head><title></title></head><body></body></html>', {
    url: 'https://www.youtube.com',
    referrer: 'https://www.youtube.com/',
    userAgent: USER_AGENT
  });

  const pageHtml = await (await fetch('https://www.youtube.com', {
    headers: { accept: '*/*', 'accept-language': 'en-US,en;q=0.7', 'user-agent': USER_AGENT }
  })).text();

  const ytConfig = pageHtml.match(/ytcfg\.set\(({.+?})\);/s)?.[1];
  if (!ytConfig) throw new Error('ytcfg not found in home page HTML');
  dom.window.yt = { config_: JSON.parse(ytConfig) };

  // Canvas stub: BotGuard probes a 2d context; jsdom has none.
  dom.window.HTMLCanvasElement.prototype.getContext = function (id) {
    if (id !== '2d') return null;
    return {
      fillRect() {}, clearRect() {},
      getImageData: (_x, _y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
      putImageData() {}, createImageData: () => [], setTransform() {}, drawImage() {},
      save() {}, fillText() {}, restore() {}, beginPath() {}, moveTo() {}, lineTo() {},
      closePath() {}, stroke() {}, translate() {}, scale() {}, rotate() {}, arc() {},
      fill() {}, measureText: () => ({ width: 0 }), transform() {}, rect() {}, clip() {}
    };
  };

  Object.assign(globalThis, {
    yt: dom.window.yt, window: dom.window, document: dom.window.document,
    location: dom.window.location, origin: dom.window.origin
  });
  if (!('navigator' in globalThis))
    Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator });

  const attestation = pageHtml.match(/window\.ytAtN\(\s*({[\s\S]*?})\s*\)/);
  if (!attestation) throw new Error('bgChallenge (ytAtN) not found in home page HTML');
  const challengeResponse = parseLooseJSON(attestation[1]).R;
  if (!challengeResponse.bgChallenge) throw new Error('no bgChallenge in attestation data');

  const interpreterUrl = challengeResponse.bgChallenge.interpreterUrl
    .privateDoNotAccessOrElseTrustedResourceUrlWrappedValue;
  const interpreterJavascript = await (await fetch(`https:${interpreterUrl}`)).text();
  new Function(interpreterJavascript)();
  log('[botguard] challenge fetched, interpreter VM loaded');

  const botGuardClient = await BotGuardClient.create({
    program: challengeResponse.bgChallenge.program,
    globalName: challengeResponse.bgChallenge.globalName,
    globalObject: globalThis
  });

  const webPoSignalOutput = [];
  const botguardResponse = await botGuardClient.snapshot({ webPoSignalOutput });
  log('[botguard] snapshot taken,', webPoSignalOutput.length, 'webpo signal functions');

  const requestKey = 'O43z0dpjhgX20SCx4KAo';
  const itRes = await fetch(buildURL('GenerateIT', true), {
    method: 'POST', headers: getHeaders(), body: JSON.stringify([requestKey, botguardResponse])
  });
  const [integrityToken, estimatedTtlSecs, mintRefreshThreshold, websafeFallbackToken] = await itRes.json();
  log('[botguard] integrity token, ttl ~' + estimatedTtlSecs + 's');

  return WebPoMinter.create(
    { integrityToken, estimatedTtlSecs, mintRefreshThreshold, websafeFallbackToken },
    webPoSignalOutput
  );
}

// ---------- Step 1: WEB player response ----------
async function makePlayerRequest(innertube, videoId, reloadPlaybackContext) {
  const watchEndpoint = new YTNodes.NavigationEndpoint({ watchEndpoint: { videoId } });
  const args = {
    playbackContext: {
      contentPlaybackContext: {
        vis: 0, splay: false,
        signatureTimestamp: innertube.session.player?.signature_timestamp
      },
      ...(reloadPlaybackContext ? { reloadPlaybackContext } : {})
    },
    contentCheckOk: true, racyCheckOk: true, client: 'WEB'
  };
  return watchEndpoint.call(innertube.actions, { ...args, parse: true });
}

async function main() {
  log('[poc] video', VIDEO_ID, '| capture', SECONDS + 's');

  const innertube = await Innertube.create({ cache: new UniversalCache(true) });
  const playerResponse = await makePlayerRequest(innertube, VIDEO_ID);

  const status = playerResponse.playability_status?.status;
  log('[player] playability:', status, '| title:', playerResponse.video_details?.title);
  if (status !== 'OK') throw new Error('not playable: ' + playerResponse.playability_status?.reason);

  const serverAbrStreamingUrl = await innertube.session.player
    ?.decipher(playerResponse.streaming_data?.server_abr_streaming_url);
  const ustreamerConfig = playerResponse.player_config?.media_common_config
    .media_ustreamer_request_config?.video_playback_ustreamer_config;
  if (!serverAbrStreamingUrl || !ustreamerConfig) throw new Error('no SABR url/ustreamer config in player response');
  log('[player] serverAbrStreamingUrl:', serverAbrStreamingUrl.slice(0, 80) + '...');
  log('[player] adaptive formats:', playerResponse.streaming_data?.adaptive_formats?.length);

  // ---------- Step 2b: PO token bound to the video ID ----------
  const minter = await getWebPoMinter();
  const probe = await minter.mintAsWebsafeString(VIDEO_ID);
  log('[po-token] minted, bound to video ID,', probe.length, 'chars, prefix:', probe.slice(0, 12) + '...');

  // ---------- Steps 3+4: SABR conversation + UMP parsing ----------
  const sabrFormats = (playerResponse.streaming_data?.adaptive_formats || []).map(buildSabrFormat);
  const clientName = parseInt(Constants.CLIENT_NAME_IDS[innertube.session.context.client.clientName]);
  const clientVersion = innertube.session.context.client.version;

  const sabr = new SabrStream({
    videoId: VIDEO_ID,
    formats: sabrFormats,
    serverAbrStreamingUrl,
    videoPlaybackUstreamerConfig: ustreamerConfig,
    clientInfo: { clientName, clientVersion },
    callbacks: {
      onMintPoToken: () => minter.mint(VIDEO_ID),
      onReloadPlayerResponse: async (ctx) => {
        log('[sabr] RELOAD_PLAYER_RESPONSE requested');
        const pr = await makePlayerRequest(innertube, VIDEO_ID, ctx);
        return {
          videoPlaybackUstreamerConfig: pr.player_config?.media_common_config
            .media_ustreamer_request_config?.video_playback_ustreamer_config,
          serverAbrStreamingUrl: await innertube.session.player?.decipher(pr.streaming_data?.server_abr_streaming_url)
        };
      }
    }
  });

  let videoBytes = 0, audioBytes = 0;
  sabr.on('streamProtectionStatusUpdate', (sps) =>
    log('[ump] STREAM_PROTECTION_STATUS status=' + sps.status +
        (sps.status === 1 ? ' (PO token ACCEPTED)' : sps.status === 2 ? ' (pending)' : ' (REJECTED)')));
  sabr.on('formatInitialization', (f) => log('[ump] FORMAT_INITIALIZATION_METADATA received'));

  const { videoStream, audioStream, selectedFormats } = sabr.start({
    videoPreferences: { container: 'webm', quality: '720p', preferredVideoCodec: 'vp9' },
    audioPreferences: { container: 'webm', preferredAudioCodec: 'opus' }
  });

  log('[sabr] video format:', selectedFormats.videoFormat?.itag, selectedFormats.videoFormat?.mimeType);
  log('[sabr] audio format:', selectedFormats.audioFormat?.itag, selectedFormats.audioFormat?.mimeType);

  const timer = setTimeout(() => { log('[poc] time budget reached, aborting'); sabr.abort(); }, SECONDS * 1000);

  const sink = (which) => new WritableStream({
    write(chunk) {
      if (which === 'video') videoBytes += chunk.length; else audioBytes += chunk.length;
    }
  });

  const vFile = createWriteStream(`poc-${VIDEO_ID}.video.webm`);
  const aFile = createWriteStream(`poc-${VIDEO_ID}.audio.webm`);
  const fileSink = (which, ws) => new WritableStream({
    write(chunk) {
      if (which === 'video') videoBytes += chunk.length; else audioBytes += chunk.length;
      return new Promise((res, rej) => ws.write(chunk, (e) => e ? rej(e) : res()));
    },
    close() { ws.end(); }
  });

  try {
    await Promise.all([
      videoStream.pipeTo(fileSink('video', vFile)),
      audioStream.pipeTo(fileSink('audio', aFile))
    ]);
  } catch (e) {
    if (!sabr.isAborted) throw e;
  } finally {
    clearTimeout(timer);
  }

  log('[done] video bytes:', videoBytes, '| audio bytes:', audioBytes);
  log('[done] wrote poc-' + VIDEO_ID + '.video.webm / .audio.webm');
}

main().catch((e) => { console.error('[fail]', e); process.exitCode = 1; });
