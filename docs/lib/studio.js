import { putClip } from './db.js';

const $ = (s) => document.querySelector(s);
const state = {
  videoBlob: null, audioBlob: null, captions: [],
  srcName: 'short', duration: 0, clips: [], tags: new Set(),
  cfg: null, topics: [],
};
const logEl = $('#log');
const log = (m) => { logEl.textContent += m + '\n'; logEl.scrollTop = logEl.scrollHeight; };

/* ---------- boot ---------- */
async function boot() {
  state.cfg = await (await fetch('topics.json')).json();
  state.topics = state.cfg.topics;
  document.title = state.cfg.siteName + ' - Studio';
  renderTagChips();
  wire();
  window.addEventListener('message', onBridgeMessage, false);
}

function renderTagChips() {
  const el = $('#tagChips');
  el.innerHTML = '';
  for (const t of state.cfg.technologies) {
    const c = document.createElement('span');
    c.className = 'chip' + (state.tags.has(t) ? ' active' : '');
    c.textContent = t;
    c.onclick = () => { state.tags.has(t) ? state.tags.delete(t) : state.tags.add(t); renderTagChips(); };
    el.appendChild(c);
  }
}

function wire() {
  $('#copyBridge').onclick = async () => {
    const code = await (await fetch('lib/bridge.js')).text();
    await navigator.clipboard.writeText(code);
    $('#bridgeHint').hidden = false;
  };
  $('#openYt').onclick = () => {
    const u = $('#ytUrl').value.trim();
    if (u) window.open(u, '_blank');
  };
  const drop = $('#drop');
  drop.onclick = () => $('#filePick').click();
  drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); };
  drop.ondragleave = () => drop.classList.remove('over');
  drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove('over'); handleFiles(e.dataTransfer.files); };
  $('#filePick').onchange = (e) => handleFiles(e.target.files);
  $('#loadSample').onclick = loadSample;
  $('#autoSplit').onclick = autoSplit;
  $('#renderAll').onclick = renderAll;
  $('#aiPick').onclick = aiPick;
  if (localStorage.getItem('shortslab-aiRemember') === '1') {
    $('#aiRemember').checked = true;
    ['aiEndpoint', 'aiModel', 'aiKey'].forEach((id) => {
      const v = localStorage.getItem('shortslab-' + id);
      if (v !== null) $('#' + id).value = v;
    });
  }
}

function saveAiSettings() {
  if ($('#aiRemember').checked) {
    localStorage.setItem('shortslab-aiRemember', '1');
    ['aiEndpoint', 'aiModel', 'aiKey'].forEach((id) => localStorage.setItem('shortslab-' + id, $('#' + id).value));
  } else {
    localStorage.removeItem('shortslab-aiRemember');
    ['aiEndpoint', 'aiModel', 'aiKey'].forEach((id) => localStorage.removeItem('shortslab-' + id));
  }
}

/* ---------- bridge postMessage ---------- */
async function onBridgeMessage(e) {
  const d = e.data;
  if (!d || d.ns !== 'shorts-lab') return;
  log('bridge: received "' + d.title + '" (' + (d.videoBuf.byteLength / 1e6).toFixed(1) + ' MB video, ' + (d.audioBuf.byteLength / 1e6).toFixed(1) + ' MB audio)');
  state.videoBlob = new Blob([d.videoBuf], { type: 'video/webm' });
  state.audioBlob = d.audioBuf ? new Blob([d.audioBuf], { type: 'audio/webm' }) : null;
  state.srcName = (d.title || 'youtube').replace(/[^\w\- ]+/g, '').slice(0, 60);
  state.captions = parseJson3(d.captions || '');
  await onSourceReady();
}

/* ---------- source files ---------- */
async function handleFiles(files) {
  for (const f of files) {
    const n = f.name.toLowerCase();
    if (n.endsWith('.json3') || n.endsWith('.json')) state.captions = parseJson3(await f.text());
    else if (n.endsWith('.vtt')) state.captions = parseVtt(await f.text());
    else if (n.endsWith('.srt')) state.captions = parseVtt(srtToVtt(await f.text()));
    else if (f.type.startsWith('audio') || n.includes('audio')) state.audioBlob = f;
    else if (f.type.startsWith('video') || n.endsWith('.webm') || n.endsWith('.mp4')) { state.videoBlob = f; state.srcName = f.name.replace(/\.[^.]+$/, '').replace(/[^\w\- ]+/g, '').slice(0, 60); }
  }
  if (state.videoBlob) await onSourceReady();
}

