// AsyncLocalStorage, or a stand-in for the PC client: Electron 8 runs Node 12.13, which has async_hooks but not
// AsyncLocalStorage (12.17+), so lib/brain.js crashed Seraph at start on the PC (crash.log 2026-10-14). The laptop's
// Node 22 uses the real one. The stand-in carries the store from an async resource to the ones it creates.
'use strict';
const hooks = require('async_hooks');

class MiniAsyncLocalStorage {
  constructor() {
    const stores = this.stores = new Map();
    hooks.createHook({
      init(id, type, trigger) { if (stores.has(trigger)) stores.set(id, stores.get(trigger)); },
      destroy(id) { stores.delete(id); },
    }).enable();
  }
  getStore() { return this.stores.get(hooks.executionAsyncId()); }
  run(store, fn, ...args) {
    const id = hooks.executionAsyncId();
    const had = this.stores.has(id);
    const prev = this.stores.get(id);
    this.stores.set(id, store);
    try { return fn(...args); } finally { if (had) this.stores.set(id, prev); else this.stores.delete(id); }
  }
}

module.exports = hooks.AsyncLocalStorage || MiniAsyncLocalStorage;
module.exports.MiniAsyncLocalStorage = MiniAsyncLocalStorage;
