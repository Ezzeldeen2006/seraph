// Read-only lookup tools for the Overseer chat: the model calls these instead of guessing.
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { P } = require('./paths');
const { readJson } = require('./util');
const { ask } = require('./ask');

function vaultFiles(dir = P.VAULT, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') || e.name === 'auto') continue;
    const f = path.join(dir, e.name);
    if (e.isDirectory()) vaultFiles(f, out); else if (e.name.endsWith('.md')) out.push(f);
  }
  return out;
}

const STOPWORDS = new Set("the and for with that this what which who how why where when are was were you your our they them their can could would should will does did done have has had get got make made from into about there here then than just only also some any all one two out not but its his her him she he we me my mine do to of in on at by as is be or an character characters working work doing way need want know tell show give".split(' '));
function searchNotes(query) {
  const words = String(query || '').toLowerCase().split(/[^a-z0-9']+/).filter((w) => w.length > 2 && !STOPWORDS.has(w));
  if (!words.length) return 'give me some keywords';
  const hits = [];
  for (const f of vaultFiles()) {
    const text = fs.readFileSync(f, 'utf8');
    const lower = text.toLowerCase();
    const score = words.reduce((t, w) => t + (lower.split(w).length - 1) + (path.basename(f).toLowerCase().includes(w) ? 5 : 0), 0);
    if (!score) continue;
    const i = Math.max(0, lower.indexOf(words.find((w) => lower.includes(w))) - 200);
    hits.push({ note: path.relative(P.VAULT, f).replace(/\\/g, '/').replace(/\.md$/, ''), score, snippet: text.slice(i, i + 500).replace(/\s+/g, ' ') });
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, 5);
}

function readNote(name) {
  const want = String(name || '').toLowerCase().replace(/\.md$/, '');
  const f = vaultFiles().find((x) => path.relative(P.VAULT, x).replace(/\\/g, '/').toLowerCase().replace(/\.md$/, '') === want)
    || vaultFiles().find((x) => path.basename(x, '.md').toLowerCase() === path.basename(want));
  return f ? fs.readFileSync(f, 'utf8').slice(0, 6000) : `no note called ${name}`;
}

let catalog = null;
function searchScripts(query) {
  if (!catalog) catalog = readJson(path.join(P.SCRIPTS, 'scripts.json'), []);
  const q = String(query || '').toLowerCase();
  const words = q.split(/\s+/).filter(Boolean);
  return (Array.isArray(catalog) ? catalog : [])
    .map((s) => ({ name: s.name || s.fileName, path: s.path || s.filePath, description: s.description || '' }))
    .filter((s) => words.every((w) => `${s.name} ${s.path} ${s.description}`.toLowerCase().includes(w)))
    .slice(0, 12);
}

function get(url, hops = 0) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { headers: { 'user-agent': 'Mozilla/5.0 (Seraph)' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && hops < 6) {
        res.resume();
        return resolve(get(new URL(res.headers.location, url).toString(), hops + 1));
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve(body));
    });
    req.setTimeout(20000, () => req.destroy(new Error('wiki timeout')));
    req.on('error', reject);
  });
}