async function loadSample() {
  state.videoBlob = await (await fetch('assets/sample.mp4')).blob();
  state.audioBlob = null;
  state.srcName = 'sample';
  state.captions = parseVtt(await (await fetch('assets/sample.vtt')).text());
  await onSourceReady();
}

async function onSourceReady() {
  const url = URL.createObjectURL(state.videoBlob);
  const v = $('#preview');
  v.src = url; v.hidden = false;
  await new Promise((res) => { v.onloadedmetadata = res; });
  state.duration = v.duration;
  $('#srcStatus').textContent = state.srcName + ' | ' + Math.round(state.duration) + 's' + (state.audioBlob ? ' | +audio' : '') + (state.captions.length ? ' | ' + state.captions.length + ' caption lines' : ' | no captions');
  renderTranscript();
  $('#clipStep').hidden = false;
  $('#renderStep').hidden = false;
}

/* ---------- captions ---------- */
function parseJson3(text) {
  try {
    const j = JSON.parse(text);
    const out = [];
    for (const ev of (j.events || [])) {
      if (!ev.segs) continue;
      const t = (ev.tStartMs || 0) / 1000;
      const txt = ev.segs.map(s => s.utf8).join('').replace(/\n/g, ' ').trim();
      if (txt) out.push({ start: t, end: t + (ev.dDurationMs || 1500) / 1000, text: txt });
    }
    return mergeCues(out);
  } catch { return []; }
}
function srtToVtt(s) { return s.replace(/(\d\d:\d\d:\d\d),(\d\d\d)/g, '$1.$2'); }
function parseVtt(text) {
  const out = [];
  const re = /(\d\d):(\d\d):(\d\d)[.,](\d\d\d)\s*-->\s*(\d\d):(\d\d):(\d\d)[.,](\d\d\d)[^\n]*\n([\s\S]*?)(?=\n\n|$)/g;
  let m;
  while ((m = re.exec(text))) {
    const s = (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) + (+m[4]) / 1000;
    const e = (+m[5]) * 3600 + (+m[6]) * 60 + (+m[7]) + (+m[8]) / 1000;
    const t = m[9].replace(/<[^>]+>/g, '').replace(/\n/g, ' ').trim();
    if (t) out.push({ start: s, end: e, text: t });
  }
  return mergeCues(out);
}
function mergeCues(cues) {
  const out = [];
  for (const c of cues) {
    const last = out[out.length - 1];
    if (last && Math.abs(c.start - last.end) < 0.25 && c.text.startsWith(last.text.slice(-12))) last.end = c.end;
    else if (last && c.text === last.text) last.end = c.end;
    else out.push({ ...c });
  }
  return out;
}
const fmt = (s) => {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = (s % 60);
  return (h ? h + ':' : '') + String(m).padStart(h ? 2 : 1, '0') + ':' + sec.toFixed(1).padStart(4, '0');
};

/* ---------- transcript + clips ---------- */
let pendingStart = null;
function renderTranscript() {
  const el = $('#transcript');
  el.innerHTML = '';
  if (!state.captions.length) { el.innerHTML = '<p class="hint" style="padding:8px">No captions. Use auto-split or the start/end inputs in each clip row.</p>'; return; }
  state.captions.forEach((c, i) => {
    const p = document.createElement('p');
    p.innerHTML = `<span class="t">${fmt(c.start)}</span>`;
    p.appendChild(document.createTextNode(c.text));
    p.onclick = () => {
      if (pendingStart === null) { pendingStart = c.start; p.classList.add('sel'); }
      else {
        const s = pendingStart, e = Math.max(c.end, s + 2);
        pendingStart = null;
        el.querySelectorAll('p.sel').forEach(x => x.classList.remove('sel'));
        addClip(s, e);
      }
    };
    el.appendChild(p);
  });
}

function addClip(start, end, topic, title) {
  state.clips.push({ id: Date.now() + Math.random(), start, end, topic: topic || state.topics[0], title: title || '' });
  renderClips();
}

function autoSplit() {
  const n = Math.max(5, Math.min(180, +$('#clipLen').value || 45));
  state.clips = [];
  if (!state.captions.length) {
    for (let s = 0; s < state.duration; s += n) addClip(s, Math.min(s + n, state.duration));
    return;
  }
  let s = 0;
  while (s < state.duration - 1) {
    const target = s + n;
    let end = state.duration;
    const cue = state.captions.find(c => c.end >= target && c.end < target + 8);
    if (cue) end = Math.min(cue.end, state.duration);
    else {
      const next = state.captions.find(c => c.start > s + 2);
      end = next ? Math.min(next.start, state.duration) : state.duration;
    }
    addClip(s, end);
    s = end;
  }
}

