/**
 * In-page SABR/UMP PoC, built to run on a youtube.com origin page.
 * Mirrors the tubehaus "sabr-page.js" approach from r/ReverseEngineering
 * thread 1y2p3im: BotGuard PO-token minting + SABR conversation + UMP
 * parsing, all from a page whose origin is https://www.youtube.com.
 *
 * Exposes: window.sabrPocRun(videoId, seconds) -> Promise<result>
 * and collects human-readable lines in window.sabrPocLog.
 */

import Innertube, { UniversalCache, Platform, Log } from 'youtubei.js';
import { buildSabrFormat } from 'googlevideo/utils';
import { SabrStream } from 'googlevideo/sabr-stream';
import { BotGuardClient } from 'bgutils-js/botguard';
import { WebPoMinter } from 'bgutils-js/webpo';
import { getHeaders, buildURL, parseLooseJSON } from 'bgutils-js/utils';

Log.setLevel(Log.Level.NONE);
Platform.shim.eval = async (data) => new Function(data.output)();

const logs = [];
window.sabrPocLog = logs;
const log = (...a) => {
  const line = new Date().toISOString().slice(11, 19) + ' ' + a.join(' ');
  logs.push(line);
};

function loadScriptTag(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error('script load failed: ' + src));
    document.head.appendChild(s);
  });
}

async function getHomePageHtml() {
  const res = await fetch('https://www.youtube.com/', { credentials: 'omit' });
  return res.text();
}

async function getWebPoMinter() {
  const pageHtml = await getHomePageHtml();

  // Thread finding: window.yt.config_ must hold the home page's ytcfg
  // (client version, API key, visitor data) or every token is turned down.
  const ytConfig = pageHtml.match(/ytcfg\.set\(({.+?})\);/s)?.[1];
  if (ytConfig) {
    try { window.yt = Object.assign(window.yt || {}, { config_: JSON.parse(ytConfig) }); }
    catch (e) { log('[botguard] warn: could not parse ytcfg: ' + e); }
  }

  const attestation = pageHtml.match(/window\.ytAtN\(\s*({[\s\S]*?})\s*\)/);
  if (!attestation) throw new Error('bgChallenge (ytAtN) not found in home page HTML');
  const challengeResponse = parseLooseJSON(attestation[1]).R;
  if (!challengeResponse.bgChallenge) throw new Error('no bgChallenge in attestation data');

  const interpreterUrl = challengeResponse.bgChallenge.interpreterUrl
    .privateDoNotAccessOrElseTrustedResourceUrlWrappedValue;
  await loadScriptTag('https:' + interpreterUrl); // thread note: script tag, fetch hits CORS rules
  log('[botguard] challenge fetched, interpreter VM loaded via <script> tag');

  const botGuardClient = await BotGuardClient.create({
    program: challengeResponse.bgChallenge.program,
    globalName: challengeResponse.bgChallenge.globalName,
    globalObject: window
  });

  const webPoSignalOutput = [];
  const botguardResponse = await botGuardClient.snapshot({ webPoSignalOutput });
  log('[botguard] snapshot taken, ' + webPoSignalOutput.length + ' webpo signal functions');

  const requestKey = 'O43z0dpjhgX20SCx4KAo';
  const itRes = await fetch(buildURL('GenerateIT', true), {
    method: 'POST', headers: getHeaders(), body: JSON.stringify([requestKey, botguardResponse])
  });
  const [integrityToken, estimatedTtlSecs, mintRefreshThreshold, websafeFallbackToken] = await itRes.json();
  log('[botguard] integrity token via GenerateIT, ttl ~' + estimatedTtlSecs + 's');

  return WebPoMinter.create(
    { integrityToken, estimatedTtlSecs, mintRefreshThreshold, websafeFallbackToken },
    webPoSignalOutput
  );
}

async function fetchWatchPlayerResponse(videoId) {
  const html = await (await fetch('https://www.youtube.com/watch?v=' + videoId, { credentials: 'omit' })).text();
  const m = html.match(/ytInitialPlayerResponse\s*=\s*({.+?})\s*;\s*(?:var\s|<\/script>)/s)
        || html.match(/ytInitialPlayerResponse\s*=\s*({.+?});/s);
  if (!m) throw new Error('ytInitialPlayerResponse not found on watch page');
  return JSON.parse(m[1]);
}

