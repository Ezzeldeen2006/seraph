// Keeps Seraph current: pulls the community Scripts + Skua source, regenerates knowledge when they change, watches the
// game version (and its event title), and fetches a newer Skua bridge (skua.swf) from the official release when one
// ships — verified against GitHub's SHA-256 before it's used.
const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { P } = require('./paths');
const { readJson, writeJson } = require('./util');
const knowledge = require('./knowledge');

const STATE = path.join(P.ROOT, 'updater.json');
const BRIDGE_VERSION = path.join(P.APP, 'skua-version.txt');

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => execFile(cmd, args, { windowsHide: true, timeout: 300000, ...opts }, (err, stdout, stderr) => resolve({ ok: !err, stdout: String(stdout), stderr: String(stderr), err })));
}

function get(url, { json = true, file = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'Seraph-AQW-client', Accept: json ? 'application/json' : '*/*' } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) { res.resume(); return resolve(get(res.headers.location, { json, file })); }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode} for ${url}`)); }
      if (file) { const out = fs.createWriteStream(file); res.pipe(out); out.on('finish', () => out.close(() => resolve(file))); out.on('error', reject); return null; }
      let body = ''; res.setEncoding('utf8'); res.on('data', (c) => { body += c; });
      res.on('end', () => { try { resolve(json ? JSON.parse(body) : body); } catch (e) { reject(e); } });
      return null;
    });
    req.on('error', reject);
    req.setTimeout(60000, () => req.destroy(new Error('timeout')));
  });
}

class Updater {
  constructor(log = () => {}) {
    this.log = log;
    this.state = readJson(STATE, {});
    this.running = false;
    if (this.state.game && this.state.game.clientVersion) require('./net/protocol').setClientVersion(this.state.game.clientVersion);
  }

  // The login version the game SWF expects (Game.as `public static var vParam:String = "4.372"`). In the SWF's string
  // pool the name is followed straight by its value ("vParam", len, "4.372", "ISWEB" ...). CWS = zlib; ZWS (LZMA) is
  // not read and keeps the last known version.
  static clientVersionOf(swf) {
    const sig = swf.slice(0, 3).toString('latin1');
    const body = sig === 'CWS' ? require('zlib').inflateSync(swf.slice(8)) : sig === 'FWS' ? swf.slice(8) : null;
    if (!body) return null;
    const m = /vParam[\s\S]([0-9]+\.[0-9]+)/.exec(body.toString('latin1'));
    return m ? m[1] : null;
  }
  save() { writeJson(STATE, this.state); }

  // What execFile can tell us when the command itself printed nothing.
  static why(err) {
    if (!err) return 'no output';
    if (err.killed) return `timed out after ${Math.round(300000 / 1000)}s`;
    return [err.code, err.signal, err.message].filter(Boolean).join(' ') || 'no output';
  }

  // One pull at a time, and only this one. The hub used to pull the library every 24 h and the updater every 6 h, both
  // timed from the service start, so 24 h later they ran in the same second: "incorrect old value provided" (09-25) and
  // "Cannot fast-forward to multiple branches" (09-26) - two fetches writing FETCH_HEAD at once. Now: fetch just this
  // branch, fast-forward to it, and (with `reset`, the Scripts clone, which nobody edits on these machines) fall back
  // to a hard reset when it cannot fast-forward.
  async pull(dir, label, { reset = false } = {}) {
    if (!fs.existsSync(path.join(dir, '.git'))) return { changed: false, error: 'not a git clone' };
    while (Updater.pulling) await Updater.pulling;
    let release;
    Updater.pulling = new Promise((r) => { release = r; });
    try {
      const before = await run('git', ['-C', dir, 'rev-parse', 'HEAD']);
      const branch = (await run('git', ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim() || 'HEAD';
      let res = await run('git', ['-C', dir, 'fetch', '--quiet', 'origin', branch]);
      if (res.ok) {
        res = await run('git', ['-C', dir, 'merge', '--ff-only', '--quiet', 'FETCH_HEAD']);
        if (!res.ok && reset) {
          this.log(`updater: ${label} could not fast-forward (${(res.stderr.trim() || Updater.why(res.err)).slice(0, 120)}) - resetting to origin/${branch}`);
          res = await run('git', ['-C', dir, 'reset', '--hard', '--quiet', 'FETCH_HEAD']);
        }
      }
      const after = await run('git', ['-C', dir, 'rev-parse', 'HEAD']);
      const changed = before.stdout.trim() !== after.stdout.trim();
      // `git pull Scripts failed:` with nothing after it (2026-09-20) said nothing at all: --quiet git writes its
      // errors to stderr, but a killed or timed-out run leaves stderr empty, so fall back to what execFile reports.
      if (!res.ok) this.log(`updater: git pull ${label} failed: ${(res.stderr.trim() || res.stdout.trim() || Updater.why(res.err)).slice(0, 200)}`);
      else if (changed) this.log(`updater: ${label} updated ${before.stdout.trim().slice(0, 7)} -> ${after.stdout.trim().slice(0, 7)}`);
      return { changed, ok: res.ok, head: after.stdout.trim() };
    } finally { Updater.pulling = null; release(); }
  }

  // The Skua library, pulled and everything that is built from it rebuilt (knowledge, Farmer Joe's steps, quest
  // order, Seraph's script fixes). The hub, the dashboard's "update the library" button and runAll all come here.
  async pullScripts() {
    return this.afterScripts(await this.pull(P.SCRIPTS, 'Scripts', { reset: true }));
  }

  // Skua Manager > Updates > Scripts > "Reset Scripts": delete the library and download it again - what Skua's devs ask
  // for when scripts act up after an update. For a git clone: fetch, hard reset to the branch, and remove everything git
  // does not track, Skua's compile cache (Cached-Scripts) included. Runs by itself when Skua publishes a release
  // (skuaReleaseWatch), and on request: POST /scripts/reset, Discord /resetscripts.
  async resetScripts(why = 'asked') {
    const dir = P.SCRIPTS;
    if (!fs.existsSync(path.join(dir, '.git'))) return { ok: false, error: 'not a git clone' };
    while (Updater.pulling) await Updater.pulling;
    let release;
    Updater.pulling = new Promise((r) => { release = r; });
    let r;
    try {
      const before = (await run('git', ['-C', dir, 'rev-parse', 'HEAD'])).stdout.trim();
      const branch = (await run('git', ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim() || 'Skua';
      let res = await run('git', ['-C', dir, 'fetch', '--quiet', 'origin', branch]);
      if (res.ok) res = await run('git', ['-C', dir, 'reset', '--hard', '--quiet', 'FETCH_HEAD']);
      if (res.ok) res = await run('git', ['-C', dir, 'clean', '-fdxq']);
      const head = (await run('git', ['-C', dir, 'rev-parse', 'HEAD'])).stdout.trim();
      if (res.ok) this.log(`updater: Scripts reset (${why}): ${before.slice(0, 7)} -> ${head.slice(0, 7)}, compile cache cleared`);
      else this.log(`updater: Scripts reset (${why}) failed: ${(res.stderr.trim() || Updater.why(res.err)).slice(0, 200)}`);
      this.state.scriptsReset = { at: new Date().toISOString(), why, ok: res.ok, head };
      this.save();
      r = { changed: true, ok: res.ok, head, reset: true };
    } finally { Updater.pulling = null; release(); }
    return this.afterScripts(r);
  }

  // A new Skua release (GitHub auqw/Skua): reset the library, as its release notes ask. The first look only records it.
  async skuaReleaseWatch(latest = () => get('https://api.github.com/repos/auqw/Skua/releases/latest')) {
    try {
      const rel = await latest();
      const tag = rel && rel.tag_name;
      if (!tag) return null;
      const seen = this.state.skuaReleaseSeen;
      this.state.skuaReleaseSeen = tag;
      this.save();
      if (seen && seen !== tag) {
        this.log(`updater: Skua ${tag} released (was ${seen}) - resetting the script library`);
        if (this.onSkuaRelease) { try { this.onSkuaRelease(tag, seen); } catch (e) { /* only a notice */ } }
        await this.resetScripts(`Skua ${tag} released`);
      }
      return tag;
    } catch (e) { this.log(`updater: Skua release check failed: ${e.message}`); return null; }
  }

  // Everything built from the library, rebuilt after it changed (knowledge, Farmer Joe's steps, quest order, fixes).
  afterScripts(r) {
    if (r.changed || !fs.existsSync(path.join(P.KNOWLEDGE, 'meta.json'))) {
      const k = knowledge.generate();
      this.log(`updater: knowledge regenerated ${JSON.stringify(k)}`);
      try { require('./farmerjoe').reload(); } catch (e) { /* keep the old order */ }
      require('./questorder').refresh((m) => this.log(m));
      require('./questindex').refresh((m) => this.log(m), () => knowledge.questsChanged());
    }
    if (r.changed && this.onScriptsChanged) { try { this.onScriptsChanged(r); } catch (e) { this.log(`updater: after the library update: ${e.message}`); } }
    return r;
  }

  async gameVersion() {
    try {
      const v = await get('https://game.aq.com/game/api/data/gameversion');
      if (this.state.game && this.state.game.sFile !== v.sFile) this.log(`updater: AQW client updated ${this.state.game.sFile} -> ${v.sFile}`);
      if (!this.state.game || this.state.game.sTitle !== v.sTitle) this.log(`updater: game title is now "${v.sTitle}"`);
      const known = this.state.game && this.state.game.sFile === v.sFile ? this.state.game.clientVersion : null;
      let clientVersion = known;
      if (!clientVersion) {
        try {
          const tmp = path.join(P.TMP, 'game.swf');
          await get(`https://game.aq.com/game/gamefiles/${v.sFile}`, { json: false, file: tmp });
          clientVersion = Updater.clientVersionOf(fs.readFileSync(tmp));
          const was = require('./net/protocol').clientVersion();
          if (clientVersion && clientVersion !== was) this.log(`updater: AQW client version is now ${clientVersion} (was ${was}) - logins use it from now on`);
          if (!clientVersion) this.log(`updater: could not read the client version from ${v.sFile} - keeping ${was}`);
        } catch (e) { this.log(`updater: could not fetch ${v.sFile}: ${e.message}`); }
      }
      if (clientVersion) require('./net/protocol').setClientVersion(clientVersion);
      // When the game file last changed (health.js names it when nobody can log in).
      const changedAt = this.state.game && this.state.game.sFile === v.sFile ? this.state.game.changedAt : (this.state.game ? new Date().toISOString() : null);
      this.state.game = { sFile: v.sFile, sTitle: v.sTitle, sVersion: v.sVersion, clientVersion, checked: new Date().toISOString(), changedAt };
    } catch (e) { this.log(`updater: game version check failed: ${e.message}`); }
    return this.state.game;
  }

  // Design Notes headlines: the brain uses them to spot events outside their usual month and free items.
  async news() {
    try {
      const html = await get('https://www.aq.com/gamedesignnotes/', { json: false });
      const titles = [...html.matchAll(/<h3>([^<]{4,160})/g)].map((m) => m[1].replace(/&amp;/g, '&').replace(/&#39;|&rsquo;/g, "'").trim());
      const fresh = titles.filter((t) => !(this.state.news || []).includes(t));
      if (fresh.length && this.state.news) this.log(`updater: new design notes: ${fresh.join(' | ')}`);
      this.freshNews = fresh;
      this.state.news = titles.slice(0, 20);
    } catch (e) { this.log(`updater: design notes check failed: ${e.message}`); }
    return this.state.news;
  }

  bridgeVersion() { try { return fs.readFileSync(BRIDGE_VERSION, 'utf8').trim(); } catch { return '1.4.4.4'; } }

  async skuaRelease({ apply = true } = {}) {
    let rel;
    try { rel = await get('https://api.github.com/repos/auqw/Skua/releases/latest'); } catch (e) { this.log(`updater: Skua release check failed: ${e.message}`); return null; }
    const tag = rel.tag_name;
    this.state.skua = { latest: tag, installed: this.bridgeVersion(), checked: new Date().toISOString() };
    if (tag === this.bridgeVersion() || !apply) return this.state.skua;
    const asset = (rel.assets || []).find((a) => /x64\.msi$/i.test(a.name));
    if (!asset || !asset.digest) { this.log(`updater: Skua ${tag} has no verifiable x64 MSI`); return this.state.skua; }
    try {
      const dir = path.join(process.env.SKUA_HOME || '', 'installer');
      fs.mkdirSync(dir, { recursive: true });
      const msi = path.join(dir, asset.name);
      await get(asset.browser_download_url, { json: false, file: msi });
      const sha = crypto.createHash('sha256').update(fs.readFileSync(msi)).digest('hex');
      if (`sha256:${sha}` !== asset.digest) { this.log(`updater: ${asset.name} checksum mismatch - not used`); return this.state.skua; }
      const out = path.join(P.TMP, `skua-${tag}`);
      const res = await run('msiexec.exe', ['/a', msi, '/qn', `TARGETDIR=${out}`]);
      const swf = path.join(out, 'PFiles64', 'Skua', 'skua.swf');
      if (!res.ok || !fs.existsSync(swf)) { this.log(`updater: could not extract skua.swf from ${asset.name}`); return this.state.skua; }
      fs.copyFileSync(path.join(P.APP, 'skua.swf'), path.join(P.APP, `skua-${this.bridgeVersion()}.swf.bak`));
      fs.copyFileSync(swf, path.join(P.APP, 'skua.swf'));
      fs.writeFileSync(BRIDGE_VERSION, tag);
      this.state.skua.installed = tag;
      this.state.skua.pendingRestart = true;
      this.log(`updater: installed Skua bridge ${tag} (verified) - restart clients to use it`);
    } catch (e) { this.log(`updater: Skua ${tag} update failed: ${e.message}`); }
    return this.state.skua;
  }

  async runAll() {
    if (this.running) return this.state;
    this.running = true;
    try {
      await this.pullScripts();
      await this.skuaReleaseWatch();
      // The Skua source and the Flash bridge (skua.swf, an MSI) only matter to the desktop client on Windows; the
      // headless server has neither (it tried msiexec and D:\ paths on Linux).
      if (process.platform === 'win32') await this.pull(P.SKUA_SRC, 'Skua source');
      await this.gameVersion();
      await this.news();
      if (process.platform === 'win32') await this.skuaRelease();
      this.state.lastRun = new Date().toISOString();
      this.save();
    } finally { this.running = false; }
    return this.state;
  }
}

Updater.pulling = null;   // the pull in progress, whoever asked for it (one at a time per process)

module.exports = { Updater, get };
