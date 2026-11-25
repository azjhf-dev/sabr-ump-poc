import { allClips, deleteClip } from './db.js';

const state = { topic: null, tech: null, clips: [], queue: [] };
const QUEUE_TOPIC = 'Craig Dennis';
const QUEUE_REMOTE = 'https://raw.githubusercontent.com/azjhf-dev/sabr-ump-poc/main/docs/craig-queue.json';

function todaySG() { return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Singapore' }); }

async function loadQueue() {
  let j = null;
  try { j = await (await fetch(QUEUE_REMOTE, { cache: 'no-store' })).json(); } catch (e) {}
  if (!j) { try { j = await (await fetch('craig-queue.json')).json(); } catch (e) {} }
  const today = todaySG();
  return ((j && j.items) || []).filter(i => i.release <= today).sort((a, b) => b.release.localeCompare(a.release));
}


const $ = (sel) => document.querySelector(sel);

async function boot() {
  const cfg = await (await fetch('topics.json')).json();
  document.title = cfg.siteName + ' - Library';
  state.clips = await allClips();
  state.queue = await loadQueue();
  renderTopics(cfg);
  renderChips(cfg);
  renderGrid();
}

function countsByTopic() {
  const m = new Map();
  for (const c of state.clips) m.set(c.topic, (m.get(c.topic) || 0) + 1);
  return m;
}

function renderTopics(cfg) {
  const el = $('#topics');
  el.innerHTML = '';
  const counts = countsByTopic();
  const all = document.createElement('div');
  all.className = 'topic' + (state.topic === null ? ' active' : '');
  all.innerHTML = `<span>All</span><span class="count">${state.clips.length}</span>`;
  all.onclick = () => { state.topic = null; renderTopics(cfg); renderGrid(); };
  el.appendChild(all);
  for (const t of cfg.topics) {
    const d = document.createElement('div');
    d.className = 'topic' + (state.topic === t ? ' active' : '');
    d.innerHTML = `<span>${t}</span><span class="count">${(t === QUEUE_TOPIC ? state.queue.length : counts.get(t) || 0)}</span>`;
    d.onclick = () => { state.topic = t; renderTopics(cfg); renderGrid(); };
    el.appendChild(d);
  }
}

function renderChips(cfg) {
  const el = $('#techChips');
  el.innerHTML = '';
  const used = new Set();
  for (const c of state.clips) for (const t of (c.tags || [])) used.add(t);
  for (const t of cfg.technologies) {
    if (!used.has(t)) continue;
    const s = document.createElement('span');
    s.className = 'chip' + (state.tech === t ? ' active' : '');
    s.textContent = t;
    s.onclick = () => { state.tech = state.tech === t ? null : t; renderChips(cfg); renderGrid(); };
    el.appendChild(s);
  }
}

function renderQueue(grid) {
  $('#empty').hidden = state.queue.length > 0;
  const stars = n => '\u2605'.repeat(n) + '\u2606'.repeat(5 - n);
  const groups = new Map();
  for (const i of state.queue) { if (!groups.has(i.group)) groups.set(i.group, []); groups.get(i.group).push(i); }
  for (const [g, items] of groups) {
    const h = document.createElement('h3'); h.textContent = g; h.style.cssText = 'grid-column:1/-1;margin:10px 0 0;color:var(--muted);';
    grid.appendChild(h);
    for (const i of items) {
      const card = document.createElement('div'); card.className = 'card';
      const box = document.createElement('div'); box.style.cssText = 'position:relative;aspect-ratio:16/9;background:#000;cursor:pointer;';
      const img = document.createElement('img'); img.loading = 'lazy'; img.src = 'https://i.ytimg.com/vi/' + i.vid + '/hqdefault.jpg'; img.style.cssText = 'width:100%;height:100%;object-fit:cover;';
      box.appendChild(img);
      box.onclick = () => { box.innerHTML = '<iframe src="https://www.youtube-nocookie.com/embed/' + i.vid + '?autoplay=1" style="width:100%;height:100%;border:0" allow="autoplay; encrypted-media; picture-in-picture" allowfullscreen></iframe>'; };
      const meta = document.createElement('div'); meta.className = 'meta';
      meta.innerHTML = '<p class="title"></p><div class="sub"><span class="src"></span><span class="rt"></span></div><div class="sub why"></div>';
      meta.querySelector('.title').textContent = i.title;
      meta.querySelector('.src').textContent = i.source + ' \u00b7 added ' + i.release;
      meta.querySelector('.rt').textContent = stars(i.stars);
      meta.querySelector('.why').textContent = i.why + (i.verify ? ' (Presenter unconfirmed.)' : '');
      card.append(box, meta); grid.appendChild(card);
    }
  }
}

function renderGrid() {
  const grid = $('#grid');
  grid.innerHTML = '';
  if (state.topic === QUEUE_TOPIC) return renderQueue(grid);
  const clips = state.clips
    .filter(c => state.topic === null || c.topic === state.topic)
    .filter(c => state.tech === null || (c.tags || []).includes(state.tech))
    .sort((a, b) => b.created - a.created);
  $('#empty').hidden = clips.length > 0;
  for (const c of clips) {
    const card = document.createElement('div');
    card.className = 'card';
    const url = URL.createObjectURL(c.blob);
    const v = document.createElement('video');
    v.src = url; v.controls = true; v.preload = 'metadata'; v.playsInline = true;
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.innerHTML = `<p class="title"></p>
      <div class="sub"><span>${c.topic}</span><span>${Math.round(c.durationSec)}s</span></div>
      <div class="sub">${(c.tags || []).map(t => `<span class="badge">${t}</span>`).join(' ')}</div>`;
    meta.querySelector('.title').textContent = c.title;
    const actions = document.createElement('div');
    actions.className = 'actions';
    const a = document.createElement('a');
    a.className = 'secondary'; a.href = url; a.download = (c.title || 'short').replace(/[^\w\- ]+/g, '') + '.mp4';
    a.textContent = 'Download';
    a.style.cssText = 'background:var(--panel-2);border:1px solid var(--line);border-radius:10px;font-weight:600;font-size:12.5px;display:flex;align-items:center;justify-content:center;';
    const del = document.createElement('button');
    del.className = 'ghost'; del.textContent = 'Delete';
    del.onclick = async () => { if (confirm('Delete this short?')) { await deleteClip(c.id); state.clips = await allClips(); renderTopics(await (await fetch('topics.json')).json()); renderChips(await (await fetch('topics.json')).json()); renderGrid(); } };
    actions.append(a, del);
    card.append(v, meta, actions);
    grid.appendChild(card);
  }
}

boot();