// AQW Wiki page text. `page` can be a name ("Lord of Order") or a slug ("lord-of-order").
async function wiki(page) {
  const slug = String(page || '').trim().toLowerCase().replace(/'/g, '-').replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  if (!slug) return 'which page?';
  let html = await get(`http://aqwwiki.wikidot.com/${slug}`);
  let m = /id="page-content">([\s\S]*?)<div class="page-tags"/.exec(html);
  // Disambiguation page ("X usually refers to: X (0 AC), X (AC), X (Quest)"): follow the free / quest version.
  if (m && /usually refers to/i.test(m[1])) {
    const links = [...m[1].matchAll(/href="\/([a-z0-9-]+)"/g)].map((x) => x[1]).filter((l) => l.startsWith(slug));
    const pick = links.find((l) => /quest/.test(l)) || links.find((l) => /0-ac|class/.test(l)) || links[0];
    if (pick) { html = await get(`http://aqwwiki.wikidot.com/${pick}`); m = /id="page-content">([\s\S]*?)<div class="page-tags"/.exec(html); }
  }
  const text = (m ? m[1] : html).replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#039;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
  if (!text || /does not exist/i.test(text.slice(0, 300))) return `no wiki page "${slug}" (try a different name, or search_notes)`;
  return `${slug}: ${text.slice(0, 4000)}`;
}

function make(hub) {
  let coreTools = {};
  try { coreTools = require(require('path').join(process.env.SERAPH_AI_CORE || 'seraph-ai-core', 'tools')).make({ web: true, files: false }); } catch (e) { coreTools = {}; }
  return {
    ...coreTools,
    search_notes: { description: 'Search the Obsidian AQW vault (Seraph manual, strategy, classes, ultras, party notes). Returns note names + snippets.', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }, run: (a) => searchNotes(a.query) },
    read_note: { description: 'Read one vault note by name, e.g. "PARTY/Gear-and-Boosts" or "Dashboard".', parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] }, run: (a) => readNote(a.name) },
    search_scripts: { description: 'Search the 1,700 Skua farming scripts by keywords. Returns name, path, description (paths can be queued as script tasks).', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }, run: (a) => searchScripts(a.query) },
    wiki: { description: 'Read an AQW Wiki page (items, classes, quests, maps, requirements). Use the item/class/quest name.', parameters: { type: 'object', properties: { page: { type: 'string' } }, required: ['page'] }, run: (a) => wiki(a.page) },
    ask_character: { description: 'Ask one character a factual question about itself: items it owns or dropped, quests/dailies done, where it is, level, gold, classes, deaths.', parameters: { type: 'object', properties: { bot: { type: 'string', description: 'account id, e.g. nova7' }, question: { type: 'string' } }, required: ['bot', 'question'] }, run: async (a) => { const bot = hub.bot(a.bot); if (!bot) return `no character ${a.bot}`; return (await ask(bot, a.question, { brain: hub.brain, persona: bot.persona })).answer; } },
  };
}

module.exports = { make, searchNotes, readNote, searchScripts, wiki };

// Retrieval done by code before the model answers (small local models rarely call tools on their own):
// matching progression goals (+ who has them on their path), vault note snippets, and the AQW Wiki page of the
// best-matching goal or quoted/capitalised name in the question.
async function retrieve(question) {
  const progression = require('./progression');
  const personas = require('./personas');
  const { match } = require('./ask');
  const q = String(question || '');
  const parts = [];
  const labels = Object.entries(progression.GOALS).map(([id, g]) => ({ id, ...g }));
  const nq = ` ${q.toLowerCase().replace(/[^a-z0-9']+/g, ' ')} `;
  const goals = labels.filter((g) => {
    const name = g.label.toLowerCase().replace(/\s*\(.*\)$/, '').replace(/[^a-z0-9']+/g, ' ').trim();
    return nq.includes(` ${name} `) || nq.includes(` ${g.id.replace(/-/g, ' ')} `);
  }).slice(0, 3);
  if (!goals.length) for (const h of match(q, labels.map((g) => g.label)).slice(0, 2)) if (h.score >= 60) goals.push(labels.find((g) => g.label === h.name));
  for (const g of goals) {
    const who = Object.values(personas.PERSONAS).filter((p) => p.path.includes(g.id)).map((p) => `${p.name} (${p.id})`);
    parts.push(`GOAL ${g.id}: ${g.label}, from level ${g.when}${g.must ? ', every character needs it eventually' : ''}${g.needsAc ? `, needs ${g.needsAc} AC` : ''}. Purpose: ${g.purpose}. Farmed by the Skua script ${g.script}. The owner does NOT need to queue it: Seraph's rule brain starts it by itself once a character reaches the level (specialty characters first, everyone else from level ${g.must ? 80 : 90}). On the specialty path of: ${who.join(', ') || 'nobody (everyone gets it at late game)'}.`);
  }
  const notes = searchNotes(q);
  if (Array.isArray(notes)) for (const n of notes.slice(0, 3)) parts.push(`NOTE ${n.note}: ${n.snippet}`);
  const quoted = /"([^"]{3,60})"/.exec(q) || /\b([A-Z][a-z']+(?:\s+(?:of|the|[A-Z][a-z']+))+)\b/.exec(q);
  const wikiName = goals[0] ? goals[0].label.replace(/\s*\(.*\)$/, '') : quoted ? quoted[1] : null;
  if (wikiName) {
    try { const w = await wiki(wikiName); if (!/^no wiki page/.test(w)) parts.push(`AQW WIKI ${w.slice(0, 2500)}`); } catch { /* offline */ }
  }
  return parts.join('\n\n');
}

module.exports.retrieve = retrieve;
