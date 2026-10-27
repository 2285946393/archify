import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const script = resolve('scripts/pr-review-scan.mjs');
const SHA = 'a'.repeat(40);
const OTHER_SHA = 'b'.repeat(40);
const pull = (number = 1, extra = {}) => ({ number, state: 'open', title: `PR ${number}`,
  html_url: `https://github.com/owner/repo/pull/${number}`, body: 'Original body', draft: false,
  head: { sha: SHA }, base: { ref: 'dev', repo: { full_name: 'owner/repo' } },
  updated_at: '2026-10-27T00:00:00Z', ...extra });

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'pr-review-scan-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const response = join(root, 'response.json');
  const log = join(root, 'calls.jsonl');
  const state = join(root, 'state.json');
  writeFileSync(join(root, 'gh'), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.SCAN_LOG, JSON.stringify(args) + '\\n');
const config = JSON.parse(fs.readFileSync(process.env.SCAN_RESPONSE, 'utf8'));
if (config.fail) process.exit(1);
if (args[1].includes('/pulls?')) process.stdout.write(JSON.stringify(config.pages));
else process.stdout.write(JSON.stringify(config.ref || { ref: 'refs/heads/dev', object: { type: 'commit', sha: config.sha || '${SHA}' } }));
`, { mode: 0o755 });
  const configure = (value) => writeFileSync(response, JSON.stringify(value));
  const run = (command = 'scan', extra = [], repo = 'owner/repo') => spawnSync(process.execPath,
    [script, command, '--repo', repo, '--state', state, ...extra],
    { encoding: 'utf8', env: { ...process.env, PATH: `${root}:${process.env.PATH}`, SCAN_RESPONSE: response, SCAN_LOG: log } });
  const scan = () => { const result = run(); assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout); };
  const read = () => JSON.parse(readFileSync(state, 'utf8'));
  return { configure, run, scan, read, state, log };
}
// The fake executable uses POSIX executable/shebang semantics; live gh is smoke-tested separately.
const localTest = (name, fn) => test(name, { skip: process.platform === 'win32' ? 'POSIX fake gh executable' : false }, fn);

localTest('scan consumes all paginated pages, requests each target once, and remains quiet when unchanged', (t) => {
  const f = fixture(t);
  f.configure({ pages: [[pull(1)], [pull(2)]] });
  const first = f.scan();
  assert.equal(first.open, 2);
  assert.deepEqual(first.changes.map((entry) => entry.reasons), [['new'], ['new']]);
  const calls = readFileSync(f.log, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(calls[0], ['api', 'repos/owner/repo/pulls?state=open&per_page=100', '--paginate', '--slurp']);
  assert.equal(calls.length, 2);
  assert.equal(f.scan().changed, 0);
  assert.deepEqual(f.read().lastScan.evidence.pullPages, [[pull(1)], [pull(2)]]);
  assert.deepEqual(f.read().lastScan.evidence.baseRefs, { dev: { ref: 'refs/heads/dev', object: { type: 'commit', sha: SHA } } });
  assert.equal(Object.hasOwn(f.read().pulls[1], 'body'), false);
});

localTest('scan signals independent head, body, activity, draft and base movement without review claims', (t) => {
  const f = fixture(t);
  f.configure({ pages: [[pull()]] });
  f.scan();
  for (const [patch, expected] of [
    [{ head: { sha: OTHER_SHA } }, 'head'],
    [{ body: 'new requirement' }, 'body'],
    [{ updated_at: '2026-10-27T01:00:00Z' }, 'activity'],
    [{ draft: true }, 'draft'],
  ]) {
    f.configure({ pages: [[pull(1, patch)]] });
    assert.ok(f.scan().changes[0].reasons.includes(expected));
  }
  f.configure({ pages: [[pull()]], sha: OTHER_SHA });
  assert.ok(f.scan().changes[0].reasons.includes('target-base'));
  f.configure({ pages: [[pull(1, { base: { ref: 'release/v1', repo: { full_name: 'owner/repo' } } })]],
    ref: { ref: 'refs/heads/release/v1', object: { type: 'commit', sha: SHA } } });
  assert.ok(f.scan().changes[0].reasons.includes('base'));
  assert.match(readFileSync(f.log, 'utf8'), /release%2Fv1/);
  f.configure({ pages: [[pull(1, { head: { sha: 'c'.repeat(64) } })]], sha: 'd'.repeat(64) });
  assert.equal(f.scan().changes[0].head.length, 64);
  assert.equal(f.scan().changed, 0);
});

localTest('disappeared PR is no-longer-open and can reopen; no merge assumption', (t) => {
  const f = fixture(t);
  f.configure({ pages: [[pull()]] }); f.scan();
  f.configure({ pages: [[]] });
  assert.deepEqual(f.scan().changes[0].reasons, ['no-longer-open']);
  assert.equal(f.read().pulls[1].status, 'no-longer-open');
  assert.equal(f.scan().changed, 0);
  f.configure({ pages: [[pull()]] });
  assert.deepEqual(f.scan().changes[0].reasons, ['reopened']);
});

localTest('failed requests, malformed pages/pulls/refs and repo mismatch preserve exact previous bytes', (t) => {
  const f = fixture(t);
  f.configure({ pages: [[pull()]] }); f.scan();
  const before = readFileSync(f.state, 'utf8');
  assert.deepEqual(JSON.parse(before).lastScan.evidence.pullPages, [[pull()]]);
  for (const config of [
    { fail: true }, { pages: [pull()] }, { pages: [] },
    { pages: [[pull(1, { body: 123 })]] }, { pages: [[pull(), pull()]] },
    { pages: [[pull(1, { head: { sha: 'a'.repeat(41) } })]] },
    { pages: [[pull()]], sha: 'a'.repeat(63) },
    { pages: [[pull()]], ref: { object: { sha: SHA } } },
  ]) {
    f.configure(config);
    const result = f.run();
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, '');
    assert.equal(readFileSync(f.state, 'utf8'), before);
  }
  const mismatch = spawnSync(process.execPath, [script, 'scan', '--repo', 'other/repo', '--state', f.state], { encoding: 'utf8' });
  assert.notEqual(mismatch.status, 0);
  assert.match(mismatch.stderr, /repository mismatch/);
  assert.equal(readFileSync(f.state, 'utf8'), before);
});

localTest('explicit posted feedback survives scans and appears on the next delta without public writes', (t) => {
  const f = fixture(t);
  f.configure({ pages: [[pull()]] }); f.scan();
  const extra = ['--pr', '1', '--key', 'benchmark-evidence', '--url', 'https://github.com/owner/repo/pull/1#issuecomment-123'];
  assert.equal(f.run('record-feedback', extra).status, 0);
  assert.equal(f.run('record-feedback', extra).status, 0);
  assert.equal(f.scan().changed, 0);
  f.configure({ pages: [[pull(1, { head: { sha: OTHER_SHA } })]] });
  assert.deepEqual(f.scan().changes[0].alreadyRequested, [{ key: 'benchmark-evidence', url: extra.at(-1) }]);
  const calls = readFileSync(f.log, 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(calls.every((args) => args[0] === 'api' && !args.includes('--method')));
  const before = readFileSync(f.state, 'utf8');
  assert.notEqual(f.run('record-feedback', [...extra.slice(0, -1), 'https://example.com/']).status, 0);
  assert.equal(readFileSync(f.state, 'utf8'), before);
});

localTest('bounded stdout retains complete delta in the explicitly named state location', (t) => {
  const f = fixture(t);
  f.configure({ pages: [Array.from({ length: 103 }, (_, i) => pull(i + 1))] });
  const result = f.scan();
  assert.equal(result.changed, 103);
  assert.equal(result.changes.length, 100);
  assert.equal(result.omitted, 3);
  assert.equal(result.stateFile, f.state);
  assert.equal(result.deltaPointer, 'lastScan.changes');
  assert.equal(f.read().lastScan.changes.length, 103);
});


localTest('repository identity ignores case across CLI, API, saved state and feedback URLs', (t) => {
  const f = fixture(t);
  const canonicalUrl = 'https://github.com/Owner/RePo/pull/1';
  f.configure({ pages: [[pull(1, { html_url: canonicalUrl,
    base: { ref: 'dev', repo: { full_name: 'Owner/RePo' } } })]] });
  const first = f.run('scan', [], 'OWNER/REPO');
  assert.equal(first.status, 0, first.stderr);
  assert.equal(JSON.parse(first.stdout).repo, 'owner/repo');
  assert.equal(JSON.parse(first.stdout).changes[0].url, canonicalUrl);
  assert.equal(f.read().repo, 'owner/repo');
  const extra = ['--pr', '1', '--key', 'evidence', '--url', `${canonicalUrl}#issuecomment-123`];
  assert.equal(f.run('record-feedback', extra, 'OWNER/REPO').status, 0);
  assert.equal(f.run('record-feedback', [...extra.slice(0, -1), 'https://github.com/OWNER/REPO/pull/1#issuecomment-123']).status, 0);
  const mixedCaseState = f.read();
  mixedCaseState.repo = 'Owner/RePo';
  writeFileSync(f.state, JSON.stringify(mixedCaseState));
  assert.equal(f.scan().changed, 0);
  assert.equal(f.read().repo, 'owner/repo');
  assert.equal(f.read().pulls[1].feedback[0].url, extra.at(-1));
  const before = readFileSync(f.state, 'utf8');
  for (const url of ['https://github.com/OWNER/REPO/Pull/1#issuecomment-123',
    'https://github.com/OWNER/REPO/pull/2#issuecomment-123',
    'https://github.com/OTHER/REPO/pull/1#issuecomment-123']) {
    assert.notEqual(f.run('record-feedback', [...extra.slice(0, -1), url]).status, 0);
    assert.equal(readFileSync(f.state, 'utf8'), before);
  }
});

test('help is available without gh or task state', () => {
  const result = spawnSync(process.execPath, [script, '--help'], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /record-feedback/);
});
