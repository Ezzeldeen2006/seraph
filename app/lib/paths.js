// Every path Seraph uses. All data lives under SERAPH_ROOT (default ~/seraph).
const path = require('path');
const fs = require('fs');

const ROOT = process.env.SERAPH_ROOT || path.join(require('os').homedir(), 'seraph');

const P = {
  ROOT,
  APP: path.join(__dirname, '..'),
  PROFILE: path.join(ROOT, 'profile'),
  LOGS: path.join(ROOT, 'logs'),
  TMP: path.join(ROOT, 'tmp'),
  ACCOUNTS_FILE: path.join(ROOT, 'accounts.json'),
  ACCOUNTS_DIR: path.join(ROOT, 'accounts'),
  KNOWLEDGE: path.join(ROOT, 'knowledge'),
  SCRIPTS: process.env.SERAPH_SCRIPTS || path.join(ROOT, 'Scripts'),
  SKUA_SRC: process.env.SKUA_SRC || path.join(ROOT, 'skua-src'),
  VAULT: process.env.SERAPH_VAULT || path.join(ROOT, 'vault'),
  PORT: Number(process.env.SERAPH_PORT || 47101),
  account(id) { return path.join(this.ACCOUNTS_DIR, id); },
};

function ensureDirs() {
  for (const d of [P.PROFILE, P.LOGS, P.TMP, P.ACCOUNTS_DIR, P.KNOWLEDGE]) fs.mkdirSync(d, { recursive: true });
}

module.exports = { P, ensureDirs };