window.sabrPocRun = async function (videoId, seconds) {
  seconds = seconds || 15;
  log('[poc] video ' + videoId + ' | capture ' + seconds + 's | origin ' + location.origin);

  // Fresh ytcfg + player (for the n-param decipher) from this very origin.
  const innertube = await Innertube.create({ cache: new UniversalCache(false) });
  log('[innertube] client ' + innertube.session.context.client.clientVersion);

  const pr = await fetchWatchPlayerResponse(videoId);
  const status = pr.playabilityStatus && pr.playabilityStatus.status;
  log('[player] playability: ' + status + ' | title: ' + (pr.videoDetails && pr.videoDetails.title));
  if (status !== 'OK') throw new Error('not playable: ' + (pr.playabilityStatus || {}).reason);

  const rawUrl = pr.streamingData.serverAbrStreamingUrl;
  const ustreamerConfig = pr.playerConfig.mediaCommonConfig.mediaUstreamerRequestConfig.videoPlaybackUstreamerConfig;
  log('[player] serverAbrStreamingUrl host ' + new URL(rawUrl).host + ' | n param locked: ' + new URL(rawUrl).searchParams.has('n'));
  const serverAbrStreamingUrl = await innertube.session.player.decipher(rawUrl);
  log('[player] n param unscrambled with player base.js (EJS solver)');

  const minter = await getWebPoMinter();
  const probe = await minter.mintAsWebsafeString(videoId);
  log('[po-token] minted, bound to video ID (' + probe.length + ' chars, prefix ' + probe.slice(0, 10) + '...)');

  const sabrFormats = (pr.streamingData.adaptiveFormats || []).map(buildSabrFormat);

  // Thread finding: SABR bodies must go as text/plain so the browser sends no
  // CORS preflight (application/x-protobuf would trigger one and fail).
  const boundFetch = window.fetch.bind(window);
  const sabrFetch = (url, opts) => boundFetch(url, { ...opts, headers: { 'content-type': 'text/plain' } });

  window.__netlog = window.__netlog || [];
  const loggedFetch = async (url, opts) => {
    try {
      const r = await sabrFetch(url, opts);
      window.__netlog.push(r.status + ' ' + String(url).slice(0, 100));
      return r;
    } catch (e) {
      window.__netlog.push('FAIL ' + e + ' ' + String(url).slice(0, 100));
      throw e;
    }
  };

  const sabr = new SabrStream({
    videoId,
    formats: sabrFormats,
    serverAbrStreamingUrl,
    videoPlaybackUstreamerConfig: ustreamerConfig,
    fetchFunction: loggedFetch,
    clientInfo: {
      clientName: 1, // WEB
      clientVersion: ytcfg.data_.INNERTUBE_CONTEXT_CLIENT_VERSION
    },
    callbacks: {
      onMintPoToken: () => minter.mint(videoId),
      onReloadPlayerResponse: async () => {
        log('[sabr] RELOAD_PLAYER_RESPONSE requested');
        const pr2 = await fetchWatchPlayerResponse(videoId);
        return {
          videoPlaybackUstreamerConfig: pr2.playerConfig.mediaCommonConfig.mediaUstreamerRequestConfig.videoPlaybackUstreamerConfig,
          serverAbrStreamingUrl: await innertube.session.player.decipher(pr2.streamingData.serverAbrStreamingUrl)
        };
      }
    }
  });

  const spsSeen = [];
  sabr.on('streamProtectionStatusUpdate', (sps) => {
    spsSeen.push(sps.status);
    log('[ump] STREAM_PROTECTION_STATUS status=' + sps.status +
      (sps.status === 1 ? ' (PO token ACCEPTED)' : sps.status === 2 ? ' (pending)' : ' (REJECTED)'));
  });
  sabr.on('formatInitialization', () => log('[ump] FORMAT_INITIALIZATION_METADATA'));

  const { videoStream, audioStream, selectedFormats } = sabr.start({
    videoPreferences: { container: 'webm', quality: '720p', preferredVideoCodec: 'vp9' },
    audioPreferences: { container: 'webm', preferredAudioCodec: 'opus' }
  });

  log('[sabr] video itag ' + (selectedFormats.videoFormat && selectedFormats.videoFormat.itag) +
      ' ' + (selectedFormats.videoFormat && selectedFormats.videoFormat.mimeType));
  log('[sabr] audio itag ' + (selectedFormats.audioFormat && selectedFormats.audioFormat.itag) +
      ' ' + (selectedFormats.audioFormat && selectedFormats.audioFormat.mimeType));

  let videoBytes = 0, audioBytes = 0, videoChunks = 0, audioChunks = 0;
  let firstVideoHex = '';
  sabr.on('error', (e) => log('[sabr] ERROR: ' + (e && e.message || e)));
  const counter = (which) => new WritableStream({
    write(chunk) {
      if (which === 'video') {
        videoBytes += chunk.length; videoChunks++;
        if (!firstVideoHex) firstVideoHex = Array.from(chunk.slice(0, 24)).map((b) => b.toString(16).padStart(2, '0')).join(' ');
      } else {
        audioBytes += chunk.length; audioChunks++;
      }
    }
  });

  const timer = setTimeout(() => { log('[poc] time budget reached, aborting'); sabr.abort(); }, seconds * 1000);
  try {
    await Promise.all([videoStream.pipeTo(counter('video')), audioStream.pipeTo(counter('audio'))]);
  } catch (e) {
    if (!sabr.isAborted) throw e;
  } finally {
    clearTimeout(timer);
  }

  log('[done] video: ' + videoBytes + ' bytes in ' + videoChunks + ' UMP MEDIA pieces | audio: ' +
      audioBytes + ' bytes in ' + audioChunks + ' pieces');

  return {
    ok: true,
    videoBytes, audioBytes, videoChunks, audioChunks,
    spsSeen,
    firstVideoBytesHex: firstVideoHex,
    netlog: window.__netlog,
    logs
  };
};

log('[poc] bundle loaded, call window.sabrPocRun(videoId, seconds)');