function renderClips() {
  const el = $('#cliplist');
  el.innerHTML = '';
  state.clips.forEach((c, idx) => {
    const row = document.createElement('div');
    row.className = 'cliprow';
    const times = document.createElement('div');
    times.className = 'times';
    times.innerHTML = `<b>#${idx + 1}</b> `;
    if (c.title) { const ts = document.createElement('span'); ts.style.color = 'var(--accent)'; ts.textContent = c.title + ' | '; times.appendChild(ts); }
    const si = document.createElement('input'); si.type = 'number'; si.step = '0.1'; si.value = c.start.toFixed(1); si.style.cssText = 'width:76px;padding:4px 6px';
    const ei = document.createElement('input'); ei.type = 'number'; ei.step = '0.1'; ei.value = c.end.toFixed(1); ei.style.cssText = 'width:76px;padding:4px 6px';
    si.onchange = () => { c.start = +si.value; };
    ei.onchange = () => { c.end = +ei.value; };
    times.append(si, document.createTextNode(' to '), ei, document.createTextNode(` (${(c.end - c.start).toFixed(1)}s)`));
    const sel = document.createElement('select');
    for (const t of state.topics) { const o = document.createElement('option'); o.textContent = t; o.selected = t === c.topic; sel.appendChild(o); }
    sel.onchange = () => { c.topic = sel.value; };
    const rm = document.createElement('button');
    rm.className = 'rm'; rm.textContent = 'Remove';
    rm.onclick = () => { state.clips = state.clips.filter(x => x.id !== c.id); renderClips(); };
    row.append(times, sel, document.createElement('span'), rm);
    el.appendChild(row);
  });
}

/* ---------- ffmpeg.wasm render ---------- */
let ffmpeg = null;
async function fetchFileLocal(f) {
  if (typeof f === 'string') f = await fetch(f).then((r) => r.blob());
  return new Uint8Array(await f.arrayBuffer());
}

async function getFFmpeg() {
  if (ffmpeg) return ffmpeg;
  let failed = true;
  ffmpeg = new FFmpegWASM.FFmpeg();
  ffmpeg.on('progress', ({ progress }) => { $('#bar').style.width = Math.min(100, Math.round(progress * 100)) + '%'; });
  window.__fflog = []; ffmpeg.on('log', ({ message }) => { window.__fflog.push(message); if (/error|fail/i.test(message)) log(message); });
  log('loading ffmpeg.wasm core (~30 MB, first time only)...');
  await ffmpeg.load({ coreURL: new URL('vendor/ffmpeg-core.js', location.href).href, wasmURL: new URL('vendor/ffmpeg-core.wasm', location.href).href });
  failed = false;
  log('ffmpeg.wasm ready');
  if (!failed) return ffmpeg;
}

function captionPng(text, pos, size) {
  const W = 1080, H = 1920;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');
  ctx.font = `800 ${size}px Arial, sans-serif`;
  ctx.textAlign = 'center';
  ctx.lineJoin = 'round';
  const maxW = W - 120;
  const words = text.split(/\s+/);
  const lines = [];
  let line = '';
  for (const w of words) {
    const t = line ? line + ' ' + w : w;
    if (ctx.measureText(t).width > maxW && line) { lines.push(line); line = w; } else line = t;
  }
  if (line) lines.push(line);
  const lh = size * 1.25;
  let y = pos === 'top' ? 320 : pos === 'center' ? 960 : 1560;
  y -= (lines.length - 1) * lh / 2;
  for (const l of lines) {
    ctx.strokeStyle = 'rgba(0,0,0,.9)'; ctx.lineWidth = size / 5;
    ctx.strokeText(l, W / 2, y);
    ctx.fillStyle = '#fff';
    ctx.fillText(l, W / 2, y);
    y += lh;
  }
  return new Promise((res) => cv.toBlob(res, 'image/png'));
}

