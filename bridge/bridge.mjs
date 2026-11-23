/**
 * Shorts Lab bridge - paste into the DevTools console on a youtube.com
 * watch page (or any youtube.com page; pass the video id if not on a watch
 * page). Built from the sabr-ump-poc in-page PoC
 * (github.com/azjhf-dev/sabr-ump-poc): BotGuard PO-token + SABR/UMP stream,
 * same-origin caption fetch. Downloads video.webm + audio.webm +
 * captions.json3 and postMessages the buffers to an opener Shorts Lab
 * studio tab when one exists.
 *
 * window.__shortsBridgeOpts = { lang: 'en', quality: '720p' } before running
 * to change defaults.
 */

import Innertube, { UniversalCache, Platform, Log } from 'youtubei.js';
import { buildSabrFormat } from 'googlevideo/utils';
import { SabrStream } from 'googlevideo/sabr-stream';
import { BotGuardClient } from 'bgutils-js/botguard';
import { WebPoMinter } from 'bgutils-js/webpo';
import { getHeaders, buildURL, parseLooseJSON } from 'bgutils-js/utils';

Log.setLevel(Log.Level.NONE);
Platform.shim.eval = async (data) => new Function(data.output)();

const opts = window.__shortsBridgeOpts || {};
const log = (...a) => console.log('[shorts-bridge]', ...a);

function loadScriptTag(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error('script load failed: ' + src));
    document.head.appendChild(s);
  });
}

async function getWebPoMinter() {
  const pageHtml = await (await fetch('https://www.youtube.com/', { credentials: 'omit' })).text();
  const ytConfig = pageHtml.match(/ytcfg\.set\(({.+?})\);/s)?.[1];
  if (ytConfig) {
    try { window.yt = Object.assign(window.yt || {}, { config_: JSON.parse(ytConfig) }); }
    catch (e) { log('warn: could not parse ytcfg:', e); }
  }
  const attestation = pageHtml.match(/window\.ytAtN\(\s*({[\s\S]*?})\s*\)/);
  if (!attestation) throw new Error('bgChallenge (ytAtN) not found in home page HTML');
  const challengeResponse = parseLooseJSON(attestation[1]).R;
  if (!challengeResponse.bgChallenge) throw new Error('no bgChallenge in attestation data');
  const interpreterUrl = challengeResponse.bgChallenge.interpreterUrl
    .privateDoNotAccessOrElseTrustedResourceUrlWrappedValue;
  await loadScriptTag('https:' + interpreterUrl);
  log('botguard interpreter loaded');
  const botGuardClient = await BotGuardClient.create({
    program: challengeResponse.bgChallenge.program,
    globalName: challengeResponse.bgChallenge.globalName,
    globalObject: window
  });
  const webPoSignalOutput = [];
  const botguardResponse = await botGuardClient.snapshot({ webPoSignalOutput });
  const requestKey = 'O43z0dpjhgX20SCx4KAo';
  const itRes = await fetch(buildURL('GenerateIT', true), {
    method: 'POST', headers: getHeaders(), body: JSON.stringify([requestKey, botguardResponse])
  });
  const [integrityToken, estimatedTtlSecs, mintRefreshThreshold, websafeFallbackToken] = await itRes.json();
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

async function fetchCaptions(pr, lang) {
  const tracks = pr.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
  if (!tracks.length) { log('no caption tracks on this video'); return { json3: '', trackLang: null }; }
  const pick = tracks.find(t => (t.languageCode || '').startsWith(lang))
            || tracks.find(t => (t.languageCode || '').startsWith('en'))
            || tracks[0];
  const res = await fetch(pick.baseUrl + '&fmt=json3', { credentials: 'omit' });
  const json3 = await res.text();
  log('captions:', pick.languageCode, (pick.name?.simpleText || pick.name?.runs?.[0]?.text || ''), '|', json3.length, 'bytes');
  return { json3, trackLang: pick.languageCode };
}

function download(name, blob) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 10000);
}

