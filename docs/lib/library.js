import { allClips, deleteClip } from './db.js';

const state = { topic: null, tech: null, clips: [] };

const $ = (sel) => document.querySelector(sel);

async function boot() {
  const cfg = await (await fetch('topics.json')).json();
  document.title = cfg.siteName + ' - Library';
  state.clips = await allClips();
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
    d.innerHTML = `<span>${t}</span><span class="count">${counts.get(t) || 0}</span>`;
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

function renderGrid() {
  const grid = $('#grid');
  grid.innerHTML = '';
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
