// Seraph dashboard v4 (renderer). Talks to the local API. Game views are BrowserViews that main.js places:
// one full size under the game bar when watching a character, or all of them in a grid on the Live page.
const API = `http://127.0.0.1:${process.env.SERAPH_PORT || 47101}`;
const { ipcRenderer, clipboard } = require('electron');
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = (n) => (n == null || Number.isNaN(Number(n)) ? '—' : Number(n).toLocaleString());
const short = (n) => { if (n == null) return '—'; const v = Number(n); if (Math.abs(v) >= 1e6) return (v / 1e6).toFixed(1) + 'M'; if (Math.abs(v) >= 1e4) return Math.round(v / 1e3) + 'k'; return v.toLocaleString(); };
const ago = (t) => { const s = Math.round((Date.now() - t) / 1000); if (s < 60) return `${s}s ago`; if (s < 3600) return `${Math.round(s / 60)}m ago`; if (s < 86400) return `${Math.round(s / 3600)}h ago`; return `${Math.round(s / 86400)}d ago`; };

async function api(path, data) {
  const res = await fetch(API + path, data === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });
  return res.json();
}
function toast(msg, bad = false) {
  const el = document.createElement('div');
  el.className = `toast${bad ? ' bad' : ''}`;
  el.textContent = msg;
  $('toasts').appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

let accounts = [];
let selected = null;
let view = 'home';
let progression = null;
let assist = null;
let gridRects = [];
let brain = null;

const colorOf = (a) => (a && a.persona && a.persona.color) || (a && a.color) || '#8b9cff';
const nameOf = (a) => (a.persona ? a.persona.name : a.label || a.id);
const avatar = (a, size = '') => `<div class="avatar ${size} ${a.online ? '' : 'off'}" style="--c:${esc(colorOf(a))}">${esc((a.persona && a.persona.icon) || (a.label || a.id || '?')[0])}</div>`;
function taskLabel(t) {
  if (!t) return 'Idle';
  return ({
    farmLevel: 'Leveling', kill: `Farming at /${t.map}`, script: `${String(t.path || '').split('/').pop().replace(/\.cs$/, '')}`, daily: `Daily: ${t.name}`,
    enhance: 'Enhancing gear', sellJunk: 'Selling junk', bankAc: 'Banking AC items', style: 'Changing outfit', barber: 'At the barber',
    probeEvent: `Checking event ${t.folder}`, follow: `Following ${t.leader}`, assist: `Helping ${t.main}`, gear: 'Swapping gear',
    join: `Going to /${t.map}`, gotoPlayer: `Going to ${t.player}`, quest: `Quest ${t.id}`, wait: 'Waiting', equip: `Equipping ${t.item}`,
  })[t.type] || t.type;
}
function stateOf(a) {
  if (a.status === 'pending') return { text: 'not created', cls: 'bad', dot: '' };
  if (a.running && !a.online) return { text: 'logging in…', cls: 'paused', dot: 'paused' };
  if (a.assisting && a.running) return { text: 'helping you', cls: 'assist', dot: 'on' };
  if (a.running) return a.paused ? { text: 'paused', cls: 'paused', dot: 'paused' } : { text: 'botting', cls: 'on', dot: 'on' };
  if (a.online) return { text: 'online, bot off', cls: '', dot: 'idle' };
  return { text: 'offline', cls: '', dot: '' };
}

// ---------------- navigation ----------------
function show(v) {
  view = v;
  for (const b of document.querySelectorAll('#nav button')) b.classList.toggle('on', b.dataset.view === v);
  for (const s of document.querySelectorAll('.view')) s.hidden = s.dataset.view !== v;
  $('main').classList.toggle('fill', v === 'brain');
  if (v === 'live') api('/ui/grid', { on: true });
  else if (gridRects.length) { gridRects = []; renderLive(); api('/ui/grid', { on: false }); }
  else if (selected) api('/ui/select', { id: null });
  const loaders = { home: renderHome, brain: loadBrain, ultras: loadAssist, plan: renderPlan, items: loadItems, tools: loadTools, settings: loadSettings };
  if (loaders[v]) loaders[v]();
}
ipcRenderer.on('view', (_e, v) => show(v));
ipcRenderer.on('selected', (_e, id) => {
  const was = selected;
  selected = id;
  renderRoster(); renderWatch();
  if (!id && was) show(view);
});
ipcRenderer.on('grid', (_e, rects) => { gridRects = rects || []; renderLive(); });

// ---------------- rail roster + top stats ----------------
function renderRoster() {
  $('roster').innerHTML = accounts.map((a) => {
    const st = stateOf(a);
    return `<div class="rcard ${a.id === selected ? 'sel' : ''}" data-watch="${esc(a.id)}" title="Watch ${esc(nameOf(a))}">
      ${avatar(a, 'sm')}
      <div style="min-width:0"><div class="nm">${esc(nameOf(a))}<span class="sdot ${st.dot}"></span></div><div class="ln">${esc(a.online ? taskLabel(a.current) : st.text)}</div></div>
      <div class="lv">${a.level ? a.level : ''}</div>
    </div>`;
  }).join('');
  const online = accounts.filter((a) => a.online).length;
  const botting = accounts.filter((a) => a.running && !a.paused).length;
  const gold = accounts.reduce((t, a) => t + (a.gold || 0), 0);
  $('topStats').innerHTML = `<span><b>${online}</b>/${accounts.length} online</span><span><b>${botting}</b> botting</span><span><b>${short(gold)}</b> gold</span>`;
}

// ---------------- home ----------------
function card(a) {
  const st = stateOf(a);
  const p = a.persona;
  if (a.status === 'pending') {
    return `<div class="ccard" style="--c:${esc(colorOf(a))}"><div class="head">${avatar(a, 'lg')}<div><div class="title">${esc(nameOf(a))}</div><div class="sub">${esc(a.label)} · not created in AQW yet</div></div><div></div></div>
      <button class="btn wide mt" data-activate="${esc(a.id)}">I created it · start</button></div>`;
  }
  return `<div class="ccard" style="--c:${esc(colorOf(a))}">
    <div class="head">${avatar(a, 'lg')}
      <div><div class="title">${esc(nameOf(a))} <span class="pill ${st.cls}">${esc(st.text)}</span></div><div class="sub">${esc(p ? p.title : a.owner || '')}${a.className ? ` · ${esc(a.className)}` : ''}</div></div>
      <div class="lvl">${a.level ? `<b>${a.level}</b><span>level</span>` : ''}</div></div>
    <div class="doing"><b>${esc(taskLabel(a.current))}${a.map ? ` <span class="muted small">· /${esc(a.map)}</span>` : ''}</b><span>${esc((a.current && a.current.why) || (a.online ? 'deciding what to do next' : 'offline'))}</span></div>
    ${a.online ? `<div class="bar hp"><i style="width:${a.hpMax ? Math.round(a.hp / a.hpMax * 100) : 0}%"></i></div><div class="bar xp"><i style="width:${a.expTo ? Math.round(a.exp / a.expTo * 100) : 0}%"></i></div>` : ''}
    <div class="nums"><div><b>${short(a.gold)}</b><span>gold</span></div><div><b>${short(a.expPerHour)}</b><span>xp / hour</span></div><div><b>${num(a.stats && a.stats.deaths)}</b><span>deaths</span></div></div>
    <div class="actions">
      ${a.running && !a.paused ? `<button class="btn ghost" data-op="pause" data-id="${esc(a.id)}">❚❚ Pause</button>` : `<button class="btn" data-op="start" data-id="${esc(a.id)}">▶ Start</button>`}
      <button class="btn ghost" data-watch="${esc(a.id)}">▦ Watch</button>
      <button class="btn ghost" data-ask="${esc(a.id)}">💬 Ask</button>
    </div>
  </div>`;
}
function renderHome() {
  const online = accounts.filter((a) => a.online).length;
  const botting = accounts.filter((a) => a.running && !a.paused).length;
  $('heroLine').textContent = `${accounts.length} characters · ${online} online · ${botting} botting`;
  $('cards').innerHTML = accounts.map(card).join('');
  api('/overseer/thoughts').then((rows) => {
    const last = rows.filter((r) => r.kind === 'think' || r.kind === 'error').pop();
    $('homeBrain').innerHTML = !last ? 'The AI Brain has not thought yet. Open it to start a chat.'
      : last.kind === 'error' ? `<span class="fail">Last attempt failed: ${esc(last.error)}</span>`
        : `<div>${esc(last.thoughts)}</div><div class="muted small mt">${ago(last.t)} · ${(last.actions || []).length} action(s)</div>`;
  }).catch(() => null);
  api('/drops?n=8').then((rows) => {
    $('homeDrops').innerHTML = rows.map((d) => `<div class="it"><span class="t">${ago(d.t)}</span><b>${esc(d.item)}</b>${d.ac ? '<span class="tag ac">AC</span>' : ''} <span class="muted small">· ${esc(d.bot)}</span></div>`).join('') || '<div class="muted">No drops recorded yet.</div>';
  }).catch(() => null);
}

// ---------------- watching one character ----------------
function renderWatch() {
  const a = accounts.find((x) => x.id === selected);
  $('gamebar').hidden = !a;
  $('top').hidden = !!a;
  $('main').style.display = a ? 'none' : 'block';
  if (!a) return;
  $('gbAvatar').outerHTML = `<div id="gbAvatar" class="avatar sm" style="--c:${esc(colorOf(a))}">${esc((a.persona && a.persona.icon) || a.label[0])}</div>`;
  $('gbName').textContent = `${nameOf(a)} · ${a.label}`;
  $('gbSub').textContent = a.online ? `Level ${a.level} ${a.className || ''} · /${a.map || ''} ${a.cell || ''} · ${taskLabel(a.current)}` : 'offline';
  const st = stateOf(a);
  $('gbState').textContent = st.text;
  $('gbState').className = `pill ${st.cls}`;
  $('bPause').textContent = a.paused ? '▶ Resume' : '❚❚ Pause';
}

// ---------------- live ----------------
let liveHtml = null;
function renderLive() {
  $('liveEmpty').hidden = view !== 'live' || gridRects.length > 0;
  const html = view !== 'live' ? '' : gridRects.map((r) => {
    const a = accounts.find((x) => x.id === r.id) || { id: r.id, label: r.id };
    const where = a.online ? `Lv ${a.level} · /${a.map || ''}` : 'offline';
    return `<div class="live-cell" style="left:${r.x}px;top:${r.y}px;width:${r.width}px;height:${r.height}px;--c:${esc(colorOf(a))}">
      <div class="strip" data-watch="${esc(r.id)}">${avatar(a)}<b>${esc(nameOf(a))}</b><span class="muted">${esc(where)}</span><span class="task">${esc(taskLabel(a.current))}</span><span class="go">⤢ Watch</span></div></div>`;
  }).join('');
  if (html !== liveHtml) { liveHtml = html; $('liveLabels').innerHTML = html; }
}

// ---------------- AI brain ----------------
const BRAIN_HINTS = ["What's everyone doing, and is anything wrong?", 'Any boosts today or this week?', 'How do I get Lord of Order?', 'Why is Nova dying?', 'Which ultra classes are we missing?'];
let brainRows = [];          // chat rows currently drawn
let brainSending = false;
// Small markdown: paragraphs, **bold**, `code`, ``` blocks, - lists, 1. lists.
function mdLite(src) {
  const out = []; const lines = String(src || '').replace(/\r/g, '').split('\n');
  let list = null; let i = 0;
  const inl = (t) => esc(t).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  const close = () => { if (list) { out.push(`</${list}>`); list = null; } };
  while (i < lines.length) {
    const l = lines[i];
    if (/^```/.test(l)) { close(); const code = []; i++; while (i < lines.length && !/^```/.test(lines[i])) code.push(lines[i++]); i++; out.push(`<pre>${esc(code.join('\n'))}</pre>`); continue; }
    const ul = /^\s*[-*•]\s+(.*)/.exec(l); const ol = /^\s*\d+[.)]\s+(.*)/.exec(l);
    if (ul || ol) { const k = ul ? 'ul' : 'ol'; if (list !== k) { close(); out.push(`<${k}>`); list = k; } out.push(`<li>${inl((ul || ol)[1])}</li>`); i++; continue; }
    close();
    if (!l.trim()) { i++; continue; }
    const para = [l]; i++;
    while (i < lines.length && lines[i].trim() && !/^(```|\s*[-*•]\s|\s*\d+[.)]\s)/.test(lines[i])) para.push(lines[i++]);
    out.push(`<p>${para.map(inl).join('<br>')}</p>`);
  }
  close();
  return out.join('');
}
function brainMsg(m) {
  const when = m.t ? `<span class="when">${new Date(m.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}${m.ms ? ` · ${(m.ms / 1000).toFixed(0)} s` : ''}</span>` : '';
  if (m.role === 'owner') return `<div class="bmsg me"><div class="bb">${esc(m.text)}${when}</div></div>`;
  const acts = (m.actions || []).length ? `<div class="acts">${m.actions.map((x) => `• ${esc(x.action)} ${esc(x.bot || '')} → ${esc(x.result)}`).join('<br>')}</div>` : '';
  const looked = (m.lookedUp || []).length ? `<div class="acts">looked up: ${m.lookedUp.map((u) => esc(u.tool)).join(', ')}</div>` : '';
  return `<div class="bmsg ai"><div class="bav">◉</div><div class="bb">${m.error ? `<span class="fail">${esc(m.text)}</span>` : mdLite(m.text)}${acts}${looked}${when}</div></div>`;
}
// Redraw only when something changed; keep the reader's scroll position unless they were already at the bottom.
function renderChat(rows, force) {
  const log = $('brainChat');
  const same = !force && rows.length === brainRows.length && (!rows.length || rows[rows.length - 1].t === brainRows[brainRows.length - 1].t);
  if (same && !brainSending) return;
  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 60;
  brainRows = rows;
  $('brainHints').hidden = rows.length > 0 && !brainSending ? rows.length > 2 : false;
  log.innerHTML = rows.length || brainSending
    ? rows.map(brainMsg).join('') + (brainSending ? '<div class="bmsg ai" id="brainTyping"><div class="bav">◉</div><div class="bb"><div class="typing"><span></span><span></span><span></span></div><div class="muted small">Thinking… a local model can take 10-60 s</div></div></div>' : '')
    : '<div class="brain-empty"><b>Ask the AI Brain</b><div>How to do something in AQW or Seraph, what the bots are doing, or tell it what they should do.</div></div>';
  if (atBottom || force) log.scrollTop = log.scrollHeight;
}
async function loadBrain() {
  if (!$('brainHints').innerHTML) $('brainHints').innerHTML = BRAIN_HINTS.map((h) => `<button class="chip" data-brainhint="${esc(h)}">${esc(h)}</button>`).join('');
  const [st, chat, thoughts] = await Promise.all([api('/overseer'), api('/overseer/chat'), api('/overseer/thoughts')]).catch(() => [null, [], []]);
  if (!st) return;
  brain = st;
  if (!brainSending) renderChat(chat);
  renderBrainStatus(st, thoughts);
}
function renderBrainStatus(st, thoughts) {
  $('brOn').checked = !!st.enabled;
  $('brAuto').checked = st.mode === 'autopilot';
  const lastStatus = (thoughts || []).filter((r) => r.kind === 'status').pop();
  const state = st.lastError ? 'err' : st.busy ? 'busy' : st.enabled ? 'on' : '';
  $('bhDot').className = `bh-dot ${state}`;
  $('bhSub').textContent = st.busy ? `checking the party…${lastStatus ? ` ${lastStatus.text}` : ''}` : st.enabled ? `on · next check in ${Math.max(0, Math.round((st.nextThinkAt - Date.now()) / 60000))} min` : 'off';
  $('brainStatus').innerHTML = `<b>Checks with</b><span>${esc(st.model === 'auto' ? 'qwen3 4B instruct (fast), else 8B' : st.model)}</span>
    <b>Chats with</b><span>${esc(st.chatModel || st.model)}</span>
    <b>Mode</b><span>${st.mode === 'autopilot' ? 'autopilot (acts by itself)' : 'advisor (asks first)'}</span>
    <b>Last error</b><span>${st.lastError ? `<span class="fail">${esc(st.lastError)}</span>` : '—'}</span>`;
  $('proposalsPanel').hidden = !(st.proposals || []).length;
  $('proposals').innerHTML = (st.proposals || []).map((p) => `<div class="proposal"><b>${esc(p.action)} ${esc(p.bot || '')}</b> ${p.task ? esc(JSON.stringify(p.task)) : ''}<div class="muted small">${esc(p.why)}</div>
    <div class="row"><button class="btn small" data-approve="${esc(p.id)}">✓ Do it</button><button class="btn ghost small" data-dismiss="${esc(p.id)}">✕ No</button></div></div>`).join('');
  $('thoughts').innerHTML = (thoughts || []).filter((r) => r.kind === 'think' || r.kind === 'error').reverse().slice(0, 25).map((r) => (r.kind === 'error'
    ? `<div class="thought err"><div class="t">${ago(r.t)}</div>${esc(r.error)}</div>`
    : `<div class="thought"><div class="t">${ago(r.t)} · ${esc(r.reason)}</div>${esc(r.thoughts)}${(r.actions || []).length ? `<ul>${r.actions.map((x) => `<li>${esc(x.action)} ${esc(x.bot || '')}: ${esc(x.result)}</li>`).join('')}</ul>` : ''}</div>`)).join('') || '<div class="muted">Nothing yet.</div>';
  $('brainDot').className = `dot-status ${state}`;
}
async function sendBrain(text) {
  if (!text || brainSending) return;
  brainSending = true;
  $('brainSend').disabled = true;
  renderChat(brainRows.concat({ role: 'owner', text, t: Date.now() }), true);
  try { await api('/overseer/chat', { message: text }); } catch (e) { toast(`Brain error: ${e.message}`, true); }
  brainSending = false;
  $('brainSend').disabled = false;
  renderChat(await api('/overseer/chat'), true);
}
function brainAutosize() { const t = $('brainInput'); t.style.height = 'auto'; t.style.height = `${Math.min(160, t.scrollHeight)}px`; }
$('brainInput').addEventListener('input', brainAutosize);
$('brainInput').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('brainForm').requestSubmit ? $('brainForm').requestSubmit() : $('brainForm').dispatchEvent(new Event('submit')); } });
$('brainForm').addEventListener('submit', (e) => { e.preventDefault(); const t = $('brainInput').value.trim(); $('brainInput').value = ''; brainAutosize(); sendBrain(t); });
$('brOn').onchange = async () => { await api('/overseer/settings', { enabled: $('brOn').checked }); toast(`AI Brain ${$('brOn').checked ? 'on' : 'off'}`); loadBrain(); };
$('brAuto').onchange = async () => { await api('/overseer/settings', { mode: $('brAuto').checked ? 'autopilot' : 'advisor' }); toast($('brAuto').checked ? 'Autopilot: the brain acts by itself' : 'Advisor: the brain asks before acting'); loadBrain(); };
$('brThink').onclick = async () => { await api('/overseer/think', {}); toast('Checking the party…'); setTimeout(loadBrain, 1500); };

// ---------------- ultras ----------------
const ULTRA_CLASSES = ['', 'Lord of Order', 'StoneCrusher', 'Verus DoomKnight', "King's Echo", 'ArchPaladin', 'Legion Revenant', 'Chaos Avenger', 'Dragon of Time', 'Void Highlord', 'Other'];
let assistDirty = false;
async function loadAssist() {
  if (!progression) progression = await api('/progression').catch(() => null);
  assist = await api('/assist').catch(() => null);
  if (!assist || assistDirty) return;
  $('asOn').checked = !!assist.enabled;
  $('asMain').value = assist.main || '';
  $('asServer').value = assist.server || '';
  $('serverList').innerHTML = (assist.servers || []).map((s) => `<option value="${esc(s.name)}">${esc(`${s.count}/${s.max}`)}</option>`).join('');
  $('asClass').innerHTML = ULTRA_CLASSES.map((c) => `<option value="${esc(c)}">${esc(c || '— not sure —')}</option>`).join('');
  $('asClass').value = assist.mainClass || '';
  $('asMembers').innerHTML = accounts.filter((a) => a.status !== 'pending').map((a) => `<button class="chip ${(assist.members || []).includes(a.id) ? 'sel' : ''}" data-member="${esc(a.id)}" style="--c:${esc(colorOf(a))}">${esc(nameOf(a))}</button>`).join('');
  $('asNote').textContent = assist.enabled ? `On: ${(assist.members || []).length} helper(s) heading to ${assist.main}${assist.server ? ` on ${assist.server}` : ''}.` : 'Off.';
  renderUltraTable();
}
function renderUltraTable() {
  if (!progression) return;
  const members = accounts.filter((a) => a.persona);
  $('ultraTable').innerHTML = Object.entries(progression.ultras).map(([id, u]) => {
    const used = new Set();
    const slots = u.classes.map((c) => {
      if (assist && assist.mainClass && c.toLowerCase() === assist.mainClass.toLowerCase() && !used.has('main')) { used.add('main'); return `<span class="slot"><span class="avatar" style="--c:#4ade80">★</span>${esc(c)} · you</span>`; }
      const who = members.find((m) => m.persona.ultraClass === c && !used.has(m.id));
      if (who) { used.add(who.id); return `<span class="slot"><span class="avatar" style="--c:${esc(colorOf(who))}">${esc(who.persona.icon)}</span>${esc(c)}</span>`; }
      return `<span class="slot"><span class="avatar" style="--c:#394050">?</span>${esc(c)}</span>`;
    }).join('');
    return `<div class="urow"><div class="un">${esc(u.label)}<span>${esc(u.cadence)} · /${esc(id)}</span></div><div>${slots}</div></div>`;
  }).join('');
}
for (const id of ['asMain', 'asServer', 'asClass']) $(id).addEventListener('input', () => { assistDirty = true; });
async function saveAssist(enabled) {
  const members = [...document.querySelectorAll('[data-member].sel')].map((b) => b.dataset.member);
  if (enabled && !members.length) { $('asOn').checked = false; return toast('Pick at least one helper first.', true); }
  assist = await api('/assist', { enabled, main: $('asMain').value.trim(), server: $('asServer').value.trim(), mainClass: $('asClass').value, members });
  assistDirty = false;
  toast(enabled ? `Assist on: ${members.length} helper(s) heading to ${assist.main}` : 'Assist saved (off)');
  loadAssist();
}
$('asSave').onclick = () => saveAssist($('asOn').checked);
$('asOn').onchange = () => saveAssist($('asOn').checked);

// ---------------- plan ----------------
const STATUS_ICON = { owned: '✔', ready: '●', later: '○', paused: '❚❚', stuck: '⚠', planned: '○', 'needs AC': '◈', locked: '🔒' };
async function renderPlan() {
  if (!progression) progression = await api('/progression').catch(() => null);
  if (!progression) return;
  $('stages').innerHTML = progression.stages.map((s) => `<div class="stage"><span class="lv">LEVEL ${s.from}–${s.to}</span><b>${esc(s.label)}</b><span>${esc(s.focus)}</span></div>`).join('');
  const cols = [];
  for (const a of accounts.filter((x) => x.status !== 'pending')) {
    const plan = await api(`/a/${a.id}/bot`, { op: 'plan' }).catch(() => null);
    if (!plan || !plan.goals) continue;
    cols.push(`<div class="pcol" style="--c:${esc(colorOf(a))}"><div class="head">${avatar(a, 'sm')}<div><b>${esc(nameOf(a))}</b><div class="muted small">${esc(plan.stage.label)} · level ${plan.level}</div></div></div>
      ${plan.goals.map((g) => `<div class="goal ${esc(g.status)} ${g.signature ? 'sig' : ''}" title="${esc(g.purpose || '')}"><span class="st">${STATUS_ICON[g.status] || '○'}</span>
        <div class="gl">${esc(g.label)}${g.ultra ? '<span class="tag">ULTRA</span>' : ''}${g.gear ? '<span class="tag gear">GEAR</span>' : ''}${['needs AC', 'locked'].includes(g.status) ? `<span class="tag warn">${esc(g.status)}</span>` : ''}<span class="sub">lvl ${g.when}${g.signature ? ' · specialty' : g.must ? ' · everyone' : ''}</span></div>
        <button class="btn ghost small" data-goal="${esc(g.id)}" data-acc="${esc(a.id)}" data-pause="${g.status === 'paused' ? 'unpause' : 'pause'}">${g.status === 'paused' ? 'resume' : 'pause'}</button></div>`).join('')}</div>`);
  }
  $('planCols').innerHTML = cols.join('') || '<div class="empty">No character online.</div>';
}

// ---------------- items ----------------
let itemTimer = null;
async function loadItems() {
  const drops = await api('/drops?n=60').catch(() => []);
  $('dropsFeed').innerHTML = drops.map((d) => `<div class="it"><span class="t">${ago(d.t)}</span><b>${esc(d.item)}</b>${d.qty > 1 ? ` ×${d.qty}` : ''}${d.ac ? '<span class="tag ac">AC</span>' : ''} <span class="muted small">· ${esc(d.bot)}</span></div>`).join('') || '<div class="muted">No drops recorded yet.</div>';
  if (!$('itemQ').value) $('itemResults').innerHTML = '<div class="muted">Type at least 2 letters to search every backpack and bank.</div>';
}
$('itemQ').oninput = () => {
  clearTimeout(itemTimer);
  itemTimer = setTimeout(async () => {
    const q = $('itemQ').value.trim();
    if (q.length < 2) { loadItems(); return; }
    $('itemResults').innerHTML = '<div class="muted">Searching…</div>';
    const rows = await api(`/items?q=${encodeURIComponent(q)}`).catch(() => []);
    const who = (id) => { const a = accounts.find((x) => x.id === id); return a ? nameOf(a) : id; };
    $('itemResults').innerHTML = rows.length ? `<table><tr><th>Item</th><th>Who</th><th>Where</th><th>Qty</th><th>Boosts</th></tr>${rows.map((r) => `<tr><td>${esc(r.name)}${r.ac ? '<span class="tag ac">AC</span>' : ''}${r.equipped ? '<span class="tag">worn</span>' : ''}</td><td>${esc(who(r.bot))}</td><td>${esc(r.where)}</td><td>${num(r.qty)}</td><td class="muted small">${esc(r.meta)}</td></tr>`).join('')}</table>` : `<div class="muted">Nobody has anything matching "${esc(q)}".</div>`;
  }, 350);
};

// ---------------- tools ----------------
let armySel = new Set();
async function loadLevelParty() {
  const lp = await api('/levelparty').catch(() => null);
  if (!lp) return;
  $('lpOn').checked = !!lp.enabled;
  const who = (id) => { const a = accounts.find((x) => x.id === id); return a ? nameOf(a) : id; };
  $('lpNote').textContent = lp.enabled
    ? `On: ${lp.members.map(who).join(', ') || 'nobody running'} share room ${lp.room}${lp.leader ? `, party leader ${who(lp.leader)}` : ''}. Bots helping your main are left out.`
    : 'Off: every bot levels in its own private room.';
}
$('lpOn').onchange = async () => { await api('/levelparty', { enabled: $('lpOn').checked }); toast($('lpOn').checked ? 'Level together on: bots move into one room and form a party' : 'Level together off'); loadLevelParty(); };
async function loadTools() {
  loadLevelParty();
  $('armyMembers').innerHTML = accounts.filter((a) => a.status !== 'pending').map((a) => `<button class="chip ${armySel.has(a.id) ? 'sel' : ''}" data-armysel="${esc(a.id)}" style="--c:${esc(colorOf(a))}">${esc(nameOf(a))}</button>`).join('');
  const d = await api('/dailies').catch(() => null);
  if (!d) return;
  const who = (id) => { const a = accounts.find((x) => x.id === id); return a ? nameOf(a) : id; };
  const mark = (v) => (v === 'done' ? '<span class="ok">✔</span>' : v === 'failed' ? '<span class="fail">✕</span>' : v === 'unavailable' ? '<span class="no">–</span>' : '<span class="no">·</span>');
  $('dailies').innerHTML = `<table><tr><th>Daily</th>${d.bots.map((b) => `<th>${esc(who(b.id))}</th>`).join('')}</tr>${d.list.map((x) => `<tr><td>${esc(x.name)}</td>${d.bots.map((b) => `<td>${mark(b.dailies[x.name])}</td>`).join('')}</tr>`).join('')}</table><div class="muted small mt">✔ done · ✕ failed · – not available · · not yet</div>`;
}
async function army(op, extra = {}) {
  const members = [...armySel];
  if (!members.length) return toast('Pick at least one character first (step 1).', true);
  const r = await api('/army', { op, members, ...extra });
  toast(`${op}: ${Object.values(r).join(', ')}`);
  refresh();
}
$('armyAll').onclick = () => { const all = accounts.filter((a) => a.status !== 'pending').map((a) => a.id); armySel = armySel.size === all.length ? new Set() : new Set(all); loadTools(); };
$('armyGoto').onclick = () => { const p = $('armyPlayer').value.trim(); if (!p) return toast('Type a player name.', true); army('goto', { player: p }); };
$('armyJoin').onclick = () => { const m = $('armyMap').value.trim(); if (!m) return toast('Type a map name.', true); army('join', { map: m, cell: $('armyCell').value.trim() || 'Enter' }); };
let scriptTimer = null;
$('scriptQ').oninput = () => {
  clearTimeout(scriptTimer);
  scriptTimer = setTimeout(async () => {
    const q = $('scriptQ').value.trim();
    if (q.length < 2) { $('scripts').innerHTML = ''; return; }
    const list = await api(`/scripts?q=${encodeURIComponent(q)}`);
    $('scripts').innerHTML = list.slice(0, 40).map((s) => `<li><div><div>${esc(s.name)}</div><div class="p">${esc(s.path)}</div></div><div class="row"><button class="btn ghost small" data-runsel="${esc(s.path)}">Run for selected</button></div></li>`).join('') || '<li class="muted">No scripts match.</li>';
  }, 250);
};

// ---------------- settings ----------------
const NOTIFY_KINDS = { levelUp: 'Level ups', drop: 'AC / rare drops', alert: 'Problems (deaths, login)', event: 'Live events found', news: 'AQW news', crash: 'Game crashes', overseer: 'AI Brain messages' };
async function loadSettings() {
  const st = await api('/hub/settings').catch(() => null);
  if (st) {
    const n = st.notify || {};
    $('notifyToggles').innerHTML = Object.entries(NOTIFY_KINDS).map(([k, label]) => `<div class="toggle"><span>${esc(label)}</span><label class="switch"><input type="checkbox" data-notify="${k}" ${n[k] !== false ? 'checked' : ''}><span></span></label></div>`).join('');
  }
  const o = await api('/overseer').catch(() => null);
  if (o) { $('setModel').value = o.model; $('setEvery').value = o.thinkEveryMin; }
  try {
    const [k, s2, log] = await Promise.all([api('/knowledge'), api('/state'), api('/hub/log')]);
    const up = s2.updater || {};
    $('world').innerHTML = `<b>Game</b><span>${esc(k.gameTitle || '—')}</span><b>Event candidates</b><span>${esc(k.events.map((e) => e.folder).join(', ') || 'none')}</span>
      <b>Dailies known</b><span>${k.dailies.length}</span><b>Knowledge</b><span>${esc(k.meta.generatedAt || '—')}</span><b>Last update</b><span>${esc(up.lastRun || '—')}</span>`;
    $('hubLog').textContent = log.slice(-80).map((l) => `${l.slice(11, 19)} ${l.slice(25)}`).join('\n');
  } catch { /* */ }
}
document.addEventListener('change', async (e) => {
  const t = e.target.closest('[data-notify]');
  if (!t) return;
  const st = await api('/hub/settings');
  await api('/hub/settings', { notify: Object.assign({}, st.notify, { [t.dataset.notify]: t.checked }) });
  toast(`${NOTIFY_KINDS[t.dataset.notify]}: ${t.checked ? 'on' : 'off'}`);
});
$('setSaveAi').onclick = async () => { await api('/overseer/settings', { model: $('setModel').value.trim() || 'qwen3:8b', chatModel: $('setModel').value.trim() || 'qwen3:8b', thinkEveryMin: Math.max(2, Math.min(60, Number($('setEvery').value) || 10)) }); toast('AI settings saved'); };
$('btnUpdate').onclick = async () => { toast('Checking for updates…'); await api('/update', {}); toast('Knowledge updated'); loadSettings(); };
$('btnReport').onclick = async () => { await api('/report', {}); toast('Report written to the Obsidian vault'); };
$('btnAdd').onclick = () => $('addDlg').showModal();
$('addCancel').onclick = () => $('addDlg').close();
$('addOk').onclick = async () => {
  const f = new FormData($('addForm'));
  if (!f.get('username') || !f.get('password')) return;
  $('addDlg').close();
  const r = await api('/accounts', { username: f.get('username'), password: f.get('password'), email: f.get('email'), autostart: !!f.get('autostart') });
  toast(r.error ? `Add account failed: ${r.error}` : `Added ${r.label}`, !!r.error);
  $('addForm').reset();
  refresh();
};

// ---------------- ask one character ----------------
let askId = null;
const ASK_HINTS = ['Where are you?', 'What are you doing?', "What's next?", 'How much gold?', 'What classes do you own?', 'Deaths today?', 'What are you wearing?'];
async function openAsk(id) {
  askId = id || askId || (accounts.find((a) => a.online) || accounts[0] || {}).id;
  $('askWho').innerHTML = accounts.filter((a) => a.status !== 'pending').map((a) => `<button class="chip ${a.id === askId ? 'sel' : ''}" data-askwho="${esc(a.id)}" style="--c:${esc(colorOf(a))}">${esc(nameOf(a))}</button>`).join('');
  $('askHints').innerHTML = ASK_HINTS.map((h) => `<button class="chip" data-askhint="${esc(h)}">${esc(h)}</button>`).join('');
  const rows = await api(`/a/${askId}/chat`).catch(() => []);
  $('askLog').innerHTML = rows.map((r) => `<div class="msg me">${esc(r.question)}</div><div class="msg ai" style="--c:${esc(colorOf(accounts.find((x) => x.id === askId)))}"><b class="who">${esc(r.who)}</b>${esc(r.answer)}</div>`).join('') || '<div class="muted">Ask about items, quests, dailies, goals or where they are. Answers come straight from the game data.</div>';
  $('askLog').scrollTop = $('askLog').scrollHeight;
  if (!$('askDlg').open) $('askDlg').showModal();
  $('askInput').focus();
}
async function sendAsk(q) {
  if (!q || !askId) return;
  const r = await api(`/a/${askId}/ask`, { q }).catch((e) => ({ answer: e.message, who: askId, question: q }));
  const log = $('askLog');
  if (log.querySelector('.muted')) log.innerHTML = '';
  log.insertAdjacentHTML('beforeend', `<div class="msg me">${esc(q)}</div><div class="msg ai" style="--c:${esc(colorOf(accounts.find((x) => x.id === askId)))}"><b class="who">${esc(r.who)}</b>${esc(r.answer || r.error)}</div>`);
  log.scrollTop = log.scrollHeight;
}
$('askForm').addEventListener('submit', (e) => { e.preventDefault(); const q = $('askInput').value.trim(); $('askInput').value = ''; sendAsk(q); });
$('askClose').onclick = () => $('askDlg').close();

// ---------------- command palette ----------------
function commands() {
  const list = [
    { i: '⌂', label: 'Home', group: 'Go to', run: () => show('home') },
    { i: '▦', label: 'Live screens (watch everyone)', group: 'Go to', run: () => show('live') },
    { i: '◉', label: 'AI Brain: chat and ask how to do something', group: 'Go to', run: () => show('brain') },
    { i: '⚔', label: 'Help my main with ultras', group: 'Go to', run: () => show('ultras') },
    { i: '☰', label: 'Plan & goals', group: 'Go to', run: () => show('plan') },
    { i: '⌕', label: 'Find an item (backpacks + banks)', group: 'Go to', run: () => { show('items'); setTimeout(() => $('itemQ').focus(), 50); } },
    { i: '⚙', label: 'Army commands, scripts, dailies', group: 'Go to', run: () => show('tools') },
    { i: '☼', label: 'Settings & notifications', group: 'Go to', run: () => show('settings') },
    { i: '▶', label: 'Start all bots', group: 'Everyone', run: () => runCmd('startAll') },
    { i: '❚❚', label: 'Pause all bots', group: 'Everyone', run: () => runCmd('pauseAll') },
    { i: '▶', label: 'Resume all bots', group: 'Everyone', run: () => runCmd('resumeAll') },
    { i: '■', label: 'Stop all bots', group: 'Everyone', run: () => runCmd('stopAll') },
    { i: '👥', label: 'Level together on (same room + party)', group: 'Everyone', run: () => api('/levelparty', { enabled: true }).then(() => toast('Level together on')) },
    { i: '👤', label: 'Level together off (own rooms)', group: 'Everyone', run: () => api('/levelparty', { enabled: false }).then(() => toast('Level together off')) },
    { i: '⇩', label: 'Bank AC items for everyone', group: 'Everyone', run: () => api('/army', { op: 'task', task: { type: 'bankAc' } }).then(() => toast('Queued for everyone')) },
    { i: '◉', label: 'Ask the AI Brain to think now', group: 'AI', run: () => api('/overseer/think', {}).then(() => toast('The brain is thinking…')) },
    { i: '⟳', label: 'Fix display (window went black)', group: 'App', run: () => fixDisplay() },
    { i: '⟳', label: 'Check for updates', group: 'App', run: () => $('btnUpdate').click() },
    { i: '＋', label: 'Add an account', group: 'App', run: () => $('addDlg').showModal() },
  ];
  for (const a of accounts.filter((x) => x.status !== 'pending')) {
    const n = nameOf(a);
    list.push(
      { i: '▦', label: `Watch ${n}`, group: n, run: () => api('/ui/select', { id: a.id }) },
      { i: '💬', label: `Ask ${n} a question`, group: n, run: () => openAsk(a.id) },
      { i: '▶', label: `Start ${n}`, group: n, run: () => api(`/a/${a.id}/bot`, { op: 'resume' }).then(() => api(`/a/${a.id}/bot`, { op: 'start' })).then(() => toast(`${n} started`)) },
      { i: '❚❚', label: `Pause ${n}`, group: n, run: () => api(`/a/${a.id}/bot`, { op: 'pause' }).then(() => toast(`${n} paused`)) },
      { i: '■', label: `Stop ${n}`, group: n, run: () => api(`/a/${a.id}/bot`, { op: 'stop' }).then(() => toast(`${n} stopping`)) },
    );
  }
  return list;
}
let cmdItems = []; let cmdIndex = 0;
function openCmd() { $('cmdk').hidden = false; $('cmdInput').value = ''; renderCmd(); $('cmdInput').focus(); }
function closeCmd() { $('cmdk').hidden = true; }
function renderCmd() {
  const q = $('cmdInput').value.trim().toLowerCase();
  const words = q.split(/\s+/).filter(Boolean);
  cmdItems = commands().filter((c) => words.every((w) => `${c.label} ${c.group}`.toLowerCase().includes(w)));
  if (q && !cmdItems.length) cmdItems = [{ i: '◉', label: `Ask the AI Brain: "${$('cmdInput').value.trim()}"`, group: 'AI', run: () => { show('brain'); sendBrain($('cmdInput').value.trim()); } }];
  else if (q.length > 12) cmdItems.push({ i: '◉', label: `Ask the AI Brain: "${$('cmdInput').value.trim()}"`, group: 'AI', run: () => { show('brain'); sendBrain($('cmdInput').value.trim()); } });
  cmdIndex = Math.min(cmdIndex, Math.max(0, cmdItems.length - 1));
  $('cmdList').innerHTML = cmdItems.map((c, i) => `<div class="cmd ${i === cmdIndex ? 'on' : ''}" data-cmdi="${i}"><span class="ci">${esc(c.i)}</span>${esc(c.label)}<span class="cg">${esc(c.group)}</span></div>`).join('');
}
function runCmdIndex(i) { const c = cmdItems[i]; if (!c) return; const q = $('cmdInput').value; closeCmd(); $('cmdInput').value = q; c.run(); }
$('cmdInput').oninput = () => { cmdIndex = 0; renderCmd(); };
$('cmdInput').onkeydown = (e) => {
  if (e.key === 'ArrowDown') { cmdIndex = Math.min(cmdItems.length - 1, cmdIndex + 1); renderCmd(); e.preventDefault(); }
  if (e.key === 'ArrowUp') { cmdIndex = Math.max(0, cmdIndex - 1); renderCmd(); e.preventDefault(); }
  if (e.key === 'Enter') runCmdIndex(cmdIndex);
  if (e.key === 'Escape') closeCmd();
};
$('cmdOpen').onclick = openCmd;
$('cmdk').onclick = (e) => { if (e.target.id === 'cmdk') closeCmd(); };

async function runCmd(name) {
  const op = { startAll: 'start', pauseAll: 'pause', resumeAll: 'resume', stopAll: 'stop' }[name];
  const r = await api('/army', { op });
  toast(`${op}: ${Object.values(r).length} bot(s)`);
  refresh();
}
function fixDisplay() { ipcRenderer.send('repaint', true); toast('Redrawing the window'); }

// ---------------- global clicks + keys ----------------
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); if ($('cmdk').hidden) openCmd(); else closeCmd(); }
  if (e.key === 'F9') { e.preventDefault(); toast('Redrawing the window'); }   // main.js does the redraw (any focus)
  if (e.key === 'Escape' && !$('cmdk').hidden) closeCmd();
});
document.addEventListener('visibilitychange', () => { if (!document.hidden) ipcRenderer.send('repaint'); });
$('btnFix').onclick = fixDisplay;

document.addEventListener('click', async (e) => {
  const nav = e.target.closest('#nav button');
  if (nav) return show(nav.dataset.view);
  const go = e.target.closest('[data-view-go]');
  if (go) return show(go.dataset.viewGo);
  const cmd = e.target.closest('[data-cmd]');
  if (cmd) return runCmd(cmd.dataset.cmd);
  const ci = e.target.closest('[data-cmdi]');
  if (ci) return runCmdIndex(Number(ci.dataset.cmdi));
  const w = e.target.closest('[data-watch]');
  if (w) {
    const a = accounts.find((x) => x.id === w.dataset.watch);
    if (a && a.status === 'pending') return toast(`${nameOf(a)} isn't created yet.`, true);
    return api('/ui/select', { id: w.dataset.watch });
  }
  const op = e.target.closest('[data-op]');
  if (op) {
    if (op.dataset.op === 'start') await api(`/a/${op.dataset.id}/bot`, { op: 'resume' });
    const r = await api(`/a/${op.dataset.id}/bot`, { op: op.dataset.op });
    toast(r.error ? r.error : `${op.dataset.op}: ${op.dataset.id}`, !!r.error);
    return refresh();
  }
  const act = e.target.closest('[data-activate]');
  if (act) { const r = await api(`/accounts/${act.dataset.activate}/activate`, {}); toast(r.error ? r.error : 'Opening the game…', !!r.error); return refresh(); }
  const ask = e.target.closest('[data-ask]');
  if (ask) return openAsk(ask.dataset.ask);
  const aw = e.target.closest('[data-askwho]');
  if (aw) return openAsk(aw.dataset.askwho);
  const ah = e.target.closest('[data-askhint]');
  if (ah) return sendAsk(ah.dataset.askhint);
  const bh = e.target.closest('[data-brainhint]');
  if (bh) return sendBrain(bh.dataset.brainhint);
  const ap = e.target.closest('[data-approve]');
  if (ap) { const r = await api('/overseer/approve', { id: ap.dataset.approve }); toast(`Done: ${r.result || r.error}`); return loadBrain(); }
  const di = e.target.closest('[data-dismiss]');
  if (di) { await api('/overseer/dismiss', { id: di.dataset.dismiss }); return loadBrain(); }
  const mem = e.target.closest('[data-member]');
  if (mem) { assistDirty = true; mem.classList.toggle('sel'); return; }
  const as = e.target.closest('[data-armysel]');
  if (as) { if (armySel.has(as.dataset.armysel)) armySel.delete(as.dataset.armysel); else armySel.add(as.dataset.armysel); return loadTools(); }
  const ar = e.target.closest('[data-army]');
  if (ar) return army(ar.dataset.army);
  const at = e.target.closest('[data-army-task]');
  if (at) return army('task', { task: JSON.parse(at.dataset.armyTask) });
  const rs = e.target.closest('[data-runsel]');
  if (rs) return army('script', { path: rs.dataset.runsel, hours: 2 });
  const goal = e.target.closest('[data-goal]');
  if (goal) { await api(`/a/${goal.dataset.acc}/bot`, { op: 'goals', [goal.dataset.pause]: goal.dataset.goal }); toast(`${goal.dataset.pause}d ${goal.dataset.goal}`); return renderPlan(); }
});

$('btnBack').onclick = () => api('/ui/select', { id: null });
$('bStart').onclick = async () => { await api(`/a/${selected}/bot`, { op: 'resume' }); const r = await api(`/a/${selected}/bot`, { op: 'start' }); toast(r.ok ? 'Bot started' : 'Bot is already running'); refresh(); };
$('bPause').onclick = async () => { const s = accounts.find((a) => a.id === selected); await api(`/a/${selected}/bot`, { op: s && s.paused ? 'resume' : 'pause' }); refresh(); };
$('bStop').onclick = async () => { await api(`/a/${selected}/bot`, { op: 'stop' }); toast('Stopping after the current step'); refresh(); };
$('bAsk').onclick = () => openAsk(selected);

// ---------------- refresh loop ----------------
async function refresh() {
  try { accounts = await api('/accounts'); } catch { $('heroLine').textContent = 'Seraph is starting…'; return; }
  renderRoster();
  renderWatch();
  if (!selected && view === 'home') renderHome();
  if (view === 'live') renderLive();
}
setInterval(refresh, 3000);
setInterval(() => { if (view === 'brain' && !selected) loadBrain(); else api('/overseer').then((st) => { brain = st; $('brainDot').className = `dot-status ${st.lastError ? 'err' : st.busy ? 'busy' : st.enabled ? 'on' : ''}`; }).catch(() => null); }, 6000);
setInterval(() => { if (!selected && view === 'tools') loadTools(); if (!selected && view === 'plan') renderPlan(); }, 30000);
api('/knowledge').then((k) => { if (k.gameTitle) $('gameTitle').textContent = `AQW · ${k.gameTitle}`; }).catch(() => null);
refresh().then(() => show('home'));
