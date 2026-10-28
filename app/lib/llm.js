// Local AI backend: Ollama (portable, <ai>\Ollama) running an open model (default Qwen3 8B). The owner chose a local
// model on 2026-09-17 so no Claude plan is used. Seraph starts `ollama serve` itself if it isn't running, pulls the
// model on first use, and talks to it over http://127.0.0.1:11434.
// chat(): optional tool loop (the model calls our read-only lookup tools), then a final answer forced into a JSON schema.
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const HOME = process.env.SERAPH_OLLAMA_HOME || require('path').join(require('os').homedir(), 'Ollama');
const EXE = path.join(HOME, 'ollama.exe');
const MODELS = path.join(HOME, 'models');
const HOST = '127.0.0.1';
const PORT = 11434;

function request(method, route, body, timeoutMs = 300000) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = http.request({ host: HOST, port: PORT, path: route, method, headers: data ? { 'content-type': 'application/json', 'content-length': data.length } : {} }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        if (res.statusCode >= 400) {
          if (/runner process (has )?(terminated|no longer running)|exit status/i.test(buf)) markClosed('llama-server was closed');
          return reject(new Error(`ollama ${res.statusCode}: ${buf.slice(0, 300)}`));
        }
        try { resolve(JSON.parse(buf)); } catch { resolve(buf); }
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('the local model took too long')));
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

let server = null;
let stopping = false;
let wasUp = false;
// The owner closed Ollama / llama-server himself (Task Manager): don't start it again behind his back. Cleared only by an
// explicit request from him (a chat message, turning the AI Brain back on).
let closedByUser = null;
function markClosed(why) { if (!stopping && !closedByUser) closedByUser = { at: Date.now(), why }; }
function resume() { closedByUser = null; }
function paused() { return closedByUser; }

async function running() {
  try { await request('GET', '/api/version', null, 3000); wasUp = true; return true; } catch {
    if (wasUp && !server) markClosed('Ollama was closed');
    wasUp = false;
    return false;
  }
}

// Start `ollama serve` unless one is already listening. Not detached: detached Ollama has no console, so every
// llama-server it spawns (5-6 at each model load: GPU discovery + the runner) opened its own cmd window. windowsHide
// gives it a hidden console the runners inherit, and it ends with Seraph.
async function ensureServer(log = () => {}) {
  if (await running()) return true;
  if (closedByUser) throw new Error('the local AI is off because it was closed (Task Manager). Send the AI Brain a message or turn it on to start it again');
  if (!fs.existsSync(EXE)) throw new Error(`Ollama is not installed at ${EXE}`);
  if (!server) {
    fs.mkdirSync(MODELS, { recursive: true });
    stopping = false;
    server = spawn(EXE, ['serve'], {
      windowsHide: true, detached: false, stdio: 'ignore', cwd: HOME,
      env: { ...process.env, OLLAMA_MODELS: MODELS, OLLAMA_HOST: `${HOST}:${PORT}`, OLLAMA_KEEP_ALIVE: '15m', OLLAMA_NUM_PARALLEL: '1', OLLAMA_MAX_LOADED_MODELS: '1', OLLAMA_FLASH_ATTENTION: '1', OLLAMA_KV_CACHE_TYPE: 'q8_0' },
    });
    server.on('exit', () => {
      server = null; wasUp = false; markClosed('Ollama was closed');
      // Its model runner survives a killed Ollama with the model in memory: end it (keeper.py --cleanup, PC only).
      const keeper = path.join(process.env.SERAPH_ROOT || require('path').join(require('os').homedir(), 'seraph'), 'keeper.py');
      if (process.platform === 'win32' && fs.existsSync('D:/Pyhton/pythonw.exe') && fs.existsSync(keeper)) {
        require('child_process').execFile('D:/Pyhton/pythonw.exe', [keeper, '--cleanup'], { windowsHide: true }, () => {});
      }
    });
    log('starting local AI server (Ollama)');
  }
  for (let i = 0; i < 40; i++) { if (await running()) return true; await new Promise((r) => setTimeout(r, 500)); }
  throw new Error('Ollama did not start');
}

async function pick(preferred) {
  await ensureServer();
  const list = ((await request('GET', '/api/tags', null, 10000)).models || []).map((m) => m.name);
  for (const p of preferred) if (list.includes(p) || list.includes(`${p}:latest`)) return p;
  return list[0] || preferred[preferred.length - 1];
}

async function hasModel(model) {
  const tags = await request('GET', '/api/tags', null, 10000);
  return (tags.models || []).some((m) => m.name === model || m.name === `${model}:latest` || m.model === model);
}
async function ensureModel(model, log = () => {}) {
  await ensureServer(log);
  if (await hasModel(model)) return true;
  log(`downloading local model ${model} (one time, a few GB)`);
  await request('POST', '/api/pull', { model, stream: false }, 60 * 60000);
  return true;
}

// messages: [{role, content}]; tools: { name: { description, parameters, run(args) } }.
async function chat({ model, system, messages, schema = null, tools = null, maxRounds = 4, options = {}, log = () => {} }) {
  await ensureModel(model, log);
  const msgs = [{ role: 'system', content: system }, ...messages];
  const opts = { temperature: 0.3, num_ctx: 8192, ...options };
  const toolDefs = tools ? Object.entries(tools).map(([name, t]) => ({ type: 'function', function: { name, description: t.description, parameters: t.parameters } })) : null;
  const used = [];
  if (toolDefs) {
    for (let round = 0; round < maxRounds; round++) {
      const r = await request('POST', '/api/chat', { model, messages: msgs, tools: toolDefs, stream: false, think: false, options: opts });
      const m = r.message || {};
      const calls = m.tool_calls || [];
      if (!calls.length) break;
      msgs.push({ role: 'assistant', content: m.content || '', tool_calls: calls });
      for (const c of calls) {
        const name = c.function && c.function.name;
        const tool = tools[name];
        let out;
        try { out = tool ? await tool.run(c.function.arguments || {}) : `unknown tool ${name}`; } catch (e) { out = `tool error: ${e.message}`; }
        const text = typeof out === 'string' ? out : JSON.stringify(out);
        used.push({ tool: name, args: c.function.arguments });
        msgs.push({ role: 'tool', content: text.slice(0, 6000), tool_name: name });
      }
    }
  }
  const final = await request('POST', '/api/chat', { model, messages: msgs, stream: false, think: false, format: schema || undefined, options: opts });
  let content = (final.message && final.message.content) || '';
  if (content.indexOf('</think>') >= 0) content = content.slice(content.lastIndexOf('</think>') + 8).trim();   // thinking-variant leak
  let data = content;
  if (schema) {
    try { data = JSON.parse(content); } catch {
      const m = /\{[\s\S]*\}/.exec(content);
      data = m ? JSON.parse(m[0]) : null;
      if (!data) throw new Error(`the local model did not return JSON: ${content.slice(0, 200)}`);
    }
  }
  return { data, used, ms: Math.round((final.total_duration || 0) / 1e6), tokens: (final.prompt_eval_count || 0) + (final.eval_count || 0) };
}

// Kill Ollama with its model runner: a plain kill() left llama-server.exe running with the model in memory.
function stop() {
  if (!server) return;
  stopping = true;
  try { require('child_process').execFileSync('taskkill', ['/PID', String(server.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 5000 }); } catch { try { server.kill(); } catch { /* */ } }
  server = null;
}

module.exports = { chat, ensureServer, ensureModel, running, stop, request, pick, resume, paused, HOME, EXE };