async function renderClip(clip, idx) {
  const ff = await getFFmpeg();
  window.__ff = ff;
  const remux = $('#remuxOnly').checked;
  const cues = state.captions.filter(c => c.end > clip.start && c.start < clip.end);
  await ff.writeFile('in' + idx + (state.videoBlob.type.includes('mp4') ? '.mp4' : '.webm'), await fetchFileLocal(state.videoBlob));
  const inName = 'in' + idx + (state.videoBlob.type.includes('mp4') ? '.mp4' : '.webm');
  const args = ['-ss', clip.start.toFixed(2), '-to', clip.end.toFixed(2), '-i', inName];
  if (state.audioBlob) { await ff.writeFile('aud' + idx + '.webm', await fetchFileLocal(state.audioBlob)); args.push('-i', 'aud' + idx + '.webm'); }

  if (remux || !cues.length) {
    if (!cues.length && !remux) log(`clip ${idx + 1}: no captions in range, remuxing without burn`);
    args.push('-c', 'copy');
    if (state.audioBlob) args.push('-map', '0:v', '-map', '1:a');
    args.push('out' + idx + '.webm');
    await ff.exec(args);
    return new Blob([await ff.readFile('out' + idx + '.webm')], { type: 'video/webm' });
  }

  const pngs = [];
  for (let i = 0; i < cues.length; i++) {
    const b = await captionPng(cues[i].text, $('#capPos').value, +$('#capSize').value || 56);
    const name = `cap${idx}_${i}.png`;
    await ff.writeFile(name, await fetchFileLocal(b));
    pngs.push({ name, s: Math.max(0, cues[i].start - clip.start), e: cues[i].end - clip.start });
    args.push('-loop', '1', '-i', name);
  }
  let chain = '[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,fps=30';
  let prev = 'bg';
  chain += `[${prev}];`;
  pngs.forEach((p, i) => {
    const out = 'v' + i;
    chain += `[${prev}][${(state.audioBlob ? 2 : 1) + i}:v]overlay=0:0:enable='between(t,${p.s.toFixed(2)},${p.e.toFixed(2)})'[${out}];`;
    prev = out;
  });
  chain = chain.replace(/;$/, '');
  const vout = 'vfinal';
  args.push('-filter_complex', chain + `;[${prev}]format=yuv420p[${vout}]`, '-map', `[${vout}]`);
  if (state.audioBlob) args.push('-map', '1:a');
  else args.push('-map', '0:a?');
  args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', '-shortest', 'out' + idx + '.mp4');
  log('ffmpeg args: ' + args.join(' '));
  await ff.exec(args);
  return new Blob([await ff.readFile('out' + idx + '.mp4')], { type: 'video/mp4' });
}

/* ---------- AI highlight picking ---------- */
async function callLLM(prompt) {
  const ep = $('#aiEndpoint').value.trim();
  const model = $('#aiModel').value.trim();
  const key = $('#aiKey').value.trim();
  if (!ep) throw new Error('no AI endpoint set - paste your own endpoint and key above to use AI picking');
  const headers = { 'Content-Type': 'application/json' };
  if (key) headers['Authorization'] = 'Bearer ' + key;
  const body = { model, messages: [{ role: 'user', content: prompt }] };
  let lastErr = 'unknown';
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(ep, { method: 'POST', headers, body: JSON.stringify(body) });
      if (r.status === 429 || r.status >= 500) { lastErr = 'HTTP ' + r.status + ' (rate limit or server)'; await new Promise((res) => setTimeout(res, 3000 * (attempt + 1))); continue; }
      if (!r.ok) throw new Error('HTTP ' + r.status + ': ' + (await r.text()).slice(0, 200));
      const j = await r.json();
      return (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || j.reply || '';
    } catch (e) {
      lastErr = e && e.message || String(e);
      await new Promise((res) => setTimeout(res, 3000 * (attempt + 1)));
    }
  }
  throw new Error('AI call failed after retries: ' + lastErr);
}

function parseAiClips(text, dur, maxLen) {
  const t = text.trim().replace(/```json|```/g, '');
  const s0 = t.indexOf('{'), e0 = t.lastIndexOf('}');
  if (s0 < 0 || e0 < 0) return [];
  let arr;
  try { const j = JSON.parse(t.slice(s0, e0 + 1)); arr = Array.isArray(j) ? j : (j.clips || []); }
  catch (err) { log('AI JSON parse failed: ' + err.message); return []; }
  return arr.map((c) => {
    let start = Math.max(0, Math.min(+c.start || 0, dur - 2));
    let end = Math.max(start + 5, Math.min(+c.end || start + 30, dur));
    if (end - start > maxLen + 15) end = start + maxLen;
    const sc = state.captions.find((x) => x.end > start && x.start <= start + 1.5);
    if (sc) start = sc.start;
    const ec = [...state.captions].reverse().find((x) => x.start < end && x.end >= end - 1.5);
    if (ec) end = Math.min(ec.end, dur);
    const topic = state.topics.includes(c.topic) ? c.topic : state.topics[0];
    return { start, end, topic, title: String(c.title || '').slice(0, 60) };
  }).filter((c) => c.end - c.start >= 5);
}

