import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { TOOL_ANNOTATIONS, directoryMetaFor } from './tool-annotations.js';

const here = dirname(fileURLToPath(import.meta.url));
const serverSource = readFileSync(join(here, 'server.ts'), 'utf8');
const accessSource = readFileSync(join(here, 'security', 'tool-access.ts'), 'utf8');

// Tool names as registered in server.ts: server.registerTool(\n  'name',
const registered = [...serverSource.matchAll(/server\.registerTool\(\s*'([a-z0-9_]+)'/g)].map((m) => m[1]);

test('server.ts registers tools (sanity check on the parser)', () => {
  assert.ok(registered.length >= 50, `only found ${registered.length} tools`);
  assert.equal(new Set(registered).size, registered.length, 'duplicate tool registration');
});

test('every registered tool has a directory annotation entry', () => {
  const missing = registered.filter((name) => !(name in TOOL_ANNOTATIONS));
  assert.deepEqual(missing, []);
});

test('no stale annotation entries for tools that are not registered', () => {
  const stale = Object.keys(TOOL_ANNOTATIONS).filter((name) => !registered.includes(name));
  assert.deepEqual(stale, []);
});

test('every tool has a non-empty title and an openWorldHint', () => {
  for (const [name, entry] of Object.entries(TOOL_ANNOTATIONS)) {
    assert.ok(entry.title.trim().length > 0, `${name}: empty title`);
    assert.equal(typeof entry.openWorldHint, 'boolean', `${name}: openWorldHint`);
  }
});

test('every write tool declares destructiveHint and idempotentHint explicitly', () => {
  for (const [name, entry] of Object.entries(TOOL_ANNOTATIONS)) {
    if (entry.readOnlyHint) {
      assert.equal(entry.destructiveHint, undefined, `${name}: read-only tool must not set destructiveHint`);
      continue;
    }
    assert.equal(typeof entry.destructiveHint, 'boolean', `${name}: destructiveHint`);
    assert.equal(typeof entry.idempotentHint, 'boolean', `${name}: idempotentHint`);
  }
});

test('tools that overwrite data are marked destructive', () => {
  for (const name of ['add_note', 'tag_item', 'ingest_content', 'bulk_ingest', 'set_notion_api_key', 'connect_readwise']) {
    assert.equal(TOOL_ANNOTATIONS[name].destructiveHint, true, name);
  }
});

test('titles stay short and unique', () => {
  const titles = Object.values(TOOL_ANNOTATIONS).map((e) => e.title);
  assert.equal(new Set(titles).size, titles.length, 'duplicate title');
  for (const t of titles) assert.ok(t.length <= 40, `title too long: ${t}`);
});

test('tool names fit the 64-character directory limit', () => {
  for (const name of registered) assert.ok(name.length <= 64, name);
});

test('directoryMetaFor returns title at both levels', () => {
  const meta = directoryMetaFor('search_knowledge');
  if (!meta) throw new Error('missing meta');
  assert.equal(meta.title, 'Search Knowledge');
  assert.equal(meta.annotations.title, 'Search Knowledge');
  assert.equal(meta.annotations.readOnlyHint, true);
  assert.equal(directoryMetaFor('no_such_tool'), undefined);
});

test('every registered tool has an explicit access tier', () => {
  const missing = registered.filter((name) => !new RegExp(`\\n\\s+${name}:\\s+'`).test(accessSource));
  assert.deepEqual(missing, []);
});

test('search_obsidian (operator vault) is admin-only', () => {
  assert.match(accessSource, /\n\s+search_obsidian:\s+'admin'/);
});

test('every write tool available to regular users is in the authenticated tier', () => {
  for (const name of ['ingest_content', 'add_note', 'tag_item', 'toggle_bookmark', 'connect_readwise', 'sync_readwise']) {
    assert.match(accessSource, new RegExp(`\\n\\s+${name}:\\s+'authenticated'`), name);
  }
  assert.doesNotMatch(accessSource, /:\s+'premium',/, 'no tool should require the unused premium role');
});

test('tool descriptions do not instruct Claude how to behave', () => {
  const descriptions = [...serverSource.matchAll(/description: '([^']*)'/g)].map((m) => m[1]);
  for (const d of descriptions) {
    assert.doesNotMatch(d, /\bCall this\b|\brun backfill_embeddings first\b|Railway env|write_token/i, d.slice(0, 80));
  }
});

test('server.json and the server card report the package version', () => {
  const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')) as { version: string };
  const manifest = JSON.parse(readFileSync(join(here, '..', 'server.json'), 'utf8')) as { version: string };
  assert.equal(manifest.version, pkg.version);
  const card = readFileSync(join(here, 'routes', 'server-card.ts'), 'utf8');
  assert.doesNotMatch(card, /version:\s*'\d+\.\d+\.\d+'/);
});
