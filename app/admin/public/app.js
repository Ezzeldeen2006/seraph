// Seraph Admin (browser). /api/* is the bots' own API, /sys/* is the laptop service.
// Home shows every character as a party frame; a character page has Now / Orders / Plan / Log / Settings.
// 2026-10-07 (the owner: "more user friendly and easier to use ... add other accounts and make them farm anything I choose"):
// accounts can be added here (party bots, or "my accounts" that only do the orders they get), and the Orders tab
// builds any order in two steps - pick what to do, then when / how often / until what.
'use strict';
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = (n) => (n == null || Number.isNaN(Number(n)) ? '—' : Number(n).toLocaleString());
const short = (n) => { if (n == null) return '—'; const v = Number(n); if (Math.abs(v) >= 1e6) return `${(v / 1e6).toFixed(1)}M`; if (Math.abs(v) >= 1e4) return `${Math.round(v / 1e3)}k`; return v.toLocaleString(); };
const dur = (ms) => { if (ms == null || ms < 0 || Number.isNaN(ms)) return '—'; const m = Math.floor(ms / 60000); if (m < 1) return `${Math.round(ms / 1000)}s`; if (m < 60) return `${m}m`; return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`; };
const ago = (t) => (t ? `${dur(Date.now() - t)} ago` : '—');
const pct = (a, b) => (b > 0 ? Math.max(0, Math.min(100, (a / b) * 100)) : 0);

// ---------------- network ----------------
async function req(url, data, method) {
  const opts = data === undefined && !method ? {} : { method: method || 'POST', headers: { 'content-type': 'application/json', 'x-seraph': '1' }, body: JSON.stringify(data || {}) };
  const res = await fetch(url, opts);
  if (res.status === 401) { showGate(); throw new Error('signed out'); }
  const text = await res.text();
  let body; try { body = text ? JSON.parse(text) : {}; } catch (e) { body = { error: text }; }
  if (!res.ok) { const e = new Error(body.error || `HTTP ${res.status}`); e.body = body; throw e; }
  return body;
}
const api = (p, data) => req(`/api${p}`, data);
const sys = (p, data) => req(`/sys${p}`, data);
const botOp = (id, op, extra = {}) => api(`/a/${id}/bot`, { op, ...extra });

function toast(msg, bad = false) {
  const el = document.createElement('div');
  el.className = `toast${bad ? ' bad' : ''}`;
  el.textContent = msg;
  $('toasts').appendChild(el);
  setTimeout(() => el.remove(), 4500);
}
async function act(label, fn) {
  try { const r = await fn(); toast(label); refreshSoon(); return r; } catch (e) { toast(`${label} failed: ${e.message}`, true); return null; }
}
function closeDialog() { $('veil').hidden = true; $('dialog').innerHTML = ''; }
function confirmBox(text, yes = 'Yes', typeToConfirm = null) {
  return new Promise((resolve) => {
    $('dialog').innerHTML = `<p>${esc(text)}</p>${typeToConfirm ? `<label style="margin-bottom:16px">Type <b style="color:var(--ink)">${esc(typeToConfirm)}</b> to confirm<input id="dType" autocomplete="off"></label>` : ''}
      <div class="row" style="justify-content:flex-end"><button id="dNo" class="quiet">Cancel</button><button id="dYes" class="primary">${esc(yes)}</button></div>`;
    $('veil').hidden = false;
    $('dNo').onclick = () => { closeDialog(); resolve(false); };
    $('dYes').onclick = () => {
      if (typeToConfirm && $('dType').value.trim().toLowerCase() !== typeToConfirm.toLowerCase()) { $('dType').focus(); return; }
      closeDialog(); resolve(true);
    };
  });
}

// ---------------- state ----------------
let accounts = [];
let botsDown = false;
let svc = null;
let view = localStorage.getItem('view') || 'party';
let tab = localStorage.getItem('tab') || 'watch';
if (tab === 'assign') tab = 'orders';
let ahead = {};
let engine = {};
let journal = {};
let logFilter = '';
let skuaOnly = false;
let scriptSel = null;
let scriptMethods = [];
let drawn = '';
let bodyKey = '';
let libHead = '';
let sysLog = [];
let sysHealth = { findings: [] };
let healthAt = 0;
let healthLog = [];
let reportText = '';
let levelParty = null;
let helpCalls = [];          // open party help calls (GET /help calls): who, boss, squad (Seraph 5)
let helpAt = 0;
let mode = localStorage.getItem('orderMode') || 'item';
let draft = null;            // the order being put together: { title, detail, item, qty, task }
let autoGive = false;        // a "▶ Start" button: give the draft at once (right now, once) instead of showing its options
// The last orders given from this browser, newest first, for one-click "run it again" (like VibeSkua's recent scripts).
const recentOrders = () => { try { return JSON.parse(localStorage.getItem('recentOrders') || '[]'); } catch (e) { return []; } };
function rememberOrder(d) {
  const key = JSON.stringify(d.task);
  const list = [{ title: d.title, detail: d.detail, item: d.item, qty: d.qty, task: d.task }, ...recentOrders().filter((r) => JSON.stringify(r.task) !== key)].slice(0, 8);
  try { localStorage.setItem('recentOrders', JSON.stringify(list)); } catch (e) { /* private window */ }
}
const finds = {};            // per character: { q, qty, loading, res, err }

const TASK = {
  script: (t) => (t.farmerJoe ? 'Farmer Joe' : t.rankClass ? `Ranking ${t.rankClass}` : t.label || `${String(t.path || '').split('/').pop().replace(/\.cs$/, '')}${t.entry ? ` · ${t.entry}(${t.args || ''})` : ''}`),
  farmLevel: (t) => `Leveling${t.to ? ` to ${t.to}` : ''}`,
  kill: (t) => `Farming ${t.item || t.monster || 'monsters'}${t.map ? ` in /${t.map}` : ''}`,
  daily: (t) => `Daily: ${t.name}`, join: (t) => `Travelling to /${t.map}`, wait: () => 'Waiting',
  idle: () => 'Waiting for orders', enhance: () => 'Enhancing gear', sellJunk: () => 'Selling junk', tidy: () => 'Tidying the wardrobe',
  bankAc: () => 'Banking items', style: () => 'Changing outfit', barber: () => 'At the barber',
  probeEvent: (t) => `Checking ${t.folder}`, armyFarm: (t) => `Army farm: ${t.item || t.monster}`,
  assist: (t) => `Helping ${t.who || t.main || ''}`, follow: (t) => `Following ${t.leader}`, quest: (t) => `Quest ${t.id}`,
};
const taskLabel = (t) => (!t ? 'Nothing' : (TASK[t.type] ? TASK[t.type](t) : t.type));
const REPEAT = { always: 'repeats', daily: 'every day' };
const taskTags = (t) => [t.repeat ? REPEAT[t.repeat] : '', t.untilHave ? `until ${num(t.untilHave.qty)} ${t.untilHave.item}` : '', t.hours ? `${t.hours} h max` : ''].filter(Boolean);
const sameTask = (a, b) => !!(a && b && a.type === b.type && (a.path || '') === (b.path || '') && (a.entry || '') === (b.entry || '') && (a.args || '') === (b.args || '') && (a.name || '') === (b.name || ''));
const isGuest = (a) => !!(a && a.kind === 'guest');
function stateOf(a) {
  if (botsDown) return { text: 'bots offline', tone: 'bad' };
  if (isGuest(a) && !a.online && !a.wantOnline) return { text: 'logged out', tone: '' };
  if (!a.online && a.connecting) return { text: a.knocking ? 'waiting for a seat on Artix' : 'logging in', tone: 'warn' };
  if (!a.running) return { text: a.online ? 'stopped' : 'logged out', tone: a.online ? 'bad' : '' };
  if (!a.online) return { text: 'logging in', tone: 'warn' };
  if (a.paused) return { text: 'paused', tone: 'warn' };
  if (a.current && a.current.type === 'idle') return { text: 'waiting for orders', tone: 'info' };
  return { text: 'working', tone: 'good' };
}
const botById = (id) => accounts.find((a) => a.id === id);
const lastSkua = (a) => { const l = (a.log || []).slice().reverse().find((x) => x.includes('[skua]')); return l ? l.slice(25).replace(/^\[skua\]\s*(\[\d\d:\d\d:\d\d\]\s*)?/, '') : ''; };
const budgetOf = (t) => (t && t.hours ? t.hours * 3600000 : t && t.minutes ? t.minutes * 60000 : null);
const initial = (a) => String(a.label || a.id)[0].toUpperCase();
const party = () => accounts.filter((a) => !isGuest(a));
const mine = () => accounts.filter(isGuest);

// ---------------- sign in ----------------
function showGate() { $('app').hidden = true; $('gate').hidden = false; setTimeout(() => $('pw').focus(), 50); }
$('gateForm').onsubmit = async (e) => {
  e.preventDefault();
  $('gateErr').textContent = '';
  try { await req('/login', { password: $('pw').value }); $('pw').value = ''; $('gate').hidden = true; $('app').hidden = false; await refresh(); }
  catch (err) { $('gateErr').textContent = err.message === 'wrong password' ? 'That password does not match.' : err.message; }
};
$('signout').onclick = async () => { await req('/logout', {}); showGate(); };

// ---------------- data ----------------
async function refresh() {
  try { accounts = await api('/accounts'); botsDown = false; }
  catch (e) { if (e.message === 'signed out') return; botsDown = !!(e.body && e.body.botsDown); }
  try { svc = await sys('/status'); } catch (e) { /* signed out */ }
  if (!levelParty) api('/levelparty').then((r) => { levelParty = r; }).catch(() => null);
  if (Date.now() - healthAt > 60000) { healthAt = Date.now(); api('/health').then((r) => { sysHealth = r || { findings: [] }; draw(); }).catch(() => null); }
  if (Date.now() - helpAt > 15000) { helpAt = Date.now(); api('/help').then((r) => { helpCalls = (r && r.calls) || []; }).catch(() => null); }
  if (botById(view)) {
    const id = view;
    await Promise.all([
      botOp(id, 'engine').then((r) => { engine[id] = r; }).catch(() => null),
      api(`/a/${id}/journal?n=400`).then((r) => { journal[id] = r; }).catch(() => null),
    ]);
  }
  draw();
}
let aheadAt = {};
async function loadAhead(id, force = false) {
  if (!force && aheadAt[id] && Date.now() - aheadAt[id] < 20000) return;
  aheadAt[id] = Date.now();
  try { ahead[id] = await botOp(id, 'ahead'); } catch (e) { ahead[id] = { error: e.message }; }
  draw(true);
}
let soonTimer = null;
function refreshSoon() { clearTimeout(soonTimer); soonTimer = setTimeout(() => { aheadAt = {}; refresh(); }, 900); }
async function loadSystem() {
  const q = localStorage.getItem('sysLogQ') || '';
  await Promise.all([
    sys(`/log?n=300&q=${encodeURIComponent(q)}`).then((r) => { sysLog = r; }).catch(() => null),
    api('/health').then((r) => { sysHealth = r || { findings: [] }; healthAt = Date.now(); }).catch(() => null),
    sys('/health').then((r) => { healthLog = r; }).catch(() => null),
    api('/levelparty').then((r) => { levelParty = r; }).catch(() => null),
  ]);
  draw(true);
  sys('/scripts/head').then((r) => { libHead = r.head; draw(true); }).catch(() => null);
}

// ---------------- drawing ----------------
function draw(force = false) {
  drawRoster();
  drawUptime();
  const el = document.activeElement;
  const typing = el && el.closest && el.closest('main') && /INPUT|SELECT|TEXTAREA/.test(el.tagName);
  if (typing && !force) { if (botById(view) && $('head')) { $('head').innerHTML = headHtml(botById(view)); if (tab === 'orders' && $('queueBox')) $('queueBox').innerHTML = queueHtml(botById(view)); } return; }
  if (botById(view)) return drawBot(force);
  if (view !== 'system' && view !== 'party' && view !== 'flash' && view !== 'raids') view = 'party';
  const html = view === 'system' ? systemHtml() : view === 'flash' ? flashHtml() : view === 'raids' ? raidsHtml() : homeHtml();
  if (html !== drawn) { $('main').innerHTML = html; drawn = html; afterDraw(); }
}
// A character page: the frame on top stays live; Now, Log and the order queue refresh with it, the forms only when asked.
function tabsFor(a) {
  return [['watch', 'Watch'], ['now', 'Now'], ['orders', 'Orders'], ...(isGuest(a) ? [] : [['plan', 'Plan']]), ['log', 'Log'], ['settings', 'Settings']];
}
function drawBot(force) {
  const a = botById(view);
  if (!tabsFor(a).some(([k]) => k === tab)) tab = 'watch';
  if (!$('head') || drawn !== `bot:${view}`) { $('main').innerHTML = '<div id="head"></div><div id="body"></div>'; drawn = `bot:${view}`; bodyKey = ''; }
  const head = headHtml(a);
  if ($('head').innerHTML !== head) $('head').innerHTML = head;
  const live = tab === 'now' || tab === 'log' || tab === 'watch';
  const key = `${view}:${tab}:${tab === 'plan' ? JSON.stringify(ahead[view] || null) : ''}`;
  if (tab === 'orders' && !force && key === bodyKey) { if ($('queueBox')) $('queueBox').innerHTML = queueHtml(a); return; }
  const body = tab === 'watch' ? watchHtml(a) : tab === 'now' ? nowHtml(a) : tab === 'plan' ? planHtml(a) : tab === 'orders' ? ordersHtml(a) : tab === 'log' ? logHtml(a) : settingsHtml(a);
  if (!force && key === bodyKey && (!live || $('body').dataset.html === body)) return;
  $('body').innerHTML = body;
  $('body').dataset.html = live ? body : '';
  bodyKey = key;
  afterDraw();
}
function afterDraw() {
  if (botById(view) && tab === 'orders' && mode === 'script') { searchScripts(); drawPick(); }
  document.querySelectorAll('main .log').forEach((box) => { box.scrollTop = box.scrollHeight; });
}

function rosterButton(a) {
  const s = stateOf(a);
  if (window.seraphPC && a.id === window.seraphPC.mainId) {
    return `<button class="member" data-view="${esc(a.id)}" style="--c:${esc(a.color)}"><span class="crest">${esc(initial(a))}</span>
      <span class="who"><b>${esc(a.label)}</b><span><i class="pip good"></i>▶ Play on this PC</span></span></button>`;
  }
  return `<button class="member${view === a.id ? ' on' : ''}" data-view="${esc(a.id)}" style="--c:${esc(a.color)}">
      <span class="crest">${esc(initial(a))}</span>
      <span class="who"><b>${esc(a.label)}</b><span><i class="pip ${s.tone}"></i>${esc(s.tone === 'good' ? taskLabel(a.current) : s.text)}</span></span></button>`;
}
function drawRoster() {
  const working = accounts.filter((a) => stateOf(a).tone === 'good').length;
  const g = mine();
  $('roster').innerHTML = `<button class="member${view === 'party' ? ' on' : ''}" data-view="party"><span class="crest ghost">✧</span><span class="who"><b>Home</b><span>${working} of ${accounts.length} working</span></span></button>`
    + `<button class="member${view === 'raids' ? ' on' : ''}" data-view="raids"><span class="crest ghost">⚔</span><span class="who"><b>Ultra raids</b><span>${esc(raidRailText())}</span></span></button>`
    + (party().length ? `<div class="rail-label">Party bots</div>${party().map(rosterButton).join('')}` : '')
    + `<div class="rail-label">My accounts</div>${g.map(rosterButton).join('')}`
    + '<button class="member add" data-addacct><span class="crest ghost">+</span><span class="who"><b>Add account</b><span>your main, an alt, a new bot</span></span></button>'
    + `<div class="rail-label" style="margin-top:8px">Laptop</div>`
    + `<button class="member${view === 'system' ? ' on' : ''}" data-view="system"><span class="crest ghost">⚙</span><span class="who"><b>System</b><span>${svc ? esc(`${svc.active} · ${num(svc.availableMb)} MB free`) : ''}</span></span></button>`
    + `<button class="member${view === 'flash' ? ' on' : ''}" data-view="flash"><span class="crest ghost">ϟ</span><span class="who"><b>Flash standby</b><span>${flashData && flashData.available ? (flashData.autoOn ? 'ON - real game' : flashData.active && flashData.active.length ? `${flashData.active.length} in Flash` : 'ready') : 'real game backup'}</span></span></button>`;
  if (svc && svc.host) $('host').textContent = svc.host;
}
function drawUptime() {
  if (!svc) return;
  const ok = svc.active === 'active';
  $('uptime').innerHTML = `<div class="row between"><span class="tag ${ok ? 'good' : 'bad'}"><i class="dot"></i>bots ${esc(svc.active || '?')}</span><b>${num(svc.memoryMb)} MB</b></div>
    <div style="margin-top:5px">up ${svc.since ? dur(Date.now() - Date.parse(svc.since)) : '—'} · load ${svc.load ? svc.load[0] : '—'}</div>`;
}

// ---------------- the party frame ----------------
const meter = (label, p, val, cls = '') => `<div class="meter"><span>${label}</span><span class="track"><i class="fill ${cls}" style="width:${p}%"></i></span><span class="val">${esc(val)}</span></div>`;
function frameHtml(a, wide = false) {
  const s = stateOf(a);
  const t = a.current;
  const out = isGuest(a) && !a.online && !a.wantOnline;
  const budget = budgetOf(t);
  const elapsed = t && t.startedAt ? Date.now() - t.startedAt : 0;
  const hp = a.hpMax > 1 ? pct(a.hp, a.hpMax) : null;
  const xp = pct(a.exp, a.expTo);
  const live = lastSkua(a);
  const resting = !a.running || a.paused;
  const head = `<header class="frame-head">
      <span class="crest${wide ? ' big' : ''}">${esc(initial(a))}</span>
      <div class="grow">
        <div class="row tight"><span class="name">${esc(a.label)}</span><span class="tag ${s.tone}"><i class="dot"></i>${esc(s.text)}</span>${isGuest(a) ? '<span class="tag">my account</span>' : ''}</div>
        <div class="title">${esc(a.persona ? a.persona.title : isGuest(a) ? 'Does the orders you give it, nothing else' : '')}</div>
        ${a.style ? `<div class="title style-line" title="${esc(a.style.identity)}">${esc(a.style.identity)} · me time ${a.style.minToday}/${a.style.allowMin} min${a.style.want ? ` · wants ${esc(a.style.want)}` : a.style.dream ? ' · has every dream piece' : ''}</div>` : ''}
      </div>
      <div class="where">${a.level ? `<b>Lv ${a.level}</b> · ${esc(a.className || 'no class')}<br>` : ''}${esc(a.map ? `/${a.map} ${a.cell || ''}` : 'not in game')}</div>
    </header>`;
  if (out) {
    return `<section class="frame${wide ? ' wide' : ''} resting" style="--c:${esc(a.color)}">${head}
      <p class="mute" style="margin:14px 0 0;font-size:13.5px">Logged out. It logs in only when you press <b>Log in</b>, and steps aside by itself if you log in to it in the game.${a.queue && a.queue.length ? ` ${a.queue.length} order(s) are waiting.` : ''}</p>
      <div class="row" style="margin-top:14px"><button class="sm go" data-op="start" data-id="${esc(a.id)}">Log in &amp; start</button><span class="grow"></span>${wide ? '' : `<button class="sm" data-orders="${esc(a.id)}">Orders</button><button class="primary sm" data-view="${esc(a.id)}">Open</button>`}</div>
    </section>`;
  }
  return `<section class="frame${wide ? ' wide' : ''}${resting ? ' resting' : ''}" style="--c:${esc(a.color)}">
    ${head}
    <div class="bars">
      ${a.online && a.hpKnown === false ? meter('HP', 0, 'waiting for the server', 'wait')
        : hp != null ? meter('HP', hp, `${num(a.hp)} / ${num(a.hpMax)}`, hp < 25 ? 'hurt' : hp < 60 ? 'low' : '') : ''}
      ${meter('XP', xp, `${Math.round(xp)}% to ${(a.level || 0) + 1}`, 'xp')}
    </div>

    <div class="cast${t && t.type === 'idle' ? ' idle' : ''}">
      <div class="what"><b>${esc(taskLabel(t))}</b><span class="left">${budget ? `${dur(budget - elapsed)} left` : t ? `${dur(elapsed)} so far` : ''}</span></div>
      <div class="why">${esc(t && t.why ? t.why : isGuest(a) ? 'Give it an order to get it working.' : 'The brain picks the next task.')}${t && taskTags(t).length ? ` · ${esc(taskTags(t).join(' · '))}` : ''}</div>
      <div class="track"><i class="fill" style="width:${budget ? Math.min(100, pct(elapsed, budget)) : 0}%"></i></div>
      ${live ? `<div class="live" title="${esc(live)}">${esc(live)}</div>` : ''}
    </div>

    <div class="tally">
      <div><b>${short(a.stats && a.stats.kills)}</b>kills</div>
      <div><b>${short(a.stats && a.stats.quests)}</b>quests</div>
      <div><b>${short(a.goldPerHour)}</b>gold an hour</div>
      <div><b>${short(a.stats && a.stats.deaths)}</b>deaths</div>
      ${a.queue && a.queue.length ? `<div><b>${a.queue.length}</b>orders waiting</div>` : ''}
    </div>

    <div class="row" style="margin-top:14px">${controls(a)}<span class="grow"></span>${wide ? '' : `<button class="sm" data-orders="${esc(a.id)}">Give an order</button><button class="primary sm" data-view="${esc(a.id)}">Open</button>`}</div>
  </section>`;
}
function controls(a) {
  const b = [];
  if (!a.running) b.push(`<button class="sm go" data-op="start" data-id="${esc(a.id)}">${a.online || a.connecting ? 'Start' : 'Log in & start'}</button>`);
  else {
    b.push(a.paused ? `<button class="sm go" data-op="resume" data-id="${esc(a.id)}">Resume</button>` : `<button class="sm" data-op="pause" data-id="${esc(a.id)}">Pause</button>`);
    b.push(`<button class="sm" data-op="skip" data-id="${esc(a.id)}" title="Stop this task and move on">Skip task</button>`);
    b.push(`<button class="sm stop" data-op="stop" data-id="${esc(a.id)}">Stop</button>`);
  }
  if (isGuest(a) && (a.online || a.wantOnline)) b.push(`<button class="sm" data-op="goOffline" data-id="${esc(a.id)}" title="Log out so you can play it yourself">Log out</button>`);
  return b.join('');
}

// ---------------- home ----------------
// The party's open help calls: a squad (the cheapest characters who can do it) or everyone once a squad was not enough.
function helpHtml() {
  if (!helpCalls.length) return '';
  const name = (id) => esc((botById(id) || {}).label || id);
  return `<section class="attention"><b>Party help now</b>${helpCalls.map((h) => `<div class="row tight" style="flex-wrap:nowrap;align-items:flex-start">
    <span class="tag ${h.full === false ? 'info' : 'warn'}">${h.full === false ? 'squad' : 'everyone'}</span>
    <span class="grow">${esc(h.who)} vs <b>${esc(h.monster)}</b> in /${esc(h.map)}${h.guard ? ' · guarding its script' : ''}${h.farm ? ` · until ${esc(h.farm.item)}` : ''} · ${num(h.kills || 0)} kill${h.kills === 1 ? '' : 's'} · ${(h.helpers || []).map(name).join(', ') || 'nobody free'}</span></div>`).join('')}</section>`;
}
function homeHtml() {
  const servers = [...new Set(party().filter((a) => a.online).map((a) => a.server).filter(Boolean))];
  const where = servers.length === 1 ? `together on ${esc(servers[0])}` : servers.length ? `⚠ split over ${esc(servers.join(', '))}` : 'not in game';
  const online = accounts.filter((a) => a.online).length;
  const working = accounts.filter((a) => stateOf(a).tone === 'good').length;
  const waiting = accounts.filter((a) => stateOf(a).tone === 'info').length;
  const findings = (sysHealth.findings || []).slice(0, 6);
  const pIds = party().map((a) => a.id).join(',');
  return `${botsDown ? '<div class="note">The bots are not answering. Start them again from <b>System</b>.</div>' : ''}
    <div class="row between" style="margin-bottom:18px">
      <div><h1>Home</h1><div class="mute">${online} of ${accounts.length} online · ${working} working${waiting ? ` · ${waiting} waiting for orders` : ''}</div></div>
      <button class="primary" data-addacct>+ Add account</button>
    </div>
    ${findings.length ? `<section class="attention"><b>Needs a look</b>${findings.map((f) => `<div class="row tight" style="flex-wrap:nowrap;align-items:flex-start"><span class="tag ${f.attention ? 'bad' : 'warn'}">${esc(f.bot || 'party')}</span><span class="grow">${esc(f.text)}</span>${f.attention ? `<button class="icon sm quiet" data-dismiss="${esc(f.key)}" title="Done, remove it">✕</button>` : ''}</div>`).join('')}</section>` : ''}
    ${helpHtml()}
    ${party().length ? `<div class="group"><div><h2>Party bots</h2><span class="mute">They play on their own · ${where}${levelParty && levelParty.room ? ` · room ${levelParty.room}` : ''}</span></div>
      <div class="row tight"><button class="sm go" data-all="start" data-members="${esc(pIds)}">Start all</button><button class="sm" data-all="pause" data-members="${esc(pIds)}">Pause all</button><button class="sm" data-all="resume" data-members="${esc(pIds)}">Resume all</button><button class="sm stop" data-all="stop" data-members="${esc(pIds)}">Stop all</button></div></div>
    <div class="frames">${party().map((a) => frameHtml(a)).join('')}</div>` : ''}
    <div class="group"><div><h2>My accounts</h2><span class="mute">They only do what you order</span></div></div>
    <div class="frames">${mine().map((a) => frameHtml(a)).join('')}
      <button class="addcard" data-addacct><b>+ Add an account</b><span>Your main or an alt. Give it any order: an item to farm, a script, a monster to hunt, dailies every day.</span></button></div>`;
}

// ---------------- add an account ----------------
function addAccountDialog() {
  $('dialog').innerHTML = `<h2 style="font-size:18px;margin-bottom:4px">Add an account</h2>
    <p class="mute" style="margin:0 0 16px;font-size:13px">The login is kept on the laptop only, in the account's own folder.</p>
    <div class="stack">
      <label>Username<input id="naUser" autocomplete="off" spellcheck="false"></label>
      <label>Password<input id="naPass" type="password" autocomplete="new-password"></label>
      <label>Name to show (optional)<input id="naLabel" placeholder="e.g. My main"></label>
      <div class="choice">
        <label class="pickcard"><input type="radio" name="naKind" value="guest" checked><span><b>My account</b><small>Does only the orders you give it. Keeps your class, gear and boosts as they are. Steps aside if you log in to it yourself.</small></span></label>
        <label class="pickcard"><input type="radio" name="naKind" value="party"><span><b>Party bot</b><small>Plays on its own with the others: levels, dailies, goals, the party room.</small></span></label>
      </div>
      <p id="naErr" class="err" style="margin:0"></p>
    </div>
    <div class="row" style="justify-content:flex-end;margin-top:16px"><button class="quiet" data-closedlg>Cancel</button><button class="primary" data-addsave>Add account</button></div>`;
  $('veil').hidden = false;
  setTimeout(() => $('naUser').focus(), 30);
}
async function saveAccount() {
  const username = $('naUser').value.trim();
  const password = $('naPass').value;
  const kind = (document.querySelector('input[name=naKind]:checked') || {}).value || 'guest';
  if (!username || !password) { $('naErr').textContent = 'Username and password, please.'; return; }
  $('naErr').textContent = '';
  try {
    const r = await api('/accounts', { username, password, label: $('naLabel').value.trim(), kind });
    closeDialog();
    toast(`${r.label} added${kind === 'guest' ? ' - it stays logged out until you press Log in' : ''}`);
    await refresh();
    view = r.id; tab = 'orders'; localStorage.setItem('view', view); localStorage.setItem('tab', tab); drawn = ''; draw(true);
  } catch (e) { $('naErr').textContent = e.message; }
}

// ---------------- watch: the character live, read from its game world every 2 s ----------------
const watching = {};   // id -> { at, frame, pad, room, target, monsters, users } or { err }
const WATCH_PATHS = { frame: 'world.strFrame', pad: 'world.strPad', room: 'world.curRoom', target: 'world.myAvatar.target', monsters: 'world.monsters', users: 'world.users' };
let watchBusy = false;
async function loadWatch() {
  const a = botById(view);
  if (watchBusy || !a || tab !== 'watch' || document.hidden) return;
  watchBusy = true;
  try {
    const got = await Promise.all(Object.values(WATCH_PATHS).map((p) => botOp(a.id, 'eval', { fn: 'g', args: [p] }).then((r) => r.value).catch(() => null)));
    const w = { at: Date.now() };
    Object.keys(WATCH_PATHS).forEach((k, i) => { w[k] = got[i]; });
    watching[a.id] = w;
    if (view === a.id && tab === 'watch') drawBot(false);
  } finally { watchBusy = false; }
}
function hpTone(p) { return p < 30 ? 'hurt' : p < 60 ? 'low' : ''; }
function watchHtml(a) {
  const w = watching[a.id];
  const recent = (journal[a.id] || a.log || []).slice(-30);
  const logBox = `<section class="panel span"><div class="row between" style="margin-bottom:10px"><h2 style="margin:0">Happening now</h2><button class="sm quiet" data-tab="log">Full log</button></div>
      <div class="log" style="max-height:300px">${logLines(recent) || '<span class="mute">Nothing logged yet.</span>'}</div></section>`;
  if (!a.online) return `<div class="panels"><section class="panel"><div class="empty">${esc(a.label)} is not in the game right now.</div></section>${logBox}</div>`;
  if (!w) return `<div class="panels"><section class="panel"><div class="empty">Looking into the game…</div></section>${logBox}</div>`;
  const me = String(a.username || a.label || a.id).toLowerCase();
  const cell = w.frame || a.cell || '';
  const tgt = w.target && w.target.MonMapID != null ? Number(w.target.MonMapID) : null;
  const mons = (w.monsters || []).filter((m) => m.strFrame === cell).sort((x, y) => (Number(y.MonMapID) === tgt) - (Number(x.MonMapID) === tgt) || (y.intHP > 0) - (x.intHP > 0));
  const monRow = (m) => {
    const dead = !(m.intHP > 0) || m.intState === 0;
    const p = pct(m.intHP, m.intHPMax);
    const on = Number(m.MonMapID) === tgt;
    const hitters = (m.targets || []).length ? ` · fighting ${esc(m.targets.join(', '))}` : '';
    return `<div class="item${on ? ' chosen' : ''}"${dead ? ' style="opacity:.45"' : ''}><div class="what"><b>${on ? '⚔ ' : ''}${esc(m.strMonName)} <span class="mute">lv ${esc(m.intLevel || '?')}</span></b>
      <small>${dead ? 'dead, respawning' : `${num(m.intHP)} / ${num(m.intHPMax)} HP`}${hitters}</small>
      ${dead ? '' : `<div class="meter" style="margin-top:6px"><span>HP</span><span class="track"><i class="fill ${hpTone(p)}" style="width:${p}%"></i></span><span class="val">${Math.round(p)}%</span></div>`}</div></div>`;
  };
  const partyIds = new Set(accounts.map((x) => String(x.username || x.label || x.id).toLowerCase()));
  const rank = (u) => (String(u.strUsername).toLowerCase() === me ? 0 : u.strFrame === cell ? 1 : 2);   // this bot, its cell, the rest
  const users = Object.values(w.users || {}).sort((x, y) => rank(x) - rank(y));
  const userRow = (u) => {
    const name = String(u.strUsername || u.uoName || '?');
    const lower = name.toLowerCase();
    const p = pct(u.intHP, u.intHPMax);
    if (lower === me) u = { ...u, strFrame: cell };   // its own entry in the room list can lag; the world's cell is live
    const tag = lower === me ? '<span class="tag">this bot</span>' : partyIds.has(lower) ? '<span class="tag">our bot</span>' : '';
    return `<div class="item"><div class="what"><b>${esc(name)} <span class="mute">lv ${esc(u.intLevel || '?')}</span> ${tag}</b>
      <small>${u.strFrame ? `in ${esc(u.strFrame)}${u.strFrame === cell ? ' (same cell)' : ''}` : 'in the room'}${u.intState === 0 ? ' · dead' : u.intState === 2 ? ' · fighting' : ''}${u.afk ? ' · AFK' : ''}</small>
      ${u.intHPMax ? `<div class="meter" style="margin-top:6px"><span>HP</span><span class="track"><i class="fill ${hpTone(p)}" style="width:${p}%"></i></span><span class="val">${num(u.intHP)}</span></div>` : ''}</div></div>`;
  };
  return `<div class="panels">
    <section class="panel">
      <h2>Where</h2>
      <div style="font-family:var(--display);font-size:22px;font-weight:600">/${esc(a.map || '?')}${w.room ? `-${esc(w.room)}` : ''}</div>
      <p class="mute" style="margin:4px 0 14px;font-size:13px">cell <b>${esc(cell || '?')}</b> · pad ${esc(w.pad || '?')} · ${esc(a.server || 'no server')} · updated ${esc(dur(Date.now() - w.at))} ago</p>
      <h2 style="margin:6px 0 10px">Monsters in this cell <span class="mute" style="font-size:13px">${mons.filter((m) => m.intHP > 0).length} alive</span></h2>
      <div class="list" style="max-height:360px;overflow:auto">${mons.map(monRow).join('') || '<div class="empty">No monsters in this cell.</div>'}</div>
    </section>
    <section class="panel">
      <h2>Players in the room <span class="mute" style="font-size:13px">${Object.keys(w.users || {}).length}</span></h2>
      <div class="list" style="max-height:470px;overflow:auto">${users.map(userRow).join('') || '<div class="empty">Nobody here.</div>'}</div>
    </section>
    ${logBox}
  </div>`;
}

// ---------------- character page ----------------
function headHtml(a) {
  return `${frameHtml(a, true)}<div class="tabs">${tabsFor(a).map(([k, l]) => `<button class="tab${tab === k ? ' on' : ''}" data-tab="${k}">${l}</button>`).join('')}</div>`;
}

function nowHtml(a) {
  const t = a.current;
  const e = engine[a.id] || {};
  const es = e.status || {};
  const st = es.stats || {};
  const budget = budgetOf(t);
  return `<div class="panels">
    <section class="panel">
      <h2>This task</h2>
      <dl class="facts">
        <dt>Doing</dt><dd>${esc(taskLabel(t))}</dd>
        <dt>Because</dt><dd>${esc(t && t.why ? t.why : '—')}</dd>
        ${t && taskTags(t).length ? `<dt>Order</dt><dd>${esc(taskTags(t).join(' · '))}</dd>` : ''}
        <dt>Started</dt><dd>${t && t.startedAt ? ago(t.startedAt) : '—'}</dd>
        <dt>Time left</dt><dd>${budget ? `${dur(budget - (Date.now() - (t.startedAt || Date.now())))} of ${dur(budget)}` : 'no limit set'}</dd>
        ${t && t.path ? `<dt>Script</dt><dd class="mono">${esc(t.path)}${t.entry ? ` · ${esc(t.entry)}(${esc(t.args || '')})` : ''}</dd>` : ''}
        <dt>Then</dt><dd>${a.queue && a.queue.length ? a.queue.map((q) => esc(taskLabel(q))).join(' → ') : a.settings && a.settings.autopilot === false ? 'waits for your next order' : 'whatever the brain picks'}</dd>
        <dt>Gold</dt><dd>${num(a.gold)} <span class="mute">(${short(a.goldPerHour)} an hour)</span></dd>
        <dt>XP</dt><dd>${num(a.exp)} / ${num(a.expTo)} <span class="mute">(${short(a.expPerHour)} an hour${a.etaLevelMin ? `, next level in ${dur(a.etaLevelMin * 60000)}` : ''})</span></dd>
      </dl>
      <div class="row" style="margin-top:16px"><button class="primary sm" data-tab="orders">Give an order</button>${isGuest(a) ? '' : '<button class="sm" data-tab="plan">See the plan</button>'}</div>
    </section>
    <section class="panel">
      <h2>Skua engine</h2>
      ${e.running ? `<dl class="facts">
          <dt>Running</dt><dd class="mono">${esc(String(e.script || '').split('/Scripts/').pop())}</dd>
          <dt>Memory</dt><dd>${num(es.privateMb || es.memoryMb)} MB</dd>
          <dt>CPU used</dt><dd>${num(Math.round(es.cpuSeconds || 0))} s</dd>
          <dt>This run</dt><dd>${num(st.Kills)} kills · ${num(st.QuestsCompleted)} quests · ${num(st.Drops)} drops · ${num(st.Deaths)} deaths · ${num(st.Relogins)} relogins</dd>
        </dl><div class="row" style="margin-top:14px"><button class="sm stop" data-op="engineStop" data-id="${esc(a.id)}">Stop the script</button></div>`
    : `<p class="mute" style="margin:0">${e.available === false ? 'The engine is not installed on this machine.' : 'No script running right now.'}</p>`}
    </section>
    <section class="panel span">
      <div class="row between" style="margin-bottom:12px"><h2 style="margin:0">Latest</h2><button class="sm quiet" data-tab="log">Open the full log</button></div>
      <div class="log" style="max-height:290px">${logLines((journal[a.id] || a.log || []).slice(-40))}</div>
    </section>
  </div>`;
}

// Goals stop being picked after three failed runs, classes after two: say so, and offer to try again.
function parked(d) {
  return (d.goals || []).some((g) => g.status === 'stuck') || (d.rankUps || []).some((c) => c.parkedUntil) || (d.farmerJoe && d.farmerJoe.failsToday >= 3)
    || !!(d.ledger && d.ledger.held && d.ledger.held.length);
}

// The ledger (lib/ledger.js): work that is resting and why, and what each route has earned per hour.
const OUTCOME = { progress: 'gained', nothing: 'nothing gained', done: 'done', failed: 'failed', stopped: 'stopped', parked: 'parked' };
// Walls (lib/walls.js): the bosses blocking this character, the plan for each, and the party escorts.
const PLAN = { escort: 'party escort', solo: 'solo retry', crowd: 'public crowd', later: 'later', skip: 'skip (cosmetic)', cleared: 'cleared' };
function wallsHtml(d, id) {
  const W = d.walls;
  if (!W) return '';
  const own = (W.walls || []).filter((w) => w.blocks && w.blocks[id]);
  const e = W.active;
  const m = W.mode === 'plan' ? `plan only until ${new Date(W.planOnlyUntil).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}` : W.mode;
  const rows = own.map((w) => `<div class="item"><div class="what"><b>${esc(w.boss || w.item)}</b><small>${esc(PLAN[w.plan.kind] || w.plan.kind)}: ${esc(w.plan.why || '')} · blocks ${esc((w.blocks[id] || []).join(', '))}${w.estimate ? ` · ${esc(w.estimate)}` : ''}</small></div>
    <span class="tag ${w.plan.kind === 'escort' ? 'good' : w.plan.kind === 'later' ? 'warn' : ''}">${esc(PLAN[w.plan.kind] || w.plan.kind)}</span></div>`).join('');
  return `<section class="panel">
      <h2>Walls <span class="mute" style="font-weight:400">· escorts: ${esc(m)}</span></h2>
      ${e ? `<p class="note">Escort under way: ${esc(e.needers.join(', '))} past ${esc(e.boss)} with ${esc(e.helpers.join(', ') || 'nobody else')} (room ${esc(String(e.room || ''))})</p>` : ''}
      <div class="list">${rows || '<div class="empty">No boss is blocking this character.</div>'}</div>
    </section>`;
}

function ledgerHtml(d) {
  const L = d.ledger;
  if (!L) return '';
  const held = (L.held || []).map((h) => `<div class="item"><div class="what"><b>${esc(h.label)}</b><small>${esc(h.why || 'resting')} · until ${new Date(h.until).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}${(h.last || []).length ? ` · last tries: ${h.last.map((x) => `${OUTCOME[x.outcome] || x.outcome}${x.minutes ? ` (${Math.round(x.minutes)} min)` : ''}`).join(', ')}` : ''}</small></div></div>`).join('');
  const routes = (L.routes || []).map((r) => `<div class="item"><div class="what"><b>${esc(r.route)}</b><small>${num(r.xpPerHour)} XP/h · ${Math.round(r.minutes / 60 * 10) / 10} h over ${r.runs} run(s)${r.deaths ? ` · ${r.deaths} deaths` : ''}</small></div></div>`).join('');
  return `<section class="panel">
      <h2>Resting now</h2>
      <div class="list">${held || '<div class="empty">Nothing is resting.</div>'}</div>
      <h2 style="margin-top:16px">Measured routes</h2>
      <div class="list">${routes || '<div class="empty">Not enough time measured yet.</div>'}</div>
    </section>`;
}

function planHtml(a) {
  const d = ahead[a.id];
  if (!d) { loadAhead(a.id); return '<div class="empty">Working out the plan…</div>'; }
  if (d.error) return `<div class="note">${esc(d.error)}</div>`;
  const q = d.queue || [];
  const then = !d.autopilot ? 'Nothing. Autopilot is off, so it waits for your orders.'
    : !d.brainNext ? 'The brain decides.'
      : sameTask(d.brainNext, d.current) && !q.length ? 'Keeps going with this, then the brain decides again.'
        : `<b>${esc(taskLabel(d.brainNext))}</b><small>${esc(d.brainNext.why || '')}</small>`;
  return `<div class="panels">
    <section class="panel">
      <div class="row between" style="margin-bottom:12px"><h2 style="margin:0">Order of work</h2><button class="sm quiet" data-reload>Refresh</button></div>
      <div class="list">
        <div class="item"><span class="step now">now</span><div class="what"><b>${esc(taskLabel(d.current))}</b><small>${esc((d.current && d.current.why) || '')}</small></div></div>
        ${q.map((t, i) => `<div class="item"><span class="step">${i + 1}</span><div class="what"><b>${esc(taskLabel(t))}</b><small>${esc(t.why || '')}</small></div></div>`).join('')}
        <div class="item"><span class="step">then</span><div class="what">${then}</div></div>
      </div>
      ${d.eta && d.eta.level ? `<p style="font-size:13px;margin:12px 0 0"><b>Level 100:</b> ${d.eta.level >= 100 ? 'done' : d.eta.perDay ? `~${d.eta.days} days (${esc(d.eta.at)}) · ${num(Math.round(d.eta.left / 1e5) / 10)} M XP to go at ${num(Math.round(d.eta.perDay / 1e5) / 10)} M/day (${esc(d.eta.source)})` : `${num(Math.round(d.eta.left / 1e5) / 10)} M XP to go (${esc(d.eta.source)})`}${d.eta.boostNote ? ` · ${esc(d.eta.boostNote)}` : ''}</p>` : ''}
      <p class="mute" style="font-size:12.5px;margin:12px 0 0">Your orders always come first. Change them under <a href="#" data-tab="orders">Orders</a>.</p>
    </section>

    <section class="panel">
      <h2 class="row">What the brain works through${parked(d) ? '<button class="sm" data-retry title="Forget the failures that parked this work and start it again">Try parked work again</button>' : ''}</h2>
      <p class="mute" style="margin:-6px 0 14px;font-size:12.5px">Help your main, keep bags and gear in order, weekly content, live events, dailies. Then: every class to rank 10, then Farmer Joe, then goals.</p>
      <h2>Classes still to rank</h2>
      <div class="list">${(d.rankUps || []).map((c) => `<div class="item"><div class="what"><b>${esc(c.name)}</b><small>rank ${c.rank} · ${num(c.cp)} of 302,500${c.parkedUntil ? ` · paused until ${new Date(c.parkedUntil).toLocaleTimeString()}` : ''}</small></div>
        <span class="track" style="width:90px;height:6px;border-radius:99px;background:#10142a;display:block;overflow:hidden"><i class="fill xp" style="display:block;height:100%;width:${Math.min(100, c.cp / 3025)}%;background:linear-gradient(90deg,#6d4dff,#a58bff)"></i></span>
        <button class="sm" data-rank="${esc(c.name)}">Rank now</button></div>`).join('') || '<div class="empty">Every class is rank 10.</div>'}</div>
      <h2 style="margin-top:16px">Farmer Joe</h2>
      <div class="item"><div class="what"><b>${d.farmerJoe.off ? 'Switched off for this character' : d.farmerJoe.doneAt ? `Route finished ${ago(d.farmerJoe.doneAt)}, runs again weekly` : 'Working through the route until it is done'}</b>${d.farmerJoe.failsToday ? `<small>${d.farmerJoe.failsToday} early stop(s) today</small>` : ''}</div><button class="sm" data-fj>Run now</button></div>
    </section>

    <section class="panel">
      <h2>Dailies today</h2>
      <div class="list">${(d.dailies || []).map((x) => `<div class="item"><div class="what"><b>${esc(x.name)}</b></div>
        <span class="tag ${x.status === 'done' ? 'good' : x.status === 'failed' ? 'bad' : x.status === 'to do' ? '' : 'warn'}">${esc(x.status)}</span>
        ${x.status !== 'done' ? `<button class="sm" data-daily="${esc(x.name)}">Do now</button>` : ''}</div>`).join('') || '<div class="empty">None available at this level.</div>'}</div>
    </section>

    ${wallsHtml(d, a.id)}
    ${ledgerHtml(d)}

    <section class="panel">
      <h2>Goals ahead${d.stage ? ` <span class="mute" style="font-weight:400">· ${esc(d.stage.label)}</span>` : ''}</h2>
      <div class="list">${(d.goals || []).map((g) => `<div class="item"><div class="what"><b>${esc(g.label)}</b><small>from level ${g.when}${g.purpose ? ` · ${esc(g.purpose)}` : ''}</small></div>
        <span class="tag ${g.status === 'ready' ? 'good' : g.status === 'stuck' ? 'bad' : g.status === 'paused' ? 'warn' : ''}">${esc(g.status)}</span>
        <button class="sm" data-goal="${esc(g.id)}" data-pause="${g.status === 'paused' ? 'unpause' : 'pause'}">${g.status === 'paused' ? 'Unpause' : 'Pause'}</button></div>`).join('') || '<div class="empty">No goals left.</div>'}</div>
    </section>
  </div>`;
}

// ---------------- orders ----------------
const MODES = [
  ['item', 'Get an item', 'Type what you want; Seraph finds the scripts that farm it'],
  ['script', 'Run a script', 'Any of the 1,900 Skua scripts, or one part of it'],
  ['hunt', 'Hunt monsters', 'A map, a monster, and what it drops'],
  ['quick', 'Quick jobs', 'Dailies, gold, levels, classes, gear'],
];
function recentHtml(a) {
  const list = recentOrders();
  if (!list.length) return '';
  return `<div class="recent"><span class="mute">Run again on ${esc(a.label)}:</span>${list.map((r, i) => `<button class="sm chip" data-recent="${i}" title="${esc(r.detail || r.title)}">▶ ${esc(r.title)}</button>`).join('')}</div>`;
}
function ordersHtml(a) {
  return `<div class="orders">
    <section class="panel">
      <h2>New order</h2>
      ${recentHtml(a)}
      <div class="modes">${MODES.map(([k, t, s]) => `<button class="mode${mode === k ? ' on' : ''}" data-mode="${k}"><b>${t}</b><small>${s}</small></button>`).join('')}</div>
      <div id="modeBody">${modeHtml(a)}</div>
      <div id="draftBox">${draftHtml(a)}</div>
    </section>
    <section class="panel" id="queueBox">${queueHtml(a)}</section>
  </div>`;
}
function modeHtml(a) {
  if (mode === 'item') return itemModeHtml(a);
  if (mode === 'script') {
    return `<input id="scriptQ" placeholder="Search the library: void aura, legion token, gold, daily…" value="${esc(localStorage.getItem('scriptQ') || '')}" style="width:100%">
      <div id="results" class="list" style="margin-top:12px;max-height:260px;overflow:auto"></div>
      <div id="pick" style="margin-top:14px"></div>`;
  }
  if (mode === 'hunt') {
    return `<div class="form">
        <label>Map<input id="kMap" placeholder="battleunderb"></label>
        <label>Cell (optional)<input id="kCell" placeholder="Enter"></label>
        <label>Monster<input id="kMon" placeholder="Skeleton Warrior, or * for any"></label>
        <label>Item it drops (optional)<input id="kItem" placeholder="Bone Dust"></label>
        <label>How many<input id="kQty" type="number" min="1" value="1"></label>
        <label>Quest IDs to turn in (optional)<input id="kQuests" placeholder="2083, 2084"></label>
      </div>
      <div class="row" style="margin-top:12px"><button class="primary sm" data-usehunt data-start>▶ Start now</button><button class="sm" data-usehunt>Options…</button><span class="mute" style="font-size:12.5px">Seraph hunts it itself, no script needed.</span></div>`;
  }
  return `<div class="list">
      ${quickRow('dailies', 'All dailies', 'every daily this account can do (Skua 0AllDailies)')}
      ${quickRow('gold', 'Farm gold', 'Skua GoldFarm')}
      ${quickRow('level', 'Level up', 'Skua Experience farm, up to a level', `<input id="qLvl" type="number" min="2" max="100" value="${Math.min(100, (a.level || 1) + 5)}" style="width:76px" title="level">`)}
      ${quickRow('rank', 'Rank a class to 10', 'any class it owns', '<input id="qRank" placeholder="Class name" style="width:150px">')}
      ${quickRow('fj', 'Farmer Joe', 'the whole route to endgame')}
      ${quickRow('enhance', 'Enhance gear', 'everything it wears, up to its level')}
      ${quickRow('bank', 'Make bag room', 'bank AC items it isn’t using')}
      ${quickRow('travel', 'Go to a map', '', '<input id="qMap" placeholder="battleon" style="width:120px">')}
      ${quickRow('wait', 'Wait', 'stand still', '<input id="qWait" type="number" min="1" value="10" style="width:70px"><span class="mute">min</span>')}
    </div>`;
}
const quickRow = (k, title, sub, extra = '') => `<div class="item"><div class="what"><b>${title}</b>${sub ? `<small>${sub}</small>` : ''}</div>${extra}<button class="sm" data-usequick="${k}">Options…</button><button class="sm primary" data-usequick="${k}" data-start>▶ Start</button></div>`;

function itemModeHtml(a) {
  const f = finds[a.id] || {};
  return `<div class="form" style="grid-template-columns:minmax(0,2fr) minmax(90px,1fr) auto">
      <label>Item<input id="fItem" placeholder="Void Aura, Legion Token, Blood Moon Token…" value="${esc(f.q || '')}"></label>
      <label>How many<input id="fQty" type="number" min="1" value="${esc(f.qty || 1)}"></label>
      <button class="primary" data-find style="height:38px">Find ways</button>
    </div>
    <div id="findOut" style="margin-top:12px">${findOutHtml(a)}</div>`;
}
function findOutHtml(a) {
  const f = finds[a.id];
  if (!f) return '<p class="mute" style="font-size:13px;margin:0">Seraph reads the Skua library for scripts that farm it, merge shops that sell it, and monsters that drop it.</p>';
  if (f.loading) return '<div class="empty">Looking through the script library…</div>';
  if (f.err) return `<div class="note">${esc(f.err)}</div>`;
  const r = f.res || {};
  if (r.note) return `<div class="empty">${esc(r.note)}</div>`;
  const KIND = { merge: 'merge shop', method: 'farm method', script: 'script' };
  const ways = (r.ways || []).map((w, i) => `<div class="item"><div class="what"><b>${esc(w.name)}${w.entry ? ` <span class="mute">· ${esc(w.entry)}</span>` : ''}</b><small>${esc(w.why)} · <span class="mono">${esc(w.path)}</span>${w.desc ? ` · ${esc(w.desc)}` : ''}</small></div><span class="tag">${KIND[w.kind] || w.kind}</span><button class="sm" data-way="${i}">Options…</button><button class="sm primary" data-way="${i}" data-start>▶ Start</button></div>`).join('');
  const hunts = (r.hunts || []).map((h, i) => `<div class="item"><div class="what"><b>Hunt ${esc(h.monster)} in /${esc(h.map)}</b><small>it drops there (seen in ${esc(h.from)})</small></div><span class="tag">hunt</span><button class="sm" data-hunt="${i}">Options…</button><button class="sm primary" data-hunt="${i}" data-start>▶ Start</button></div>`).join('');
  const wear = r.wear ? `<p class="mute" style="font-size:12.5px;margin:10px 0 0">${esc(r.wear.name)}: ${esc(r.wear.slot)}${r.wear.member ? ', members only' : ''}${r.wear.ac ? ', AC' : ''}${r.wear.routes.length ? ` · wiki: ${esc(r.wear.routes.map((x) => x.kind + (x.map ? ` /${x.map}` : '') + (x.monster ? ` ${x.monster}` : '')).join(', '))}` : ''}</p>` : '';
  const quests = (r.quests || []).length ? `<p class="mute" style="font-size:12.5px;margin:6px 0 0">Quest rewards: ${esc(r.quests.map((q) => `${q.name} (${q.id})${q.member ? ' [member]' : ''}`).join(', '))}</p>` : '';
  return `${r.have != null ? `<p style="margin:0 0 10px;font-size:13.5px">${esc(a.label)} has <b>${num(r.have)}</b> ${esc(r.item)} now.</p>` : ''}
    <div class="list" style="max-height:330px;overflow:auto">${ways}${hunts}${!ways && !hunts ? `<div class="empty">No script names “${esc(r.item)}”. Check the spelling, try <a href="#" data-mode="script">Run a script</a>, or hunt it.</div>` : ''}</div>${wear}${quests}`;
}

function setDraft(d) {
  draft = d;
  if ($('draftBox')) $('draftBox').innerHTML = draftHtml(botById(view));
  if (autoGive && d) { autoGive = false; return giveOrder(); }   // the draft's defaults: right now, once, until it has the qty
  const el = $('draftBox'); if (el && d) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}
function draftHtml(a) {
  if (!draft || !a) return '';
  const others = accounts.filter((x) => x.id !== a.id);
  const seg = (name, opts, on) => `<div class="seg">${opts.map(([v, l]) => `<label><input type="radio" name="${name}" value="${v}"${v === on ? ' checked' : ''}><span>${l}</span></label>`).join('')}</div>`;
  return `<div class="draft">
    <div class="row between" style="align-items:flex-start"><div class="grow"><span class="mute" style="font-size:12px">Order for ${esc(a.label)}</span><div style="font-family:var(--display);font-size:16px;font-weight:500">${esc(draft.title)}</div>${draft.detail ? `<small class="mute">${esc(draft.detail)}</small>` : ''}</div><button class="icon sm quiet" data-undraft title="Clear">✕</button></div>
    <div class="opts">
      <div class="opt"><span>When</span>${seg('dWhen', [['now', 'Right now'], ['next', 'After this task'], ['last', 'At the end']], 'now')}</div>
      <div class="opt"><span>Repeat</span>${seg('dRepeat', [['once', 'Once'], ['always', 'Keep repeating'], ['daily', 'Every day']], 'once')}</div>
      ${draft.item ? `<div class="opt"><span>Stop</span><label class="chk"><input type="checkbox" id="dUntil"${draft.qty > 1 ? ' checked' : ''}> when it has <input id="dUntilQty" type="number" min="1" value="${esc(draft.qty || 1)}" style="width:96px"> ${esc(draft.item)}</label></div>` : ''}
      <div class="opt"><span>Time limit</span><label class="chk"><input id="dHours" type="number" min="0.1" step="0.5" placeholder="none" style="width:96px"> hours</label></div>
      ${others.length ? `<div class="opt"><span>Also give it to</span><div class="row tight">${others.map((o) => `<label class="chk"><input type="checkbox" data-also="${esc(o.id)}"> ${esc(o.label)}</label>`).join('')}</div></div>` : ''}
    </div>
    <div class="row" style="margin-top:14px"><button class="primary" data-give>Give order</button><span class="mute" style="font-size:12.5px">“Right now” stops what it is doing; that task waits in the queue.</span></div>
  </div>`;
}
async function giveOrder() {
  const a = botById(view);
  if (!draft || !a) return;
  const when = (document.querySelector('input[name=dWhen]:checked') || {}).value || 'now';
  const repeat = (document.querySelector('input[name=dRepeat]:checked') || {}).value || 'once';
  const task = { ...draft.task, why: draft.task.why || `${draft.title} (from the dashboard)` };
  if (repeat !== 'once') task.repeat = repeat;
  if (draft.item && $('dUntil') && $('dUntil').checked) task.untilHave = { item: draft.item, qty: Math.max(1, Number($('dUntilQty').value) || 1) };
  const hours = Number($('dHours') && $('dHours').value);
  if (hours > 0) task.hours = hours;
  const ids = [a.id, ...[...document.querySelectorAll('input[data-also]:checked')].map((x) => x.dataset.also)];
  const op = when === 'now' ? 'now' : when === 'next' ? 'queueFront' : 'queue';
  let ok = 0;
  for (const id of ids) {
    try {
      const b = botById(id);
      if (isGuest(b) && !b.online && !b.wantOnline && when === 'now') await botOp(id, 'start');
      await botOp(id, op, { task });
      ok++;
    } catch (e) { toast(`${botById(id).label}: ${e.message}`, true); }
  }
  if (ok) { toast(`${draft.title}: ${when === 'now' ? 'started' : 'queued'} for ${ids.slice(0, ok).map((id) => botById(id).label).join(', ')}`); rememberOrder(draft); }
  draft = null;
  if ($('draftBox')) $('draftBox').innerHTML = '';
  refreshSoon();
}

function queueHtml(a) {
  const q = a.queue || [];
  const routines = (a.settings && a.settings.routines) || [];
  const t = a.current;
  return `<h2>Doing now</h2>
    <div class="list"><div class="item"><span class="step now">now</span><div class="what"><b>${esc(taskLabel(t))}</b><small>${esc((t && t.why) || '')}${t && taskTags(t).length ? ` · ${esc(taskTags(t).join(' · '))}` : ''}</small></div>
      ${t && t.type !== 'idle' && a.running ? `<button class="sm" data-op="skip" data-id="${esc(a.id)}">Skip</button>` : ''}</div></div>
    <div class="row between" style="margin:18px 0 10px"><h2 style="margin:0">Up next</h2>${q.length ? '<button class="sm quiet stop" data-clearq>Clear all</button>' : ''}</div>
    <div class="list">${q.map((x, i) => `<div class="item"><span class="step">${i + 1}</span><div class="what"><b>${esc(taskLabel(x))}</b><small>${esc(x.why || '')}${taskTags(x).length ? ` · ${esc(taskTags(x).join(' · '))}` : ''}</small></div>
        <button class="icon sm" data-move="${i}" data-to="${i - 1}" ${i === 0 ? 'disabled' : ''} title="Do sooner">↑</button>
        <button class="icon sm" data-move="${i}" data-to="${i + 1}" ${i === q.length - 1 ? 'disabled' : ''} title="Do later">↓</button>
        <button class="icon sm stop" data-rmq="${i}" title="Remove">✕</button></div>`).join('') || `<div class="empty">No orders waiting. ${a.settings && a.settings.autopilot === false ? 'It waits for your next one.' : 'The brain picks the work.'}</div>`}</div>
    <h2 style="margin:18px 0 10px">Every day</h2>
    <div class="list">${routines.map((r) => `<div class="item"><div class="what"><b>${esc(taskLabel(r.task))}</b><small>${r.paused ? 'paused' : r.lastDay ? `last queued ${esc(r.lastDay)}` : 'not run yet'}${r.task.untilHave ? ` · until ${num(r.task.untilHave.qty)} ${esc(r.task.untilHave.item)}` : ''}</small></div>
        <button class="sm" data-rpause="${esc(r.id)}">${r.paused ? 'Resume' : 'Pause'}</button><button class="icon sm stop" data-rdel="${esc(r.id)}" title="Remove">✕</button></div>`).join('') || '<div class="empty">Give an order with “Every day” and it shows up here, once per server day.</div>'}</div>`;
}

async function searchScripts() {
  const el = $('scriptQ');
  if (!el) return;
  const q = el.value.trim();
  localStorage.setItem('scriptQ', q);
  const box = $('results');
  if (!q) { box.innerHTML = '<div class="empty">Type a name, path or tag to search all 1,900 scripts.</div>'; return; }
  try {
    const list = await api(`/scripts?q=${encodeURIComponent(q)}`);
    box.innerHTML = list.map((s) => `<div class="item pick${scriptSel && scriptSel.path === s.path ? ' chosen' : ''}" data-script="${esc(s.path)}" data-name="${esc(s.name)}" data-desc="${esc(s.description)}">
      <div class="what"><b>${esc(s.name)}</b><small>${esc(s.path)}${s.description ? ` · ${esc(s.description)}` : ''}</small></div></div>`).join('') || '<div class="empty">No script matches that.</div>';
  } catch (e) { box.innerHTML = `<div class="note">${esc(e.message)}</div>`; }
}
function drawPick() {
  const box = $('pick');
  if (!box) return;
  if (!scriptSel) { box.innerHTML = ''; return; }
  box.innerHTML = `<div class="item" style="display:block">
    <div class="row between"><b>${esc(scriptSel.name)}</b><span class="mono mute">${esc(scriptSel.path)}</span></div>
    ${scriptSel.description ? `<p class="mute" style="margin:6px 0 12px;font-size:13px">${esc(scriptSel.description)}</p>` : '<div style="height:10px"></div>'}
    <div class="form">
      <label>Run<select id="sEntry"><option value="">the whole script</option>${scriptMethods.map((m) => `<option value="${esc(m.name)}">only ${esc(m.name)}(${esc(m.params)})</option>`).join('')}</select></label>
      <label>Arguments for that part<input id="sArgs" placeholder='80 or "Master Ranger"'></label>
    </div>
    <div class="row" style="margin-top:12px"><button class="primary sm" data-usescript data-start>▶ Start now</button><button class="sm" data-usescript>Options…</button></div>
  </div>`;
}

function logLines(lines) {
  return lines.map((l) => {
    const ts = String(l).slice(11, 19);
    let msg = String(l).slice(25);
    let cls = '';
    if (/\berror\b|failed|FAILED|Exception|not rank 10|Failed to/.test(msg)) cls = 'err';
    else if (/warn|watchdog|died|stuck|unavailable/i.test(msg)) cls = 'warn';
    else if (/LEVEL UP|rank 10|Completed Quest|task done|finished|order done/i.test(msg)) cls = 'good';
    else if (msg.startsWith('[skua]')) cls = 'skua';
    msg = msg.replace(/^\[skua\]\s*(\[\d\d:\d\d:\d\d\]\s*)?/, '⚙ ');
    return `<span class="t">${esc(ts)}</span> <span class="${cls}">${esc(msg)}</span>`;
  }).join('\n');
}
function logHtml(a) {
  let lines = journal[a.id] || a.log || [];
  if (skuaOnly) lines = lines.filter((l) => l.includes('[skua]'));
  if (logFilter) lines = lines.filter((l) => l.toLowerCase().includes(logFilter.toLowerCase()));
  return `<div class="row" style="margin-bottom:12px"><input id="logQ" class="grow" placeholder="Filter the log" value="${esc(logFilter)}">
      <label class="toggle"><input id="skuaOnly" type="checkbox" ${skuaOnly ? 'checked' : ''}><span class="what"><b>Only script lines</b></span></label></div>
    <div class="log" id="logBox">${logLines(lines.slice(-400)) || '<span class="mute">Nothing logged yet.</span>'}</div>`;
}

function settingsHtml(a) {
  const s = a.settings || {};
  const g = isGuest(a);
  return `<div class="panels">
    <section class="panel">
      <h2>How it works</h2>
      <div class="list">
        ${toggle('autopilot', s.autopilot !== false, 'Plays on its own', g ? 'Off (normal for your account): it does your orders, then waits. On: when the orders run out it levels, does dailies and works through Farmer Joe.' : 'On: the brain picks the next task when your orders run out. Off: it does your orders, then waits.')}
        ${toggle('autoGear', s.autoGear !== false, 'Switches class and gear for each job', 'Puts on the best class and boost gear for the task and enhances it. Off: what it wears stays as you set it (Skua scripts still use the classes below).')}
        ${toggle('useBoosts', s.useBoosts !== false, 'Uses XP / gold / rep / class boosts', 'Uses the daily login boosts when a task starts.')}
        ${toggle('provoke', s.provoke !== false, 'Pulls whole rooms', 'Faster and riskier. Turns itself off for 2 hours after a death.')}
        ${g ? '' : `${toggle('noFarmerJoe', !s.noFarmerJoe, 'Farmer Joe', 'Work through Skua’s route to endgame until it is done.', true)}
        ${toggle('noRankUp', !s.noRankUp, 'Rank every class to 10', 'Rank each class it owns before Farmer Joe continues.', true)}`}
      </div>
    </section>
    <section class="panel">
      <h2>Details</h2>
      <div class="form">
        <label>Class for bosses and quests<input id="setSolo" value="${esc(s.soloClass || '')}" placeholder="${g ? 'leave empty: Skua keeps its own' : 'picked by the class plan'}"${g ? '' : ' disabled'}></label>
        <label>Class for farming<input id="setFarm" value="${esc(s.farmClass || '')}" placeholder="${g ? 'leave empty: Skua keeps its own' : 'picked by the class plan'}"${g ? '' : ' disabled'}></label>
        <label>Server<input id="setServer" value="${esc(s.server || '')}" placeholder="${g ? 'any' : 'the party’s server'}"></label>
        <label>Private room<input id="setRoom" value="${esc(s.privateRoom || '')}" placeholder="${g ? 'public rooms' : 'the party’s room'}"></label>
        <label>Give up after deaths<input id="setDeaths" type="number" min="0" value="${esc(s.giveUpDeaths == null ? 3 : s.giveUpDeaths)}"></label>
        ${g ? '' : `<label>Hours per event<input id="setEventH" type="number" min="0" step="0.5" value="${esc(s.maxEventHours == null ? 2 : s.maxEventHours)}"></label>`}
      </div>
      <div class="row" style="margin-top:14px"><button class="primary sm" data-save>Save</button><span class="mute" style="font-size:12.5px">A new server is used at the next login.</span></div>
    </section>
    <section class="panel">
      <h2>Account</h2>
      <dl class="facts">
        <dt>Type</dt><dd>${g ? 'My account: does only the orders it gets' : 'Party bot: plays on its own with the party'}</dd>
        <dt>Login</dt><dd>${a.online ? 'logged in' : 'logged out'}${a.server ? ` · ${esc(a.server)}` : ''}</dd>
      </dl>
      <div class="row" style="margin-top:14px">
        ${a.online || a.wantOnline ? `<button class="sm" data-op="goOffline" data-id="${esc(a.id)}">Log out</button>` : `<button class="sm go" data-op="goOnline" data-id="${esc(a.id)}">Log in</button>`}
        <button class="sm stop" data-removeacct>Remove this account</button>
      </div>
      ${g ? '<p class="mute" style="font-size:12.5px;margin:12px 0 0">If you log in to this account in the game, the bot logs out and waits until you press Log in here again.</p>' : ''}
    </section>
  </div>`;
}
const toggle = (key, on, title, help, inverted = false) => `<label class="toggle item"><input type="checkbox" data-setting="${key}" data-inverted="${inverted ? 1 : 0}" ${on ? 'checked' : ''}><span class="what"><b>${esc(title)}</b><small>${esc(help)}</small></span></label>`;

// ---------------- system page ----------------
function systemHtml() {
  const v = svc || {};
  const ok = v.active === 'active';
  return `<div class="row between" style="margin-bottom:20px"><div><h1>Laptop</h1><div class="mute">The bots keep running whether this page is open or not.</div></div>
      <div class="row tight"><button data-svc="restart">Restart bots</button><button class="stop" data-svc="stop">Stop bots</button><button class="go" data-svc="start">Start bots</button></div></div>
  <div class="panels">
    <section class="panel">
      <div class="row between" style="margin-bottom:12px"><h2 style="margin:0">Bots service</h2><span class="tag ${ok ? 'good' : 'bad'}"><i class="dot"></i>${esc(v.active || '?')}</span></div>
      <dl class="facts">
        <dt>Running for</dt><dd>${v.since ? dur(Date.now() - Date.parse(v.since)) : '—'}</dd>
        <dt>Crash restarts</dt><dd>${num(v.restarts)}</dd>
        <dt>Memory</dt><dd>${num(v.memoryMb)} of ${num(v.memoryMaxMb)} MB</dd>
        <dt>Laptop memory</dt><dd>${num(v.availableMb)} MB free of ${num(v.totalMb)}</dd>
        <dt>CPU load</dt><dd>${v.load ? v.load.join(' · ') : '—'} <span class="mute">(${v.cpus || '?'} cores)</span></dd>
        <dt>Disk</dt><dd>${num(v.diskFreeMb)} MB free</dd>
      </dl>
      <p class="mute" style="font-size:12.5px;margin:12px 0 0">Each Skua script takes about 320 MB while it runs; at most 4 run at once, the others wait their turn.</p>
    </section>
    <section class="panel">
      <h2>Party</h2>
      <dl class="facts">
        <dt>Server</dt><dd>${esc([...new Set(party().map((a) => a.server).filter(Boolean))].join(', ') || '—')}</dd>
        <dt>Room</dt><dd>${levelParty ? esc(levelParty.room) : '…'}</dd>
        <dt>Grouped</dt><dd>${levelParty ? (levelParty.enabled ? 'yes' : 'no') : '…'}</dd>
      </dl>
      <div class="form" style="margin-top:14px"><label>Room number (1000–99999)<input id="partyRoom" type="number" value="${levelParty ? esc(levelParty.room) : ''}"></label></div>
      <div class="row" style="margin-top:12px"><button class="sm primary" data-room>Save room</button><button class="sm" data-group>${levelParty && levelParty.enabled ? 'Split up' : 'Group up'}</button></div>
      <p class="mute" style="font-size:12.5px;margin:12px 0 0">Scripts move to a new room when they next start. Your own accounts never join the party room.</p>
    </section>
    <section class="panel">
      <div class="row between" style="margin-bottom:12px"><h2 style="margin:0">Health</h2><span class="mute" style="font-size:12.5px">checked every 15 min · alerts go to Discord</span></div>
      <div class="list">${(sysHealth.findings || []).map((f) => `<div class="item"><span class="tag warn">${esc(f.bot || 'party')}</span><div class="what">${esc(f.text)}</div></div>`).join('') || '<div class="empty">Nothing wrong right now.</div>'}</div>
      <div class="row" style="margin-top:12px"><button class="sm" data-health>Check now</button></div>
      ${healthLog.length ? `<details style="margin-top:12px"><summary class="mute" style="cursor:pointer">Earlier findings (${healthLog.length})</summary><div class="log" style="max-height:220px;margin-top:10px">${esc(healthLog.slice().reverse().join('\n'))}</div></details>` : ''}
    </section>
    <section class="panel">
      <h2>Script library</h2>
      <p class="mute" style="margin:-6px 0 12px">Pulled from GitHub every day.${libHead ? ` Now at ${esc(libHead)}.` : ''}</p>
      <button class="sm" data-lib>Update now</button>
      <h2 style="margin-top:20px">Report</h2>
      <div class="row tight"><button class="sm" data-report>Show the report</button><button class="sm" data-discord>Send it to Discord</button></div>
      ${reportText ? `<div class="log" style="margin-top:12px;max-height:300px">${esc(reportText)}</div>` : ''}
    </section>
    <section class="panel">
      <h2>Password</h2>
      <div class="form"><label>Current<input id="pwCur" type="password" autocomplete="current-password"></label><label>New (8 characters or more)<input id="pwNew" type="password" autocomplete="new-password"></label></div>
      <div class="row" style="margin-top:12px"><button class="sm primary" data-pw>Change password</button></div>
      <p class="mute" style="font-size:12.5px;margin:12px 0 0">Changing it signs out every other browser.</p>
    </section>
    <section class="panel span">
      <div class="row between" style="margin-bottom:12px"><h2 style="margin:0">Service log</h2>
        <span class="row tight"><input id="sysLogQ" placeholder="Filter, e.g. nova7" value="${esc(localStorage.getItem('sysLogQ') || '')}"><button class="sm" data-syslog>Refresh</button></span></div>
      <div class="log">${esc(sysLog.join('\n')) || 'Nothing logged.'}</div>
    </section>
  </div>`;
}

// ---------------- events ----------------
document.addEventListener('input', (e) => {
  if (e.target.id === 'scriptQ') { clearTimeout(window._sq); window._sq = setTimeout(searchScripts, 250); }
  if (e.target.id === 'sysLogQ') localStorage.setItem('sysLogQ', e.target.value);
  if (e.target.id === 'logQ') {
    logFilter = e.target.value;
    clearTimeout(window._lq);
    window._lq = setTimeout(() => {
      const box = $('logBox');
      if (!box) return;
      const a = botById(view);
      let lines = journal[view] || (a && a.log) || [];
      if (skuaOnly) lines = lines.filter((l) => l.includes('[skua]'));
      if (logFilter) lines = lines.filter((l) => l.toLowerCase().includes(logFilter.toLowerCase()));
      box.innerHTML = logLines(lines.slice(-400));
    }, 150);
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('veil').hidden) closeDialog();
  if (e.key === 'Enter' && (e.target.id === 'fItem' || e.target.id === 'fQty')) { e.preventDefault(); findItem(); }
  if (e.key === 'Enter' && (e.target.id === 'naUser' || e.target.id === 'naPass' || e.target.id === 'naLabel')) { e.preventDefault(); saveAccount(); }
});
document.addEventListener('change', async (e) => {
  if (e.target.id === 'skuaOnly') { skuaOnly = e.target.checked; draw(true); return; }
  const k = e.target.dataset && e.target.dataset.setting;
  if (k) {
    const value = e.target.dataset.inverted === '1' ? !e.target.checked : e.target.checked;
    const names = { autopilot: 'Plays on its own', autoGear: 'Class and gear switching', useBoosts: 'Boosts', noFarmerJoe: 'Farmer Joe', noRankUp: 'Rank-ups', provoke: 'Pulling rooms' };
    await act(`${names[k] || k}: ${e.target.checked ? 'on' : 'off'}`, () => botOp(view, 'settings', { settings: { [k]: value } }));
    ahead[view] = null;
    await refresh();
    draw(true);
  }
});

async function findItem() {
  const a = botById(view);
  const q = $('fItem').value.trim();
  const qty = Math.max(1, Number($('fQty').value) || 1);
  if (!q) { toast('Type an item first', true); return; }
  finds[a.id] = { q, qty, loading: true };
  $('findOut').innerHTML = findOutHtml(a);
  try { finds[a.id] = { q, qty, res: await api(`/farm/find?item=${encodeURIComponent(q)}&for=${encodeURIComponent(a.id)}&qty=${qty}`) }; }
  catch (e) { finds[a.id] = { q, qty, err: e.message }; }
  if ($('findOut') && view === a.id) $('findOut').innerHTML = findOutHtml(a);
}

document.addEventListener('click', async (e) => {
  if (e.target.id === 'veil') { closeDialog(); return; }
  const el = e.target.closest('button, a, .item.pick');
  if (!el) return;
  const d = el.dataset;
  autoGive = d.start !== undefined;
  if (el.tagName === 'A' && (d.tab || d.mode)) e.preventDefault();
  if (d.recent !== undefined) { const r = recentOrders()[Number(d.recent)]; if (r) { autoGive = true; setDraft(r); } return; }
  // Seraph PC app: the main plays on this PC (window.seraphPC, ui/pc-preload.js); every other page hides that panel.
  if (d.view && window.seraphPC) { if (d.view === window.seraphPC.mainId) { window.seraphPC.openMain(); return; } window.seraphPC.closeMain(); }
  if (d.view) { view = d.view; localStorage.setItem('view', view); drawn = ''; draft = null; if (view === 'system') loadSystem(); if (view === 'flash') loadFlash(); if (view === 'raids') loadPlanner(true); draw(true); refresh(); return; }
  if (d.orders) { view = d.orders; tab = 'orders'; localStorage.setItem('view', view); localStorage.setItem('tab', tab); drawn = ''; draft = null; draw(true); refresh(); return; }
  if (d.tab) { tab = d.tab; localStorage.setItem('tab', tab); bodyKey = ''; draw(true); if (tab === 'plan') loadAhead(view, true); if (tab === 'watch') loadWatch(); return; }
  if (d.addacct !== undefined) return addAccountDialog();
  if (d.dismiss) return act('Removed from the list', () => api('/attention/dismiss', { key: d.dismiss }).then(() => { healthAt = 0; }));
  if (d.closedlg !== undefined) return closeDialog();
  if (d.addsave !== undefined) return saveAccount();
  if (d.mode) { mode = d.mode; localStorage.setItem('orderMode', mode); document.querySelectorAll('.mode').forEach((m) => m.classList.toggle('on', m.dataset.mode === mode)); if ($('modeBody')) $('modeBody').innerHTML = modeHtml(botById(view)); afterDraw(); return; }
  const id = d.id || view;
  if (d.op) {
    const who = botById(id);
    if (d.op === 'stop' && !(await confirmBox(`Stop ${who.label}? It stays logged in but does nothing until you start it again.`, 'Stop'))) return;
    if (d.op === 'goOffline' && !(await confirmBox(`Log ${who.label} out? It stops and stays logged out until you press Log in.`, 'Log out'))) return;
    const words = { start: 'starting', stop: 'stopping', pause: 'paused', resume: 'resumed', skip: 'skipping this task', engineStop: 'stopping the script', goOnline: 'logging in', goOffline: 'logging out' };
    return act(`${who.label}: ${words[d.op] || d.op}`, () => botOp(id, d.op));
  }
  if (d.all) {
    const members = (d.members || '').split(',').filter(Boolean);
    if (d.all === 'stop' && !(await confirmBox('Stop every party bot?', 'Stop all'))) return;
    return act(`Party: ${d.all === 'start' ? 'starting' : d.all === 'stop' ? 'stopping' : `${d.all}d`}`, () => api('/army', { op: d.all, members }));
  }
  if (d.script !== undefined && el.classList.contains('pick')) {
    scriptSel = { path: d.script, name: d.name, description: d.desc };
    scriptMethods = [];
    document.querySelectorAll('.item.pick').forEach((x) => x.classList.toggle('chosen', x === el));
    drawPick();
    api(`/scripts/methods?path=${encodeURIComponent(d.script)}`).then((m) => { scriptMethods = m.filter((x) => x.name !== 'ScriptMain'); drawPick(); }).catch(() => null);
    return;
  }
  if (d.usescript !== undefined && scriptSel) {
    const entry = $('sEntry').value || null;
    const args = entry ? $('sArgs').value.trim() : '';
    return setDraft({ title: entry ? `${scriptSel.name} · ${entry}(${args})` : scriptSel.name, detail: scriptSel.path, task: { type: 'script', path: scriptSel.path, entry, args } });
  }
  if (d.find !== undefined) return findItem();
  if (d.way !== undefined) {
    const f = finds[view]; const w = f && f.res && f.res.ways[Number(d.way)];
    if (!w) return;
    const args = w.kind === 'method' && /^(int|long)\b/.test(String(w.params || '').split(',')[0].trim()) ? String(f.qty) : w.args;
    return setDraft({ title: `Get ${f.res.item}`, detail: `${w.name}${w.entry ? ` · ${w.entry}(${args})` : ''} — ${w.why}`, item: f.res.item, qty: f.qty, task: { type: 'script', path: w.path, entry: w.entry || null, args: args || '', label: `Get ${f.res.item}` } });
  }
  if (d.hunt !== undefined) {
    const f = finds[view]; const h = f && f.res && f.res.hunts[Number(d.hunt)];
    if (!h) return;
    return setDraft({ title: `Get ${f.res.item}`, detail: `hunt ${h.monster} in /${h.map}`, item: f.res.item, qty: f.qty, task: { type: 'kill', map: h.map, monster: h.monster, item: f.res.item, qty: f.qty, minutes: 600 } });
  }
  if (d.usehunt !== undefined) {
    const m = $('kMap').value.trim();
    if (!m) return toast('Type a map first', true);
    const item = $('kItem').value.trim();
    const qty = Number($('kQty').value) || 1;
    const quests = $('kQuests').value.split(/[\s,]+/).map(Number).filter(Boolean);
    const mon = $('kMon').value.trim() || '*';
    return setDraft({ title: `Hunt ${mon === '*' ? 'monsters' : mon} in /${m}`, detail: item ? `for ${qty} ${item}` : '', item: item || null, qty, task: { type: 'kill', map: m, cell: $('kCell').value.trim() || undefined, monster: mon, item: item || undefined, qty, minutes: 600, quests } });
  }
  if (d.usequick) return useQuick(d.usequick);
  if (d.give !== undefined) return giveOrder();
  if (d.undraft !== undefined) { draft = null; if ($('draftBox')) $('draftBox').innerHTML = ''; return; }
  if (d.rank) return act(`Ranking ${d.rank}`, () => botOp(view, 'rankUp', { name: d.rank, now: true }));
  if (d.retry !== undefined) return act('Trying the parked work again', () => botOp(view, 'retry').then(() => { ahead[view] = null; loadAhead(view, true); }));
  if (d.fj !== undefined) return act('Farmer Joe started', () => botOp(view, 'now', { task: { type: 'script', path: 'Other/FarmJoeKits/0FarmerJoeDoAll.cs', goal: 'farmer-joe', farmerJoe: true, why: 'Farmer Joe (from the dashboard)' } }));
  if (d.daily) return act(`Daily ${d.daily} started`, () => botOp(view, 'now', { task: { type: 'daily', name: d.daily } }));
  if (d.goal) return act(`${d.pause === 'pause' ? 'Paused' : 'Unpaused'} ${d.goal}`, () => botOp(view, 'goals', { [d.pause]: d.goal }).then(() => { ahead[view] = null; }));
  if (d.move !== undefined) return act('Moved', () => botOp(view, 'move', { from: Number(d.move), to: Number(d.to) }));
  if (d.rmq !== undefined) return act('Removed', () => botOp(view, 'remove', { index: Number(d.rmq) }));
  if (d.clearq !== undefined) { if (!(await confirmBox('Remove every waiting order?', 'Clear all'))) return; return act('Orders cleared', () => botOp(view, 'clear')); }
  if (d.rpause) return act('Daily order updated', () => botOp(view, 'routines', { pause: d.rpause }));
  if (d.rdel) { if (!(await confirmBox('Stop doing this every day?', 'Remove'))) return; return act('Daily order removed', () => botOp(view, 'routines', { remove: d.rdel })); }
  if (d.reload !== undefined) { ahead[view] = null; return loadAhead(view, true); }
  if (d.save !== undefined) {
    const a = botById(view);
    const settings = { privateRoom: $('setRoom').value.trim() || null, server: $('setServer').value.trim() || null, giveUpDeaths: Number($('setDeaths').value) };
    if ($('setEventH')) settings.maxEventHours = Number($('setEventH').value);
    if (isGuest(a)) { settings.soloClass = $('setSolo').value.trim() || null; settings.farmClass = $('setFarm').value.trim() || null; }
    return act('Settings saved', () => botOp(view, 'settings', { settings }));
  }
  if (d.removeacct !== undefined) {
    const a = botById(view);
    if (!(await confirmBox(`Remove ${a.label} from Seraph? It logs out, and its saved login is deleted from the laptop. The game account itself is not touched.`, 'Remove', a.label))) return;
    const r = await act(`${a.label} removed`, () => api(`/accounts/${a.id}/remove`, {}));
    if (r) { view = 'party'; localStorage.setItem('view', view); drawn = ''; }
    return;
  }
  if (d.svc) {
    if (d.svc !== 'start' && !(await confirmBox(`${d.svc === 'stop' ? 'Stop' : 'Restart'} the bots service? Every character logs out${d.svc === 'restart' ? ' and back in' : ''}.`, d.svc === 'stop' ? 'Stop' : 'Restart'))) return;
    return act(`Bots service ${d.svc === 'restart' ? 'restarting' : d.svc === 'stop' ? 'stopping' : 'starting'}`, () => sys('/service', { op: d.svc }));
  }
  if (d.room !== undefined) { const room = Number($('partyRoom').value); if (!(room >= 1000 && room <= 99999)) return toast('The room must be between 1000 and 99999', true); return act(`Party room set to ${room}`, () => api('/levelparty', { room }).then(loadSystem)); }
  if (d.group !== undefined) return act(levelParty && levelParty.enabled ? 'Party split up' : 'Party grouped up', () => api('/levelparty', { enabled: !(levelParty && levelParty.enabled) }).then(loadSystem));
  if (d.health !== undefined) return act('Health checked', () => api('/health?now=1').then((r) => { sysHealth = r; draw(true); }));
  if (d.lib !== undefined) return act('Script library updated', () => sys('/scripts/update', {}).then((r) => { libHead = r.head; draw(true); }));
  if (d.report !== undefined) return act('Report ready', () => fetch('/api/report/text?hours=24').then((r) => r.text()).then((t) => { try { reportText = JSON.parse(t).text || t; } catch (x) { reportText = t; } draw(true); }));
  if (d.discord !== undefined) return act('Report sent to Discord', () => api('/report/discord', { hours: 24 }));
  if (d.syslog !== undefined) return loadSystem();
  if (d.pw !== undefined) return act('Password changed', () => sys('/password', { current: $('pwCur').value, next: $('pwNew').value }));
});

function useQuick(kind) {
  switch (kind) {
    case 'dailies': return setDraft({ title: 'All dailies', detail: 'Dailies/0AllDailies.cs', task: { type: 'script', path: 'Dailies/0AllDailies.cs', label: 'All dailies' } });
    case 'gold': return setDraft({ title: 'Farm gold', detail: 'Farm/GoldFarm.cs', task: { type: 'script', path: 'Farm/GoldFarm.cs', label: 'Farm gold' } });
    case 'level': { const l = Math.max(2, Math.min(100, Number($('qLvl').value) || 100)); return setDraft({ title: `Level up to ${l}`, detail: 'CoreFarms.Experience', task: { type: 'script', path: 'CoreFarms.cs', entry: 'Experience', args: String(l), label: `Level up to ${l}` } }); }
    case 'rank': { const n = $('qRank').value.trim(); if (!n) return toast('Type the class name first', true); return setDraft({ title: `Rank ${n} to 10`, detail: 'CoreAdvanced.RankUpClass', task: { type: 'script', path: 'CoreAdvanced.cs', entry: 'RankUpClass', args: JSON.stringify(n), rankClass: n } }); }
    case 'fj': return setDraft({ title: 'Farmer Joe', detail: 'the whole route, until done', task: { type: 'script', path: 'Other/FarmJoeKits/0FarmerJoeDoAll.cs', goal: 'farmer-joe', farmerJoe: true } });
    case 'enhance': return setDraft({ title: 'Enhance gear', detail: '', task: { type: 'enhance' } });
    case 'bank': return setDraft({ title: 'Make bag room', detail: 'banks AC items it isn’t using', task: { type: 'bankAc' } });
    case 'travel': { const m = $('qMap').value.trim(); if (!m) return toast('Type a map first', true); return setDraft({ title: `Go to /${m}`, detail: '', task: { type: 'join', map: m, cell: 'Enter', pad: 'Spawn' } }); }
    case 'wait': { const n = Number($('qWait').value) || 10; return setDraft({ title: `Wait ${n} min`, detail: '', task: { type: 'wait', minutes: n } }); }
    default: return null;
  }
}

// ---------------- start ----------------
(async () => {
  const s = await req('/session').catch(() => ({ ok: false }));
  if (!s.ok) return showGate();
  $('app').hidden = false;
  await refresh();
  if (view === 'system') loadSystem();
  loadFlash();
  if (view === 'raids') loadPlanner(true);
  // Every 5 s while the page is on screen, once a minute in a background tab (a forgotten tab polled the laptop every
  // 3 s all day), and at once when it comes back.
  const pollMs = () => (document.hidden ? 60000 : 5000);
  let pollTimer = null;
  const poll = async () => { clearTimeout(pollTimer); await refresh(); pollTimer = setTimeout(poll, pollMs()); };
  pollTimer = setTimeout(poll, pollMs());
  document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
  setInterval(() => { if (!document.hidden && view === 'system') loadSystem(); }, 15000);
  setInterval(() => { if (!document.hidden && tab === 'plan' && botById(view)) loadAhead(view); }, 20000);
  setInterval(loadWatch, 2000);   // the Watch tab: monsters, target and players, live
})();

// ---------------- Flash standby (2026-10-11) ----------------
// The owner: "make a dashboard for it for me to manage how many account and which accounts should run on it". The real AQW
// game in Flash on the laptop, for when Artix changes the game and the headless client can't log in any more.
let flashData = null;
let flashShotAt = 0;
async function loadFlash() {
  try { flashData = await api('/flash'); } catch (e) { flashData = { error: e.message }; }
  flashShotAt = Date.now();
  if (view === 'flash') draw(true);
}
function flashTag(f) {
  if (!f || f.error) return '<span class="tag bad"><i class="dot"></i>unreachable</span>';
  if (!f.available) return '<span class="tag"><i class="dot"></i>not on this machine</span>';
  if (!f.host.installed) return '<span class="tag bad"><i class="dot"></i>Flash not installed</span>';
  if (!f.cfg.enabled) return '<span class="tag"><i class="dot"></i>off</span>';
  if (f.autoOn) return '<span class="tag warn"><i class="dot"></i>standby ON</span>';
  if (f.active.length) return '<span class="tag good"><i class="dot"></i>in use</span>';
  return '<span class="tag good"><i class="dot"></i>ready</span>';
}
function flashHtml() {
  const f = flashData;
  const head = `<div class="row between" style="margin-bottom:20px"><div><h1>Flash standby</h1><div class="mute">The real AQW game on the laptop, for when the normal (headless) client can't log in after an AQW update.</div></div>
      <div class="row tight">${flashTag(f)}${f && f.available && f.cfg && f.cfg.enabled ? (f.autoOn ? '<button data-flashstandby="off">Turn standby off</button>' : '<button class="go" data-flashstandby="on">Turn standby on now</button>') : ''}</div></div>`;
  if (!f) return `${head}<div class="empty">Loading…</div>`;
  if (f.error || !f.available) return `${head}<div class="empty">${esc(f.error || f.why || 'Not available.')}</div>`;
  const c = f.cfg;
  const order = [...c.order.filter((id) => f.accounts.some((a) => a.id === id)), ...f.accounts.filter((a) => !c.order.includes(a.id)).map((a) => a.id)];
  const acc = (id) => f.accounts.find((a) => a.id === id) || { id, label: id };
  const modeSel = (a) => `<select data-flashmode="${esc(a.id)}">${[['auto', 'Auto (only when needed)'], ['flash', 'Always Flash'], ['headless', 'Never Flash']].map(([v, l]) => `<option value="${v}"${a.mode === v ? ' selected' : ''}>${l}</option>`).join('')}</select>`;
  const state = (a) => (a.inFlash ? `<span class="tag good"><i class="dot"></i>Flash${a.loaded ? ' · in game' : ' · loading'}</span>`
    : a.offlineMin ? `<span class="tag bad"><i class="dot"></i>headless · can't log in ${a.offlineMin} min</span>` : `<span class="tag"><i class="dot"></i>headless${a.loaded ? ' · in game' : ''}</span>`);
  // Who goes to Flash when the standby turns on: "Always" first, then the first on "Auto" in this order, up to maxGames.
  const lineUp = [...order.filter((id) => acc(id).mode === 'flash'), ...order.filter((id) => acc(id).mode === 'auto')].slice(0, c.maxGames);
  const rows = order.map((id, i) => {
    const a = acc(id);
    const willFlash = lineUp.includes(id);
    return `<div class="item" style="align-items:center;gap:10px">
        <span class="row tight"><button class="sm quiet" data-flashmove="${esc(id)}" data-dir="-1" ${i === 0 ? 'disabled' : ''} title="Higher priority">↑</button><button class="sm quiet" data-flashmove="${esc(id)}" data-dir="1" ${i === order.length - 1 ? 'disabled' : ''} title="Lower priority">↓</button></span>
        <div class="what" style="flex:1"><b>${i + 1}. ${esc(a.label)}</b>${a.guest ? ' <span class="mute">(your account)</span>' : ''}<div class="mute" style="font-size:12.5px">${willFlash ? (a.inFlash ? 'in Flash now' : a.mode === 'flash' ? 'going to Flash' : 'goes to Flash when the standby turns on') : (a.mode === 'headless' ? 'never uses Flash' : `stays on the normal client (only ${c.maxGames} fit in Flash)`)}${a.error && !a.inFlash ? ` · last error: ${esc(String(a.error).slice(0, 80))}` : ''}</div></div>
        ${state(a)} ${modeSel(a)}
      </div>`;
  }).join('');
  const shots = f.active.length ? `<div class="row" style="flex-wrap:wrap;gap:12px">${f.active.map((id) => `<figure style="margin:0"><img src="/api/flash/shot?id=${encodeURIComponent(id)}&t=${flashShotAt}" alt="${esc(acc(id).label)}" style="width:320px;max-width:100%;border-radius:8px;background:#000;display:block" onerror="this.style.opacity=.2"><figcaption class="mute" style="font-size:12.5px;margin-top:4px">${esc(acc(id).label)}</figcaption></figure>`).join('')}</div>` : '<div class="empty">No character is in Flash right now.</div>';
  const m = f.metrics;
  const num0 = (k, label, min, max) => `<label>${label}<input type="number" min="${min}" max="${max}" data-flashnum="${k}" value="${esc(c[k])}"></label>`;
  return `${head}
  <div class="panels">
    <section class="panel">
      <h2>Standby</h2>
      ${f.autoOn ? `<p style="margin:-4px 0 12px"><b>On since ${esc(new Date(f.autoOn.at).toLocaleString())}</b><br><span class="mute">${esc(f.autoOn.reason)}</span></p>` : '<p class="mute" style="margin:-4px 0 12px">Waiting. It turns on by itself when the normal client fails.</p>'}
      <label class="check"><input type="checkbox" data-flashflag="enabled" ${c.enabled ? 'checked' : ''}> Flash standby allowed</label>
      <label class="check"><input type="checkbox" data-flashflag="auto" ${c.auto ? 'checked' : ''}> Turn on and off by itself</label>
      <label class="check"><input type="checkbox" data-flashflag="separate" ${c.separate ? 'checked' : ''}> One Flash process per character (faster, more memory)</label>
      <label class="check"><input type="checkbox" data-flashflag="hidden" ${c.hidden ? 'checked' : ''}> Don't draw the games (less CPU; the live view goes blank)</label>
      <div class="form" style="margin-top:12px">
        <label>Game window<select data-flashsize>${[['tiny', 'Tiny (least CPU)'], ['small', 'Small'], ['normal', 'Normal']].map(([v, l]) => `<option value="${v}"${c.size === v ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
        <label>Characters in Flash at once<select data-flashmax>${[1, 2, 3, 4].map((n) => `<option${c.maxGames === n ? ' selected' : ''}>${n}</option>`).join('')}</select></label>
        ${num0('loginFailMin', 'Turn on after no login for (min)', 5, 240)}
        ${num0('stallMin', 'or after nothing gained for (min)', 30, 600)}
        ${num0('retryHeadlessMin', 'Try the normal client again every (min)', 15, 720)}
        ${num0('fps', 'Game speed (frames per second)', 1, 24)}
      </div>
      <div class="row" style="margin-top:12px"><button class="sm primary" data-flashsave>Save</button></div>
      <p class="mute" style="font-size:12.5px;margin:12px 0 0">The laptop fits about 3 games next to the scripts. Lower game speed = less CPU; the bots don't need animation.</p>
    </section>
    <section class="panel">
      <div class="row between" style="margin-bottom:12px"><h2 style="margin:0">Flash on the laptop</h2><span class="tag ${f.host.running ? 'good' : ''}"><i class="dot"></i>${f.host.running ? 'running' : 'stopped (starts when needed)'}</span></div>
      <dl class="facts">
        <dt>Games open</dt><dd>${f.host.games.length ? esc(f.host.games.join(', ')) : 'none'}</dd>
        <dt>Memory</dt><dd>${m ? `${num(m.totalMb)} MB` : '—'}</dd>
        <dt>Restarts</dt><dd>${num(f.host.restarts)}</dd>
      </dl>
      ${m && m.procs && m.procs.length ? `<details style="margin-top:10px"><summary class="mute" style="cursor:pointer">Per process</summary><div class="log" style="max-height:160px;margin-top:8px">${esc(m.procs.map((p) => `${p.type.padEnd(14)} ${String(p.mb).padStart(5)} MB`).join('\n'))}</div></details>` : ''}
    </section>
    <section class="panel span">
      <h2>Characters, in order</h2>
      <p class="mute" style="margin:-6px 0 12px">The first ${c.maxGames} on "Auto" go to Flash when the standby turns on. "Always Flash" uses it all the time; "Never Flash" keeps a character on the normal client.</p>
      <div class="list">${rows}</div>
    </section>
    <section class="panel span">
      <div class="row between" style="margin-bottom:12px"><h2 style="margin:0">Live view</h2><button class="sm" data-flashreload>Refresh</button></div>
      ${shots}
    </section>
    <section class="panel span">
      <h2>History</h2>
      <div class="log" style="max-height:220px">${esc((f.history || []).map((h) => `${new Date(h.at).toLocaleString()}  ${h.text}`).join('\n')) || 'Nothing yet.'}</div>
    </section>
  </div>`;
}
async function flashSet(patch, label) { await act(label, () => api('/flash/settings', patch)); await loadFlash(); }
document.addEventListener('change', async (e) => {
  const d = e.target.dataset || {};
  if (d.flashmode) return flashSet({ modes: { [d.flashmode]: e.target.value } }, `${d.flashmode}: ${e.target.selectedOptions[0].textContent}`);
  if (d.flashflag) return flashSet({ [d.flashflag]: e.target.checked }, `${({ auto: 'Automatic', separate: 'One process per character', hidden: 'Games not drawn', enabled: 'Flash standby' })[d.flashflag] || d.flashflag}: ${e.target.checked ? 'on' : 'off'}`);
  if (d.flashmax !== undefined) return flashSet({ maxGames: Number(e.target.value) }, `Characters in Flash at once: ${e.target.value}`);
  if (d.flashsize !== undefined) return flashSet({ size: e.target.value }, `Game window: ${e.target.selectedOptions[0].textContent}`);
});
document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-flashstandby],[data-flashmove],[data-flashsave],[data-flashreload]');
  if (!el) return;
  const d = el.dataset;
  if (d.flashstandby) {
    if (d.flashstandby === 'on' && !(await confirmBox('Move the first characters on "Auto" to the real game now?', 'Turn on'))) return;
    await act(d.flashstandby === 'on' ? 'Flash standby on' : 'Flash standby off', () => api('/flash/standby', { on: d.flashstandby === 'on' }));
    return loadFlash();
  }
  if (d.flashmove && flashData && flashData.cfg) {
    const c = flashData.cfg;
    const order = [...c.order.filter((id) => flashData.accounts.some((a) => a.id === id)), ...flashData.accounts.filter((a) => !c.order.includes(a.id)).map((a) => a.id)];
    const i = order.indexOf(d.flashmove);
    const j = i + Number(d.dir);
    if (i < 0 || j < 0 || j >= order.length) return;
    [order[i], order[j]] = [order[j], order[i]];
    return flashSet({ order }, 'Order saved');
  }
  if (d.flashsave !== undefined) {
    const patch = {};
    document.querySelectorAll('[data-flashnum]').forEach((x) => { patch[x.dataset.flashnum] = Number(x.value); });
    return flashSet(patch, 'Flash settings saved');
  }
  if (d.flashreload !== undefined) return loadFlash();
});
setInterval(() => { if (!document.hidden && view === 'flash') loadFlash(); }, 10000);

// ---------------- Ultra raids: the Raid Planner (2026-10-24) ----------------
// The owner: "vibeskua lets you decide which characters take which role and how they act and what potions do they use it
// literally makes you take control over the bots". Pick a boss and the four: each seat gets a character, one of its
// rank-10 classes, the role it plays (bosses with Comps; at the others the class decides the role), potions on/off and
// which ones, and the scroll. Start sends the four in on the laptop (POST /raid/plan); Stop calls the raid off (never a
// lost try). The live panel shows the fight while it runs.
let planner = null;          // GET /raid/planner
let plannerAt = 0;
let rp = null;               // the line-up being edited: { boss, seats: [{ id, cls, role, potions, potionList, scroll }] }
const SCROLLS = [['', 'none'], ['Scroll of Enrage', 'Scroll of Enrage'], ['Scroll of Decay', 'Scroll of Decay']];
async function loadPlanner(force = false) {
  if (!force && Date.now() - plannerAt < 4000) return;
  plannerAt = Date.now();
  try { planner = await api('/raid/planner'); } catch (e) { planner = { error: e.message }; }
  if (planner && planner.bosses && (!rp || !planner.bosses.some((b) => b.id === rp.boss))) {
    const want = localStorage.getItem('rpBoss');
    rpPick(planner.bosses.some((b) => b.id === want) ? want : (planner.bosses.find((b) => b.id === 'ultra-speaker') || planner.bosses[0]).id);
  }
  drawRoster();
  if (view === 'raids') draw(force);
}
function raidRailText() {
  const r = planner && planner.raid;
  return r ? `${r.name} · ${dur(Date.now() - r.started)}` : 'pick the four, roles, potions';
}
const rpBoss = () => planner && planner.bosses && planner.bosses.find((b) => b.id === (rp && rp.boss));
const rpMember = (id) => (planner && planner.members.find((m) => m.id === id)) || null;
const lc = (s) => String(s || '').toLowerCase();
const rpRoleInfo = (boss, role) => (boss && boss.plan && boss.plan.kind === 'comp' ? boss.plan.roles.find((r) => r.role === role) : null);
const rpSlotFor = (boss, cls) => (boss && boss.plan && boss.plan.kind === 'slots' ? boss.plan.slots.find((s) => s.classes.some((c) => lc(c) === lc(cls))) : null);
// Who plays this class: party bots first, the owner's main last (he fills what the bots lack), nobody twice.
function rpWho(cls, taken) {
  const can = (planner.members || []).filter((m) => !taken.includes(m.id) && (m.classes || []).some((c) => lc(c) === lc(cls)));
  can.sort((a, b) => (a.guest - b.guest) || ((b.online && b.running) - (a.online && a.running)));
  return can[0] ? can[0].id : '';
}
function rpFromComp(boss, name) {
  const comp = boss.plan.comps.find((c) => c.name === name) || boss.plan.comps[0];
  const taken = [];
  return comp.entries.map((e) => {
    const id = rpWho(e.class, taken);
    if (id) taken.push(id);
    return { id, cls: e.class, role: e.role, potions: e.potions.length > 0, potionList: e.potions.slice(), scroll: e.scroll || '' };
  });
}
function rpFromSlots(boss) {
  const taken = [];
  return boss.plan.slots.map((sl) => {
    for (const cls of sl.classes) { const id = rpWho(cls, taken); if (id) { taken.push(id); return { id, cls, role: sl.role, potions: false, potionList: [], scroll: '' }; } }
    return { id: '', cls: sl.classes[0] || '', role: sl.role, potions: false, potionList: [], scroll: '' };
  });
}
// A proven recipe's seats (lib/recipes.js) as editor seats.
function rpFromRecipe(boss, rec) {
  return rec.seats.map((w) => {
    const role = boss.plan.kind === 'slots' ? ((rpSlotFor(boss, w.cls) || {}).role || w.role) : w.role;
    const ri = rpRoleInfo(boss, role);
    return { id: w.id, cls: w.cls, role, potions: !!w.potions, potionList: (w.potionList || (ri ? ri.potions : [])).slice(), scroll: w.scroll != null ? w.scroll : ri ? ri.scroll || '' : '' };
  });
}
// A boss's line-up: its proven recipe (what won and keeps winning), else the one last started from here, else the last
// line-up that killed it, else a Seraph Comp, else the script's.
function rpPick(bossId) {
  const boss = planner.bosses.find((b) => b.id === bossId);
  if (!boss || !boss.plan) return;
  localStorage.setItem('rpBoss', bossId);
  const proven = ((planner.recipes || {})[bossId] || {}).recipe;
  const saved = (planner.plans || {})[bossId];
  const won = (planner.wins || {})[bossId];
  let seats;
  if (proven) {
    seats = rpFromRecipe(boss, proven);
    rp = { boss: bossId, seats, src: 'the proven line-up' };
    return;
  }
  if (saved && saved.seats && saved.seats.length === 4) seats = saved.seats.map((s) => ({ ...s, potionList: (s.potionList || []).slice() }));
  else if (won) {
    seats = won.seats.map((w) => {
      const role = boss.plan.kind === 'slots' ? ((rpSlotFor(boss, w.cls) || {}).role || w.role) : w.role;
      const ri = rpRoleInfo(boss, role);
      return { id: w.id, cls: w.cls, role, potions: !!(ri && ri.potions.length), potionList: ri ? ri.potions.slice() : [], scroll: ri ? ri.scroll || '' : '' };
    });
  } else if (boss.plan.kind === 'comp') seats = rpFromComp(boss, (boss.plan.comps.find((c) => /^seraph-/.test(c.name)) || boss.plan.comps[0]).name);
  else seats = rpFromSlots(boss);
  const src = saved && saved.seats && saved.seats.length === 4 ? `your line-up from ${new Date(saved.at).toLocaleString()}`
    : won ? `the line-up that killed it on ${new Date(won.at).toLocaleString()}` : 'the script’s own line-up';
  rp = { boss: bossId, seats, src };
}
function rpWarn(boss, s) {
  const m = rpMember(s.id);
  if (!m) return 'Pick a character.';
  if (m.standAside) return `You are playing ${m.label} yourself.`;
  if (!m.online || !m.running) return `${m.label} is not logged in and running.`;
  if (m.paused) return `${m.label} is paused.`;
  if (m.classes && !m.classes.some((c) => lc(c) === lc(s.cls))) return `${m.label} has no rank-10 ${s.cls}.`;
  if (boss.plan.kind === 'slots' && !rpSlotFor(boss, s.cls)) return `${s.cls} has no seat at ${boss.name}.`;
  const dupe = rp.seats.filter((x) => x.id && x.id === s.id).length > 1 ? `${m.label} sits twice.` : rp.seats.filter((x) => lc(x.cls) === lc(s.cls)).length > 1 ? `Two seats play ${s.cls}.` : '';
  return dupe;
}
function rpSeatHtml(boss, s, i) {
  const m = rpMember(s.id);
  const who = `<select data-rp="id" data-i="${i}"><option value="">— nobody —</option>${planner.members.map((x) => `<option value="${esc(x.id)}"${x.id === s.id ? ' selected' : ''}>${esc(x.label)}${x.guest ? ' (you)' : ''}${x.standAside ? ' · you are on it' : !x.online || !x.running ? ' · offline' : x.paused ? ' · paused' : ''}</option>`).join('')}</select>`;
  const owned = (m && m.classes) || [];
  const fitsHere = (c) => boss.plan.kind !== 'slots' || !!rpSlotFor(boss, c);
  const opts = [...owned];
  if (s.cls && !opts.some((c) => lc(c) === lc(s.cls))) opts.unshift(s.cls);
  const cls = `<select data-rp="cls" data-i="${i}">${opts.map((c) => `<option value="${esc(c)}"${c === s.cls ? ' selected' : ''}>${esc(c)}${owned.some((o) => lc(o) === lc(c)) ? '' : ' (not owned)'}${fitsHere(c) ? '' : ' (no seat here)'}</option>`).join('')}${m && !m.classes ? '<option disabled>classes load when it is online</option>' : ''}</select>`;
  const role = boss.plan.kind === 'comp'
    ? `<select data-rp="role" data-i="${i}">${boss.plan.roles.map((r) => `<option value="${esc(r.role)}"${r.role === s.role ? ' selected' : ''} title="${esc(`the script plays it with ${r.classes.join(', ')}`)}">${esc(r.role)}</option>`).join('')}</select>`
    : `<span class="rp-fixed" title="At ${esc(boss.name)} the class decides the job">${esc((rpSlotFor(boss, s.cls) || {}).role || '—')}</span>`;
  const list = s.potionList || [];
  const pots = `<label class="check" style="margin:0 0 6px"><input type="checkbox" data-rp="potions" data-i="${i}"${s.potions ? ' checked' : ''}> drink</label>`
    + (boss.plan.kind === 'comp'
      ? [0, 1, 2].map((k) => `<input list="rpPotions" data-rp="pot" data-i="${i}" data-k="${k}" value="${esc(list[k] || '')}" placeholder="${k ? 'another potion' : 'potion'}"${s.potions ? '' : ' disabled'}>`).join('')
      : '<small class="mute">the script’s own potions for the class</small>');
  const scroll = boss.plan.kind === 'comp'
    ? `<select data-rp="scroll" data-i="${i}">${SCROLLS.map(([v, l]) => `<option value="${esc(v)}"${(s.scroll || '') === v ? ' selected' : ''}>${l}</option>`).join('')}</select>`
    : '<small class="mute">the script’s own</small>';
  const warn = rpWarn(boss, s);
  return `<div class="rp-seat rp-first">${who}</div><div class="rp-seat">${cls}</div><div class="rp-seat">${role}</div><div class="rp-seat rp-pots">${pots}</div><div class="rp-seat">${scroll}</div>${warn ? `<div class="rp-warn">${esc(warn)}</div>` : ''}`;
}
// The boss's proven recipe (lib/recipes.js): the line-up that won, replayed by the autopilot every period from the
// frozen script; its record; the alternates that also won.
function rpProvenHtml(boss) {
  const e = (planner.recipes || {})[boss.id];
  const who = (id) => (botById(id) || rpMember(id) || {}).label || id;
  const seatsText = (r) => r.seats.map((s) => `${who(s.id)}: ${s.cls}${s.role ? ` as ${s.role}` : ''}${s.potions ? ' + potions' : ''}`).join(' · ');
  if (!e || !e.recipe) {
    return `<section class="panel span"><h2 style="margin:0 0 6px">Proven line-up</h2><p class="mute" style="margin:0">None yet. The first time ${esc(boss.name)} dies, the line-up that killed it (characters, classes, roles, comp, potions and the exact script) is saved and the autopilot replays it every ${boss.every === 'week' ? 'week' : 'day'}.</p></section>`;
  }
  const r = e.recipe;
  const busy = !!planner.raid;
  const record = `won ${r.wins || 1}x${r.losses ? `, lost ${r.losses}x (${r.lossesInRow || 0} in a row)` : ''} · first win ${esc(new Date(r.at).toLocaleString())}${r.lastWin && r.lastWin !== r.at ? ` · last win ${esc(new Date(r.lastWin).toLocaleString())}` : ''}`;
  const alts = (e.alternates || []).map((a) => `<div class="item"><div class="what"><b>${esc(seatsText(a))}</b><small>won ${a.wins || 1}x · ${esc(new Date(a.at).toLocaleString())}${a.comp ? ` · comp ${esc(a.comp)}` : ''}</small></div><button class="sm" data-rppromote="${esc(a.id)}">Make this the proven one</button></div>`).join('');
  return `<section class="panel span">
    <div class="row between"><h2 style="margin:0">Proven line-up ${e.stale ? '<span class="tag bad"><i class="dot"></i>stopped winning</span>' : '<span class="tag good"><i class="dot"></i>replayed by the autopilot</span>'}</h2>
      <div class="row tight"><button class="sm" data-rpload>Load into the editor</button><button class="go sm" data-rpproven${busy || e.stale ? ' disabled' : ''}>Run the proven line-up now</button></div></div>
    <p style="margin:10px 0 4px"><b>${esc(seatsText(r))}</b></p>
    <p class="mute" style="margin:0">${record}${r.comp ? ` · comp ${esc(r.comp)}` : ''} · ${r.seeded ? 'from a win before line-ups were saved: runs today’s script until its first win freezes it, and any other win replaces it' : r.script ? 'frozen script (the exact one that won)' : 'no frozen script'}</p>
    ${e.stale ? `<p style="margin:8px 0 0;color:var(--ember)">${esc(e.stale.why)}. The autopilot uses its own picks until a new win; you can run it anyway from the editor or promote an alternate.</p>` : ''}
    ${alts ? `<h2 style="margin:16px 0 8px">Other line-ups that won</h2><div class="list">${alts}</div>` : ''}
  </section>`;
}
function rpPlanHtml() {
  const boss = rpBoss();
  if (!boss || !rp) return '';
  const p = boss.plan;
  const done = planner.done && planner.done[boss.id];
  const bossSel = `<select data-rp="boss">${planner.bosses.map((b) => `<option value="${esc(b.id)}"${b.id === boss.id ? ' selected' : ''}>${esc(b.name)}${(planner.hold || []).includes(b.id) ? ' (off the autopilot)' : ''}</option>`).join('')}</select>`;
  const fill = p.kind === 'comp'
    ? `<select data-rp="comp"><option value="">Fill from a known comp…</option>${p.comps.map((c) => `<option value="${esc(c.name)}">${esc(c.name)} — ${esc(c.entries.map((e) => e.class).join(', '))}</option>`).join('')}</select>`
    : '<button data-rpfill>Fill from who owns the classes</button>';
  const known = ['Body Tonic', 'Fate Tonic', 'Sage Tonic', 'Unstable Divine Elixir', 'Potent Destruction Elixir', 'Potent Malevolence Elixir', 'Potent Honor or Malice Potion', 'Felicitous Philtre', 'Endurance Draught'];
  const potionNames = [...new Set(planner.bosses.flatMap((b) => (b.plan && b.plan.kind === 'comp' ? b.plan.roles.flatMap((r) => r.potions) : [])).concat(known))].sort();
  const busy = !!planner.raid;
  const blocked = rp.seats.map((s) => rpWarn(boss, s)).filter(Boolean);
  return `${rpProvenHtml(boss)}<section class="panel span">
    <div class="row between"><div><h2 style="margin:0">Line-up</h2>${rp.src ? `<small class="mute">Started from ${esc(rp.src)}</small>` : ''}</div><div class="row tight">${bossSel}${fill}</div></div>
    <p class="mute" style="margin:8px 0 14px">${p.kind === 'comp' ? 'Any class can take any role. The role decides what the character does in the fight (who taunts which line, who steps into zones, what it hits), from the script’s own code for that role.' : `${esc(boss.name)}’s script gives each class its own job, so you pick the classes and the role follows.`}${done ? ` <b>Already killed ${boss.every === 'week' ? 'this week' : 'today'}.</b>` : ''}</p>
    <datalist id="rpPotions">${potionNames.map((n) => `<option value="${esc(n)}">`).join('')}</datalist>
    <div class="rp-grid"><div class="rp-h">Character</div><div class="rp-h">Class</div><div class="rp-h">Role</div><div class="rp-h">Potions</div><div class="rp-h">Scroll</div>${rp.seats.map((s, i) => rpSeatHtml(boss, s, i)).join('')}</div>
    <div class="row" style="margin-top:16px"><button class="primary" data-rpstart${busy || blocked.length ? ' disabled' : ''}>Start this raid</button>
      <span class="mute">${busy ? 'A raid is running - stop it first.' : blocked.length ? 'Fix the seats marked above first.' : 'The four drop what they are doing and go in. A lost fight from here never counts as one of the autopilot’s tries.'}</span></div>
  </section>`;
}
function raidLiveHtml(r) {
  const samples = (r.fight && r.fight.samples) || [];
  const last = samples.length ? samples[samples.length - 1].hp : null;
  const att = (r.attempts || []).find((a) => a.bossMaxHp);
  const maxHp = att ? att.bossMaxHp : samples.length ? Math.max(...samples.map((s) => s.hp)) : null;
  const planSeat = (id) => (r.plan ? r.plan.seats.find((s) => s.id === id) : null);
  const seat = (id) => (r.seats || []).find((s) => s.id === id) || {};
  const rows = r.members.map((id) => {
    const a = botById(id) || { label: id };
    const ps = planSeat(id);
    const hp = a.hpMax > 1 ? pct(a.hp, a.hpMax) : null;
    const line = r.back[id] ? `back: ${r.back[id]}` : lastSkua(a) || (a.map ? `/${a.map} ${a.cell || ''}` : 'not in game');
    return `<div class="item" style="align-items:center"><div class="what"><b>${esc(a.label)}</b> <span class="mute">${esc(seat(id).cls || a.className || '')}${ps && ps.role ? ` · ${esc(ps.role)}` : ''}${ps && ps.potions ? ' · potions' : ''}</span><small>${esc(line)}</small></div>
      <div style="width:200px">${hp != null ? meter('HP', hp, `${num(a.hp)} / ${num(a.hpMax)}`, hp < 25 ? 'hurt' : hp < 60 ? 'low' : '') : ''}</div></div>`;
  }).join('');
  const kills = (r.attempts || []).filter((a) => a.outcome === 'kill').length;
  return `<section class="panel span">
    <div class="row between"><h2 style="margin:0">${esc(r.name)} · ${r.plan ? 'your line-up' : 'autopilot'}</h2>
      <div class="row tight"><span class="tag warn"><i class="dot"></i>${dur(Date.now() - r.started)}</span><button class="stop" data-rpstop>Stop the raid</button></div></div>
    <div style="margin:14px 0">${last != null ? meter('Boss', maxHp ? pct(last, maxHp) : 0, `${short(last)}${maxHp ? ` / ${short(maxHp)}` : ''}`, 'hurt') : '<p class="mute" style="margin:0">The boss hasn’t been hit yet (the party gathers, then pulls).</p>'}</div>
    <div class="list">${rows}</div>
    <p class="mute" style="margin:12px 0 0">Room ${esc(r.room || '?')} · potions ${r.potions ? 'on' : 'off'}${kills ? ` · ${kills} kill report(s)` : ''}</p>
  </section>`;
}
function raidLogHtml() {
  const log = planner.log || [];
  const name = (id) => { const b = planner.bosses.find((x) => x.id === id); return b ? b.name : id; };
  return `<section class="panel span"><h2>Recent raids</h2><div class="list">${log.length ? log.map((l) => `<div class="item"><div class="what"><b>${esc(name(l.boss))}</b> <span class="tag ${l.killed ? 'good' : l.killed === null ? '' : 'bad'}"><i class="dot"></i>${l.killed ? 'killed' : l.killed === null ? 'handed over' : 'no kill'}</span>
      <small>${esc(new Date(l.at).toLocaleString())} · ${l.minutes} min · ${esc(Object.entries(l.back || {}).map(([id, v]) => `${(botById(id) || {}).label || id}: ${v}`).join(', '))}</small></div></div>`).join('') : '<div class="empty">No raids yet.</div>'}</div></section>`;
}
function raidsHtml() {
  const head = `<div class="row between" style="margin-bottom:20px"><div><h1>Ultra raids</h1><div class="mute">Your line-up for an ultra: who sits where, which class, which role, which potions. The bots run it on the laptop.</div></div>
    <div class="row tight"><button data-rpreload>Refresh</button></div></div>`;
  if (!planner) return `${head}<div class="empty">Loading…</div>`;
  if (planner.error) return `${head}<div class="empty">${esc(planner.error)}</div>`;
  return `${head}<div class="panels">${planner.raid ? raidLiveHtml(planner.raid) : ''}${rpPlanHtml()}${raidLogHtml()}</div>`;
}
document.addEventListener('change', (e) => {
  const k = e.target.dataset && e.target.dataset.rp;
  if (!k || !rp || !planner) return;
  const boss = rpBoss();
  const s = rp.seats[Number(e.target.dataset.i)];
  const v = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
  if (k === 'boss') rpPick(v);
  else if (k === 'comp') { if (v) { rp.seats = rpFromComp(boss, v); rp.src = 'the ' + v + ' comp'; } }
  else if (k === 'id') {
    s.id = v;
    const m = rpMember(v);
    // A character without the seat's class takes one it owns that the role is played with, if any.
    if (m && m.classes && !m.classes.some((c) => lc(c) === lc(s.cls))) {
      const pool = boss.plan.kind === 'comp' ? (rpRoleInfo(boss, s.role) || { classes: [] }).classes : ((boss.plan.slots.find((x) => x.role === s.role) || { classes: [] }).classes);
      const fit = pool.find((c) => m.classes.some((o) => lc(o) === lc(c)));
      if (fit) s.cls = fit;
    }
  } else if (k === 'cls') { s.cls = v; const sl = rpSlotFor(boss, v); if (sl) s.role = sl.role; }
  else if (k === 'role') { s.role = v; const ri = rpRoleInfo(boss, v); if (ri) { s.potionList = ri.potions.slice(); s.potions = ri.potions.length > 0; s.scroll = ri.scroll || ''; } }
  else if (k === 'potions') s.potions = v;
  else if (k === 'pot') { const list = (s.potionList || []).slice(); list[Number(e.target.dataset.k)] = String(v).trim(); s.potionList = list.map((x) => x || ''); }
  else if (k === 'scroll') s.scroll = v;
  draw(true);
});
document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-rpstart],[data-rpstop],[data-rpreload],[data-rpfill],[data-rpproven],[data-rpload],[data-rppromote]');
  if (!el || el.disabled) return;
  const d = el.dataset;
  if (d.rpreload !== undefined) return loadPlanner(true);
  if (d.rpload !== undefined) { const boss = rpBoss(); const e2 = (planner.recipes || {})[boss.id]; if (e2 && e2.recipe) { rp.seats = rpFromRecipe(boss, e2.recipe); rp.src = 'the proven line-up'; draw(true); } return; }
  if (d.rpproven !== undefined) {
    const boss = rpBoss();
    if (!(await confirmBox(`Run ${boss.name}'s proven line-up now (same characters, classes, roles, comp, potions and frozen script)?`, 'Run it'))) return;
    await act(`${boss.name}: the proven line-up is going in`, () => api('/raid/proven', { boss: boss.id }));
    return loadPlanner(true);
  }
  if (d.rppromote) {
    const boss = rpBoss();
    if (!(await confirmBox('Make this line-up the proven one? The autopilot replays it from the next raid on; the current one stays as an alternate.', 'Make it proven'))) return;
    await act('Proven line-up changed', () => api('/raid/recipe/promote', { boss: boss.id, id: d.rppromote }));
    return loadPlanner(true);
  }
  if (d.rpfill !== undefined) { rp.seats = rpFromSlots(rpBoss()); draw(true); return; }
  if (d.rpstop !== undefined) {
    if (!(await confirmBox('Stop the raid? Everyone goes back to their own work. It does not count as a lost try.', 'Stop the raid'))) return;
    await act('Raid stopped', () => api('/raid/stop', {}));
    return loadPlanner(true);
  }
  if (d.rpstart !== undefined) {
    const boss = rpBoss();
    const seats = rp.seats.map((s) => ({ ...s, potionList: (s.potionList || []).map((x) => String(x || '').trim()).filter(Boolean) }));
    const text = seats.map((s) => `${(rpMember(s.id) || {}).label || '?'}: ${s.cls}${boss.plan.kind === 'comp' ? ` as ${s.role}` : ''}${s.potions ? ' + potions' : ''}`).join(' · ');
    if (!(await confirmBox(`Start ${boss.name} now? ${text}`, 'Start'))) return;
    await act(`${boss.name}: the four are going in`, () => api('/raid/plan', { boss: boss.id, seats }));
    return loadPlanner(true);
  }
});
// Every 5 s on this page; elsewhere every 30 s, so the rail shows a raid that started.
setInterval(() => { if (!document.hidden && (view === 'raids' || Date.now() - plannerAt > 30000)) loadPlanner(); }, 5000);