async function aiPick() {
  if (!state.captions.length) { log('no captions yet - load a source with captions first'); return; }
  saveAiSettings();
  const wantN = Math.max(1, Math.min(20, +$('#aiN').value || 5));
  const maxLen = Math.max(10, Math.min(120, +$('#aiMax').value || 60));
  const topics = state.topics.join('; ');
  const dur = state.duration;
  const lines = state.captions.map((c) => `[${fmt(c.start)}] ${c.text}`);
  const chunks = [];
  let cur = [], len = 0;
  for (const l of lines) { if (len + l.length > 8000 && cur.length) { chunks.push(cur); cur = []; len = 0; } cur.push(l); len += l.length + 1; }
  if (cur.length) chunks.push(cur);
  $('#aiPick').disabled = true;
  try {
    let all = [];
    for (let i = 0; i < chunks.length; i++) {
      const prompt = 'You pick highlight clips from educational video transcripts for short-form study reels. Reply with ONLY valid JSON, no markdown, no explanation: {"clips":[{"start":<seconds>,"end":<seconds>,"topic":<string>,"title":<string>}]}. Rules: each clip 10-' + maxLen + ' seconds, pick the most instructive self-contained moments, no overlaps, topic must be exactly one of the given topics, title max 6 words.\nTopics: ' + topics + '\nPick up to ' + wantN + ' highlight clips from this transcript section (full video duration ' + Math.round(dur) + 's):\n' + chunks[i].join('\n');
      log('AI: sending captions to ' + $('#aiEndpoint').value.trim() + ' as ' + $('#aiModel').value.trim() + ' (part ' + (i + 1) + '/' + chunks.length + ')...');
      const text = await callLLM(prompt);
      all = all.concat(parseAiClips(text, dur, maxLen));
      if (i < chunks.length - 1) await new Promise((r) => setTimeout(r, 1500));
    }
    if (!all.length) { log('AI returned no usable clips - try again or use auto-split'); return; }
    all.sort((a, b) => a.start - b.start);
    const picked = [];
    for (const c of all) { const last = picked[picked.length - 1]; if (last && c.start < last.end) continue; picked.push(c); }
    state.clips = [];
    for (const c of picked) addClip(c.start, c.end, c.topic, c.title);
    log('AI picked ' + picked.length + ' clips - review below, then Render all');
  } catch (e) {
    log('ERROR: ' + (e && e.message || e));
  } finally {
    $('#aiPick').disabled = false;
  }
}

async function renderAll() {
  if (!state.clips.length) { log('no clips yet'); return; }
  $('#renderAll').disabled = true;
  try {
    for (let i = 0; i < state.clips.length; i++) {
      const c = state.clips[i];
      log(`rendering clip ${i + 1}/${state.clips.length}: ${fmt(c.start)} to ${fmt(c.end)}`);
      $('#bar').style.width = '0%';
      const blob = await renderClip(c, i);
      const title = c.title ? `${state.srcName} - ${c.title}` : `${state.srcName} #${i + 1}`;
      await putClip({ id: c.id, title, topic: c.topic, tags: [...state.tags], durationSec: c.end - c.start, created: Date.now(), blob });
      const out = document.createElement('div');
      out.className = 'cliprow';
      const url = URL.createObjectURL(blob);
      const v = document.createElement('video');
      v.src = url; v.controls = true; v.playsInline = true; v.style.cssText = 'width:120px;border-radius:8px;background:#000';
      const info = document.createElement('div');
      info.className = 'times';
      info.textContent = `${title} | ${(blob.size / 1e6).toFixed(1)} MB | saved to library`;
      const a = document.createElement('a');
      a.textContent = 'Download'; a.href = url; a.download = title.replace(/[^\w\- ]+/g, '') + (blob.type.includes('mp4') ? '.mp4' : '.webm');
      a.style.cssText = 'color:var(--accent);font-weight:700;align-self:center';
      out.append(v, info, document.createElement('span'), a);
      $('#outputs').appendChild(out);
      log(`clip ${i + 1} done`);
    }
  } catch (e) {
    log('ERROR: ' + (e && e.message || e));
    if (window.__fflog) log('--- ffmpeg tail ---\n' + window.__fflog.slice(-25).join('\n'));
  } finally {
    $('#renderAll').disabled = false;
  }
}

boot();
