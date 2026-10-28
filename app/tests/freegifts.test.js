// Free gifts (lib/freegifts.js), the owner 2026-10-05: claim the birthday free ACs once per version of the script.
const freegifts = require('../lib/freegifts');

test('freegifts: claimed once per script version while the event is live, retried twice on failure', async () => {
  const gifts = [{ id: 'free-ac', label: '500 ACs', event: 'AqwBirthday', script: 'x.cs', minLevel: 20, until: '2026-11-01' }];
  let v = 'aaa';
  const opts = (o = {}) => ({ level: 96, events: { AqwBirthday: true }, now: Date.parse('2026-10-09'), gifts, versionOf: () => v, ...o });
  const st = {};
  eq(freegifts.next(st, opts({ events: {} })), null, 'event not live');
  eq(freegifts.next(st, opts({ level: 19 })), null, 'under level 20');
  eq(freegifts.next(st, opts({ now: Date.parse('2026-11-02') })), null, 'quest gone rare');
  const t = freegifts.next(st, opts());
  eq([t.type, t.path, t.gift, t.giftV], ['script', 'x.cs', 'free-ac', 'aaa']);
  freegifts.ended(st, t, false);
  assert(freegifts.next(st, opts()), 'one failure: tried again');
  freegifts.ended(st, t, false);
  eq(freegifts.next(st, opts()), null, 'two failures: waits for a new version');
  v = 'bbb';                                   // Skua updated the yearly script for this year's quest
  const t2 = freegifts.next(st, opts());
  eq(t2.giftV, 'bbb', 'a new version is a new claim');
  freegifts.ended(st, t2, true);
  eq(freegifts.next(st, opts()), null, 'claimed');
});

test('freegifts: starts count (a claim cut short by a kick never ends) and stale versions never run', async () => {
  const gifts = [{ id: 'free-ac', label: '500 ACs', event: 'AqwBirthday', script: 'x.cs', minLevel: 20, until: '2026-11-01', stale: ['old'] }];
  let v = 'new';
  const opts = { level: 96, events: { AqwBirthday: true }, now: Date.parse('2026-10-09'), gifts, versionOf: () => v };
  const st = {};
  const t = freegifts.next(st, opts);
  freegifts.began(st, t); freegifts.began(st, t);
  eq(freegifts.next(st, opts), null, 'two starts without an ending: no third');
  v = 'old';
  eq(freegifts.next({}, opts), null, 'a stale version never runs');
});

test('freegifts: tries made under the gift level do not count (2026-10-21, the level-2 girls and Birthday Cake)', async () => {
  const gifts = [{ id: 'birthday-badge', label: 'badge', event: 'AqwBirthday', script: 'b.cs', minLevel: 20, until: '2026-11-15' }];
  const opts = { level: 20, events: { AqwBirthday: true }, now: Date.parse('2026-10-22'), gifts, versionOf: () => 'v1' };
  // What the girls' brain.json holds from before the gate: two starts at level 2, no level kept, never worked.
  const st = { gifts: { 'birthday-badge': { v: 'v1', tries: 1, starts: 2 } } };
  const t = freegifts.next(st, opts);
  assert(t && t.giftFresh, 'the old failed tries are void at level 20');
  freegifts.began(st, t);
  eq([st.gifts['birthday-badge'].starts, st.gifts['birthday-badge'].lvl], [1, 20], 'a fresh count');
  freegifts.ended(st, t, false);
  assert(freegifts.next(st, opts), 'one real failure: tried again');
  freegifts.ended(st, freegifts.next(st, opts), false);
  eq(freegifts.next(st, opts), null, 'two real failures: done for this version');
  // A claim that worked before levels were kept stays done (the veterans' records).
  eq(freegifts.next({ gifts: { 'birthday-badge': { v: 'v1', tries: 1, starts: 1, ok: true } } }, opts), null);
});
