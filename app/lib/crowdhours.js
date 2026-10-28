// Crowd hours (overhaul Phase 5, 2026-09-29): how full each server is at every hour of the week (UTC), sampled every
// 10 min from the public server list. Crowd walls (Desolich) and the public-room dailies need players, and players come
// at busy hours: the report and the wall plans name the busiest ones. Advisory; nothing waits on it yet.
// ~/seraph/crowdhours.json: { hours: { "<dow>-<hh>": { "<server>": { n, sum, max } } } }
'use strict';
const path = require('path');
const { P } = require('./paths');
const { readJson, writeJson } = require('./util');

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const slot = (d) => `${d.getUTCDay()}-${String(d.getUTCHours()).padStart(2, '0')}`;

class CrowdHours {
  constructor(file = path.join(P.ROOT, 'crowdhours.json')) {
    this.file = file;
    this.data = readJson(file, null) || { v: 1, hours: {} };
    this.data.hours = this.data.hours || {};
  }

  // One sample: [{ sName, iCount, iMax, bOnline }] from protocol.servers().
  add(list, now = new Date()) {
    const h = this.data.hours[slot(now)] || (this.data.hours[slot(now)] = {});
    let n = 0;
    for (const s of list || []) {
      if (!s || !s.sName || !Number(s.bOnline)) continue;
      const c = Number(s.iCount) || 0;
      const r = h[s.sName] || (h[s.sName] = { n: 0, sum: 0, max: 0 });
      r.n++; r.sum += c; r.max = Math.max(r.max, c);
      n++;
    }
    this.data.lastAt = now.getTime();
    if (n) { try { writeJson(this.file, this.data); } catch (e) { /* next sample */ } }
    return n;
  }

  async sample(protocol = require('./net/protocol'), now = new Date()) {
    const list = await protocol.servers().catch(() => null);
    return list ? this.add(list, now) : 0;
  }

  // The busiest hours of the week on one server: [{ at: "Sat 18:00 UTC", avg, max, samples }].
  best(server, k = 3) {
    const out = [];
    for (const [key, h] of Object.entries(this.data.hours)) {
      const r = h[server];
      if (!r || r.n < 2) continue;
      const [dow, hh] = key.split('-');
      out.push({ at: `${DOW[Number(dow)]} ${hh}:00 UTC`, avg: Math.round(r.sum / r.n), max: r.max, samples: r.n });
    }
    return out.sort((a, b) => b.avg - a.avg).slice(0, k);
  }

  // The average at this hour of the week, or null before two samples.
  at(server, when = new Date()) {
    const r = (this.data.hours[slot(when)] || {})[server];
    return r && r.n >= 2 ? Math.round(r.sum / r.n) : null;
  }
}

module.exports = { CrowdHours, slot };
