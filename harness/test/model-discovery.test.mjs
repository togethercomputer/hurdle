import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { discoverModels, selectCatalogModels, ModelDiscoveryError } from '../lib/model-discovery.mjs';
import { createFrameworkCli, main } from '../bin/hurdle.mjs';
const key = 'private-catalog-key';
const json = value => new Response(JSON.stringify(value));
const anthropic = id => ({ id, display_name: id.toUpperCase(), capabilities: { effort: { supported: true, medium: { supported: true }, high: { supported: false } } } });
function fixture(t) {
 const root = mkdtempSync(join(tmpdir(), 'hurdle-model-discovery-test-'));
 t.after(() => rmSync(root, { recursive: true, force: true }));
 let stdout = '', stderr = '';
 return { root, io: { cwd: root, stdout: { write: value => { stdout += value; } }, stderr: { write: value => { stderr += value; } } }, output: () => stdout, error: () => stderr };
}
function codex(t, { mode = 'normal' } = {}) {
 const f = fixture(t), script = join(f.root, 'codex.cjs'), marker = join(f.root, 'marker.json');
 let processInfo;
 writeFileSync(script, `const fs=require('node:fs');
 const readline=require('node:readline');
 fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify({pid:process.pid,home:fs.realpathSync(process.env.HOME),cwd:process.cwd(),keys:Object.keys(process.env),keyPresent:!!process.env.CODEX_API_KEY}));
 ${mode === 'stubborn' ? 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000);' : ''}
 readline.createInterface({input:process.stdin}).on('line',line=>{
  const r=JSON.parse(line);
  if(!['initialize','initialized','model/list'].includes(r.method))throw Error('inference forbidden');
  if(r.method==='initialized')return;
  if(r.method==='initialize'){process.stdout.write(JSON.stringify({id:r.id,result:{}})+'\\n');return;}
  ${mode === 'stubborn' ? 'return;' : mode === 'error' ? "process.stdout.write(JSON.stringify({id:r.id,error:{message:'private-catalog-key'}})+'\\n');return;" : mode === 'overflow' ? "process.stdout.write('x'.repeat(3*1024*1024));return;" : ''}
  const first=!r.params.cursor;
  process.stdout.write(JSON.stringify({id:r.id,result:{data:first?[{id:'old',model:'old',displayName:'Old',supportedReasoningEfforts:[{reasoningEffort:'medium'}],defaultReasoningEffort:'medium',isDefault:true},{model:'hidden',hidden:true}]:[{model:'future-2099',displayName:'Future'}],nextCursor:first?'next':null}})+'\\n');
 });`);
 return { ...f, marker, processInfo: () => processInfo, spawn(command, args, options) {
  assert.equal(command, 'codex'); assert.deepEqual(args, ['app-server']);
  const child = spawn(process.execPath, [script], options);
  processInfo = { pid: child.pid, home: options.env.HOME };
  return child;
 } };
}
test('Anthropic discovery pages current IDs without inference, redirects or secret output', async () => {
 const calls = [];
 const catalog = await discoverModels({ agent: 'claude-code', env: { ANTHROPIC_API_KEY: key } }, {
  fetch: async (url, options) => {
   calls.push(url); assert.equal(options.method, 'GET'); assert.equal(options.redirect, 'error');
   assert.equal(options.headers['x-api-key'], key); assert.equal(options.body, undefined);
   return calls.length === 1 ? json({ data: [anthropic('older-model')], has_more: true, last_id: 'older-model' }) : json({ data: [anthropic('released-tomorrow')], has_more: false });
  },
 });
 assert.equal(new URL(calls[1]).searchParams.get('after_id'), 'older-model');
 assert.deepEqual(catalog.models.map(m => m.id), ['older-model', 'released-tomorrow']);
 assert.deepEqual(catalog.models[0].reasoningEfforts, ['medium']);
 assert.equal(catalog.compatibility, 'provider-catalog'); assert.equal(catalog.accessVerified, false);
 assert.doesNotMatch(JSON.stringify(catalog), /private-catalog-key/);
});
test('Anthropic missing/rejected credentials, invalid catalogs and cycles stay safe', async () => {
 await assert.rejects(discoverModels({ agent: 'claude-code', env: { CLAUDE_CODE_OAUTH_TOKEN: key } }, { fetch() { assert.fail('no supported API key'); } }), { code: 'models.credentials-missing' });
 for (const status of [401, 403, 500]) {
  await assert.rejects(discoverModels({ agent: 'claude-code', env: { ANTHROPIC_API_KEY: key } }, { fetch: async () => new Response(key, { status }) }), error => !error.message.includes(key));
 }
 for (const body of [{ data: [anthropic(key)], has_more: false }, { data: [], has_more: true, last_id: 'repeat' }, { data: [], has_more: true }, { data: null, has_more: false }]) {
  await assert.rejects(discoverModels({ agent: 'claude-code', env: { ANTHROPIC_API_KEY: key } }, { fetch: async () => json(body) }), { code: 'models.invalid-catalog' });
 }
});
test('provider response size and timeout are bounded', async () => {
 await assert.rejects(discoverModels({ agent: 'claude-code', env: { ANTHROPIC_API_KEY: key } }, { fetch: async () => new Response('x'.repeat(3 * 1024 * 1024)) }), { code: 'models.invalid-catalog' });
 await assert.rejects(discoverModels({ agent: 'claude-code', env: { ANTHROPIC_API_KEY: key } }, { timeoutMs: 20, fetch: async (_, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(Error(key)), { once: true })) }), { code: 'models.timeout' });
 let bodyCancelled = false;
 await assert.rejects(discoverModels({ agent: 'claude-code', env: { ANTHROPIC_API_KEY: key } }, { timeoutMs: 20, fetch: async () => new Response(new ReadableStream({ cancel() { bodyCancelled = true; } })) }), { code: 'models.timeout' });
 assert.equal(bodyCancelled, true);
});
test('Codex discovers paginated native models, ignores hidden entries and removes its isolated HOME', async t => {
 const f = codex(t);
 const catalog = await discoverModels({ agent: 'codex', env: { PATH: process.env.PATH, UNRELATED_SECRET: 'never-forward', HOME: '/interactive', CODEX_HOME: '/interactive' } }, { spawn: f.spawn, fetch() { assert.fail('no API key selected'); } });
 assert.deepEqual(catalog.models.map(m => m.id), ['old', 'future-2099']);
 assert.equal(catalog.models[0].isDefault, true); assert.equal(catalog.models[0].defaultReasoningEffort, 'medium');
 const marker = JSON.parse(readFileSync(f.marker, 'utf8'));
 assert.equal(marker.home, marker.cwd); assert.notEqual(marker.home, '/interactive');
 assert.equal(marker.keys.includes('UNRELATED_SECRET'), false);
 assert.equal(existsSync(marker.home), false);
 assert.throws(() => process.kill(marker.pid, 0), { code: 'ESRCH' });
});
test('live OpenAI catalog adds new IDs and native compatibility metadata wins for existing IDs', async t => {
 const f = codex(t);
 const catalog = await discoverModels({ agent: 'codex', env: { CODEX_API_KEY: key, OPENAI_API_KEY: 'ignored-key' } }, { spawn: f.spawn, fetch: async (url, options) => {
  assert.equal(url, 'https://api.openai.com/v1/models'); assert.equal(options.headers.authorization, `Bearer ${key}`); assert.equal(options.method, 'GET');
  return json({ data: [{ id: 'old', created: 1700000000 }, { id: 'brand-new-id', created: 1800000000 }] });
 } });
 assert.equal(catalog.compatibility, 'mixed');
 assert.equal(catalog.models.find(m => m.id === 'old').compatibility, 'agent-catalog');
 assert.equal(catalog.models.find(m => m.id === 'old').createdAt, '2023-11-14T22:13:20.000Z');
 assert.equal(catalog.models.find(m => m.id === 'brand-new-id').compatibility, 'provider-catalog');
 assert.doesNotMatch(JSON.stringify(catalog), /private-catalog-key|ignored-key/);
});
test('catalog failures retain useful fallback choices and never change credential precedence', async t => {
 const failed = codex(t, { mode: 'error' });
 const provider = await discoverModels({ agent: 'codex', env: { OPENAI_API_KEY: key } }, { spawn: failed.spawn, fetch: async () => json({ data: [{ id: 'provider-id' }] }) });
 assert.equal(provider.compatibility, 'provider-catalog'); assert.equal(provider.warnings.length, 1);
 const f = codex(t);
 // A ChatGPT access token is ignored: the API key is used, and the token never reaches Codex.
 let queried = null;
 const native = await discoverModels({ agent: 'codex', env: { CODEX_ACCESS_TOKEN: 'chatgpt-token', OPENAI_API_KEY: key } }, { spawn: f.spawn, fetch: async (_url, options) => { queried = options.headers.authorization; return json({ data: [{ id: 'provider-id' }] }); } });
 assert.equal(queried, `Bearer ${key}`);
 assert.equal(JSON.parse(readFileSync(f.marker, 'utf8')).keys.includes('CODEX_ACCESS_TOKEN'), false);
 const fallback = await discoverModels({ agent: 'codex', env: { OPENAI_API_KEY: key } }, { spawn: f.spawn, fetch: async () => new Response(key, { status: 401 }) });
 assert.equal(fallback.compatibility, 'agent-catalog'); assert.equal(fallback.warnings.length, 1);
 assert.match(fallback.warnings[0], /OpenAI rejected the configured API key/);
 assert.doesNotMatch(JSON.stringify(fallback), /private-catalog-key/);
});
test('Codex protocol errors and oversized output never expose diagnostics', async t => {
 for (const mode of ['error', 'overflow']) {
  const f = codex(t, { mode });
  await assert.rejects(discoverModels({ agent: 'codex', env: {} }, { spawn: f.spawn }), error => error instanceof ModelDiscoveryError && !error.message.includes(key));
  const marker = JSON.parse(readFileSync(f.marker, 'utf8'));
  assert.equal(existsSync(marker.home), false);
 }
});
test('cancellation and deadlines terminate a stubborn Codex process before removing its HOME', async t => {
 for (const cancel of [false, true]) {
  const f = codex(t, { mode: 'stubborn' });
  const controller = new AbortController();
  const timer = cancel ? setTimeout(() => controller.abort(), 150) : null;
  try {
   await assert.rejects(discoverModels({ agent: 'codex', env: {}, signal: controller.signal }, { spawn: f.spawn, timeoutMs: cancel ? 5000 : 150 }), { code: cancel ? 'models.cancelled' : 'models.timeout' });
   const owned = f.processInfo();
   assert.equal(existsSync(owned.home), false);
   assert.throws(() => process.kill(owned.pid, 0), { code: 'ESRCH' });
  } finally { clearTimeout(timer); }
 }
});
test('models help/invalid arguments remain offline even with an unreadable environment file', async t => {
 const f = fixture(t); mkdirSync(join(f.root, '.env.local'));
 assert.equal(await main(['models', '--help'], f.io), 0); assert.match(f.output(), /upstream catalogs/);
 for (const args of [[], ['--json'], ['--agent', '--json'], ['--agent', 'other', '--json'], ['--agent', 'codex', '--agent', 'codex', '--json'], ['--agent', 'codex', '--json', '--json'], ['--agent', 'codex', '--all', '--all', '--json']]) {
  const g = fixture(t); mkdirSync(join(g.root, '.env.local'));
  assert.equal(await main(['models', ...args], g.io), 2);
  if (args.includes('--json')) { assert.equal(JSON.parse(g.output()).error.code, 'argument-error'); assert.equal(g.error(), ''); }
 }
 const g = fixture(t); mkdirSync(join(g.root, '.env.local'));
 assert.equal(await main(['models', '--agent', 'codex', '--json'], g.io), 1);
 assert.equal(JSON.parse(g.output()).error.code, 'models.environment-unavailable');
});
test('recent Codex choices sort upstream dates, omit non-code models and redundant snapshots, and leave --all intact', () => {
 const model = (id, createdAt, extra = {}) => ({ id, createdAt, compatibility: 'provider-catalog', lifecycle: null, ...extra });
 const catalog = { agent: 'codex', models: [
  model('gpt-5.5', '2026-04-23T00:00:00Z', { compatibility: 'agent-catalog', isDefault: true }),
  model('gpt-image-2099', '2099-01-01T00:00:00Z'),
  model('gpt-99-audio', '2099-01-01T00:00:00Z'),
  model('gpt-99-search-api', '2099-01-01T00:00:00Z'),
  model('o99-deep-research', '2099-01-01T00:00:00Z'),
  model('text-embedding-future', '2099-01-01T00:00:00Z'),
  model('ft:gpt-99:private', '2099-01-01T00:00:00Z'),
  model('gpt-6.1-sol-2026-09-28', '2026-09-28T00:00:00Z'),
  model('gpt-6.1-sol', '2026-09-27T00:00:00Z'),
  model('gpt-6-retired', '2026-10-01T00:00:00Z', { lifecycle: 'retired' }),
  model('unfamiliar-native-model', null, { compatibility: 'agent-catalog' }),
 ] };
 const original = JSON.stringify(catalog);
 assert.deepEqual(selectCatalogModels(catalog).models.map(m => m.id), ['gpt-6.1-sol', 'gpt-5.5', 'unfamiliar-native-model']);
 assert.deepEqual(selectCatalogModels(catalog, { all: true }), catalog);
 assert.equal(JSON.stringify(catalog), original);
});
test('both catalogs limit recent choices to 10; Anthropic dates and unknown native order remain usable', async () => {
 const entries = Array.from({ length: 14 }, (_, i) => ({ id: `claude-future-${i}`, display_name: 'Future', created_at: `2026-09-${String(i + 1).padStart(2, '0')}T00:00:00Z` }));
 const catalog = await discoverModels({ agent: 'claude-code', env: { ANTHROPIC_API_KEY: key } }, { fetch: async () => json({ data: entries, has_more: false }) });
 assert.deepEqual(selectCatalogModels(catalog).models.map(m => m.id), entries.slice(4).reverse().map(m => m.id));
 assert.equal(selectCatalogModels(catalog, { all: true }).models.length, 14);
 const undated = { agent: 'codex', models: Array.from({ length: 14 }, (_, i) => ({ id: `native-${i}`, compatibility: 'agent-catalog', createdAt: null })) };
 assert.deepEqual(selectCatalogModels(undated).models, undated.models.slice(0, 10));
 const unknown = await discoverModels({ agent: 'claude-code', env: { ANTHROPIC_API_KEY: key } }, { fetch: async () => json({ data: [{ ...anthropic('future'), created_at: key }], has_more: false }) });
 assert.equal(unknown.models[0].createdAt, null);
 assert.doesNotMatch(JSON.stringify(unknown), /private-catalog-key/);
});
test('models defaults and --all match in JSON and text, with a single compatibility note', async t => {
 const catalog = { agent: 'codex', source: 'fixture', warnings: [], models: Array.from({ length: 14 }, (_, i) => ({ id: `gpt-${i + 10}`, name: `GPT ${i + 10}`, compatibility: 'provider-catalog', createdAt: `2026-09-${String(i + 1).padStart(2, '0')}T00:00:00Z`, reasoningEfforts: null })) };
 const cli = createFrameworkCli({ env: {}, discoverModels: async () => catalog });
 for (const all of [false, true]) {
  const f = fixture(t);
  assert.equal(await cli.main(['models', '--agent', 'codex', ...(all ? ['--all'] : []), '--json'], f.io), 0);
  assert.deepEqual(JSON.parse(f.output()).models, selectCatalogModels(catalog, { all }).models);
 }
 const f = fixture(t);
 assert.equal(await cli.main(['models', '--agent', 'codex'], f.io), 0);
 assert.match(f.output(), /--all/);
 assert.equal((f.output().match(/compatibility is unverified/g) ?? []).length, 1);
 assert.doesNotMatch(f.output(), /effort unavailable|gpt-10\s/);
 assert.ok(f.output().indexOf('gpt-23') < f.output().indexOf('gpt-22'));
});
test('models emits one JSON result and sanitizes unclassified failures without loading a Suite', async t => {
 const f = fixture(t);
 const catalog = { agent: 'codex', source: 'fixture', compatibility: 'agent-catalog', accessVerified: false, warnings: [], models: [] };
 const forbidden = () => assert.fail('discovery must not load or run a Suite');
 const cli = createFrameworkCli({ env: {}, discoverModels: async () => catalog, resolveV1Suite: forbidden, checkAgentReadiness: forbidden, openLocalResultStore: forbidden });
 assert.equal(await cli.main(['models', '--agent', 'codex', '--json'], f.io), 0);
 assert.deepEqual(JSON.parse(f.output()), { schemaVersion: 1, command: 'models', ...catalog });
 const g = fixture(t);
 assert.equal(await createFrameworkCli({ discoverModels: async () => { throw Error(key); } }).main(['models', '--agent', 'codex', '--json'], g.io), 1);
 assert.equal(JSON.parse(g.output()).error.code, 'models.unavailable'); assert.doesNotMatch(g.output(), /private-catalog-key/);
});
test('models cancellation restores signal handlers and returns SIGINT exit status', async t => {
 const f = fixture(t), processTarget = new EventEmitter();
 const cli = createFrameworkCli({ processTarget, discoverModels: ({ signal }) => new Promise((_, reject) => {
  signal.addEventListener('abort', () => reject(new ModelDiscoveryError('models.cancelled', 'Cancelled.')), { once: true });
  queueMicrotask(() => processTarget.emit('SIGINT'));
 }) });
 assert.equal(await cli.main(['models', '--agent', 'codex', '--json'], f.io), 130);
 assert.equal(JSON.parse(f.output()).error.code, 'models.cancelled');
 assert.equal(processTarget.listenerCount('SIGINT'), 0); assert.equal(processTarget.listenerCount('SIGTERM'), 0);
});