window.shortsBridgeRun = async function (videoIdArg) {
  const videoId = videoIdArg || new URL(location.href).searchParams.get('v');
  if (!videoId) throw new Error('no video id: run this on a watch page or call shortsBridgeRun("VIDEO_ID")');
  log('video', videoId);

  const innertube = await Innertube.create({ cache: new UniversalCache(false) });
  const pr = await fetchWatchPlayerResponse(videoId);
  if (pr.playabilityStatus.status !== 'OK') throw new Error('not playable: ' + (pr.playabilityStatus.reason || ''));
  const title = pr.videoDetails?.title || videoId;
  log('title:', title);

  const rawUrl = pr.streamingData.serverAbrStreamingUrl;
  const ustreamerConfig = pr.playerConfig.mediaCommonConfig.mediaUstreamerRequestConfig.videoPlaybackUstreamerConfig;
  const serverAbrStreamingUrl = await innertube.session.player.decipher(rawUrl);
  log('SABR url deciphered');

  const minter = await getWebPoMinter();
  await minter.mintAsWebsafeString(videoId);
  log('PO token minted');

  const { json3 } = await fetchCaptions(pr, (opts.lang || 'en'));

  const sabrFormats = (pr.streamingData.adaptiveFormats || []).map(buildSabrFormat);
  const boundFetch = window.fetch.bind(window);
  const sabrFetch = (url, o) => boundFetch(url, { ...o, headers: { 'content-type': 'text/plain' } });

  const sabr = new SabrStream({
    videoId,
    formats: sabrFormats,
    serverAbrStreamingUrl,
    videoPlaybackUstreamerConfig: ustreamerConfig,
    fetchFunction: sabrFetch,
    clientInfo: { clientName: 1, clientVersion: ytcfg.data_.INNERTUBE_CONTEXT_CLIENT_VERSION },
    callbacks: {
      onMintPoToken: () => minter.mint(videoId),
      onReloadPlayerResponse: async () => {
        const pr2 = await fetchWatchPlayerResponse(videoId);
        return {
          videoPlaybackUstreamerConfig: pr2.playerConfig.mediaCommonConfig.mediaUstreamerRequestConfig.videoPlaybackUstreamerConfig,
          serverAbrStreamingUrl: await innertube.session.player.decipher(pr2.streamingData.serverAbrStreamingUrl)
        };
      }
    }
  });

  sabr.on('streamProtectionStatusUpdate', (sps) => {
    log('stream protection status =', sps.status, sps.status === 1 ? '(PO token accepted)' : sps.status === 2 ? '(pending)' : '(REJECTED)');
  });
  sabr.on('error', (e) => log('SABR error:', e && e.message || e));

  const { videoStream, audioStream, selectedFormats } = sabr.start({
    videoPreferences: { container: 'webm', quality: (opts.quality || '720p'), preferredVideoCodec: 'vp9' },
    audioPreferences: { container: 'webm', preferredAudioCodec: 'opus' }
  });
  log('video itag', selectedFormats.videoFormat?.itag, selectedFormats.videoFormat?.mimeType);
  log('audio itag', selectedFormats.audioFormat?.itag, selectedFormats.audioFormat?.mimeType);

  const collect = (label) => {
    const parts = [];
    let n = 0;
    return {
      parts,
      sink: new WritableStream({
        write(c) { parts.push(c); n += c.length; if (parts.length % 100 === 0) log(label, (n / 1e6).toFixed(1) + ' MB'); }
      }),
      blob: (type) => new Blob(parts, { type })
    };
  };
  const v = collect('video'), a = collect('audio');
  await Promise.all([videoStream.pipeTo(v.sink), audioStream.pipeTo(a.sink)]);
  log('download complete:', (v.blob().size / 1e6).toFixed(1), 'MB video,', (a.blob().size / 1e6).toFixed(1), 'MB audio');

  const safe = title.replace(/[^\w\- ]+/g, '').slice(0, 60);
  const videoBlob = v.blob('video/webm');
  const audioBlob = a.blob('audio/webm');
  const capBlob = new Blob([json3], { type: 'application/json' });

  if (window.opener && !window.opener.closed) {
    try {
      const videoBuf = await videoBlob.arrayBuffer();
      const audioBuf = await audioBlob.arrayBuffer();
      window.opener.postMessage({ ns: 'shorts-lab', title: safe, videoBuf, audioBuf, captions: json3 }, '*', [videoBuf, audioBuf]);
      log('sent to the Shorts Lab studio tab via postMessage');
    } catch (e) { log('postMessage failed, falling back to downloads:', e); }
  }
  download(safe + '.video.webm', videoBlob);
  download(safe + '.audio.webm', audioBlob);
  if (json3) download(safe + '.en.json3', capBlob);
  log('done. If the studio tab did not pick it up, drag the downloaded files into it.');
  return { title: safe, videoBytes: videoBlob.size, audioBytes: audioBlob.size, captions: json3.length };
};

window.shortsBridgeRun().catch((e) => console.error('[shorts-bridge] FAILED:', e));
