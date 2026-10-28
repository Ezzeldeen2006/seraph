// Account registry: <seraph>\accounts.json. Credentials stay in login files, never here.
// A login file holds one or more blocks ("[Name]" + Username/Password lines); the block whose Username matches the
// account is used. Accounts with status "pending" exist in the plan but not in AQW yet: they never log in.
const fs = require('fs');
const path = require('path');
const { P } = require('./paths');
const { readJson, writeJson, slug } = require('./util');

const COLORS = ['#a78bfa', '#fbbf24', '#f43f5e', '#2dd4bf', '#38bdf8', '#34d399'];

function load() {
  const data = readJson(P.ACCOUNTS_FILE, null);
  if (data && Array.isArray(data.accounts)) return data;
  // First run of the multi-account client: migrate the single Sable7 setup.
  const seed = { accounts: [] };
  if (process.env.SERAPH_ACCOUNT_FILE && fs.existsSync(process.env.SERAPH_ACCOUNT_FILE)) {
    seed.accounts.push({
      id: 'sable7', label: 'Sable7', username: 'Sable7', owner: 'claude', loginFile: process.env.SERAPH_ACCOUNT_FILE,
      autostart: true, color: COLORS[0], persona: 'sable7', status: 'active', created: new Date().toISOString(),
    });
  }
  save(seed);
  migrateLegacy(seed);
  return seed;
}

function save(data) { writeJson(P.ACCOUNTS_FILE, data); }

// Move the single-account queue/journal into accounts\sable7 once.
function migrateLegacy(data) {
  const first = data.accounts[0];
  if (!first) return;
  const dir = P.account(first.id);
  fs.mkdirSync(dir, { recursive: true });
  for (const f of ['queue.json', 'journal.log']) {
    const src = path.join(P.ROOT, f);
    const dst = path.join(dir, f);
    if (fs.existsSync(src) && !fs.existsSync(dst)) fs.renameSync(src, dst);
  }
}

// Split a login file into blocks: { user, pass, email, status }.
function parseLoginFile(text) {
  const blocks = [];
  let cur = null;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    const m = /^(Username|Password|Email|Status):\s*(.*)$/i.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase();
    if (key === 'username') { cur = { user: m[2].trim() }; blocks.push(cur); continue; }
    if (!cur) { cur = {}; blocks.push(cur); }
    cur[key === 'password' ? 'pass' : key] = m[2].trim();
  }
  return blocks.filter((b) => b.user && b.pass);
}

function credentials(account) {
  const blocks = parseLoginFile(fs.readFileSync(account.loginFile, 'utf8'));
  const want = String(account.username || account.label || account.id).toLowerCase();
  const b = blocks.find((x) => x.user.toLowerCase() === want) || (blocks.length === 1 ? blocks[0] : null);
  if (!b) throw new Error(`login file ${account.loginFile} has no Username/Password block for ${want}`);
  return { user: b.user, pass: b.pass };
}

// Add an account: writes its login file inside accounts\<id>\login.txt (D:), registers it.
// kind: 'party' (a Seraph character with a persona and the brain) or 'guest' (one of the owner's own accounts: it only does
// the orders it is given and never joins the party's automation).
function add({ username, password, owner = 'claude', email = '', label, autostart = false, persona = null, status = 'active', loginFile = null, kind = 'party', online = false }) {
  if (!username || (!password && !loginFile)) throw new Error('username and password are required');
  const data = load();
  const id = slug(username);
  if (data.accounts.some((a) => a.id === id)) throw new Error(`account ${username} already exists`);
  const dir = P.account(id);
  fs.mkdirSync(dir, { recursive: true });
  if (!loginFile) {
    loginFile = path.join(dir, 'login.txt');
    fs.writeFileSync(loginFile, `AQW account (${owner})\nEmail:    ${email}\nUsername: ${username}\nPassword: ${password}\n`);
  }
  const acc = {
    id, label: label || username, username, owner, loginFile, autostart, persona, status, kind, online,
    color: COLORS[data.accounts.length % COLORS.length], created: new Date().toISOString(),
  };
  data.accounts.push(acc);
  save(data);
  return acc;
}

function update(id, patch) {
  const data = load();
  const acc = data.accounts.find((a) => a.id === id);
  if (!acc) throw new Error(`no account ${id}`);
  // standAsideUntil: the owner is playing this character himself, so it must stay logged out across a restart too.
  for (const k of ['label', 'owner', 'autostart', 'color', 'role', 'persona', 'status', 'kind', 'online', 'standAsideUntil', 'seat']) if (k in patch) acc[k] = patch[k];
  save(data);
  return acc;
}

// The login file goes too when it is the account's own (accounts/<id>/login.txt): a removed account leaves no password.
function remove(id) {
  const data = load();
  const acc = data.accounts.find((a) => a.id === id);
  data.accounts = data.accounts.filter((a) => a.id !== id);
  save(data);
  if (acc && acc.loginFile && path.resolve(acc.loginFile).startsWith(path.resolve(P.account(id)))) { try { fs.unlinkSync(acc.loginFile); } catch (e) { /* already gone */ } }
}

module.exports = { load, save, add, update, remove, credentials, parseLoginFile, COLORS };
