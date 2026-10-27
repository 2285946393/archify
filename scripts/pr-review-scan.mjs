#!/usr/bin/env node
// Task-local change detection only. A delta is not a review or readiness verdict.
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { isAbsolute } from 'node:path';

const HELP = `Usage:
  node scripts/pr-review-scan.mjs scan --repo owner/repo --state /absolute/task-state.json
  node scripts/pr-review-scan.mjs record-feedback --repo owner/repo --state /absolute/task-state.json --pr 123 --key finding-topic --url https://github.com/owner/repo/pull/123#issuecomment-123

Requires authenticated gh on PATH. scan reads paginated open pulls and one ref per
 distinct target branch. First scan reports all open PRs. updated_at signals
activity (including discussion activity); it does not identify or read replies.
Disappeared PRs are marked no-longer-open, never assumed merged. Output includes
at most 100 changed summaries; all changes remain in state.lastScan.changes. Raw parsed API responses are
retained in state.lastScan.evidence; keep this file private. Keep
state private and task-local; deleting it resets the baseline. No public writes
or review/readiness decisions occur. record-feedback records a finding explicitly
posted by the caller; it does not verify or post the linked comment.
`;
const fail = (message) => { throw new Error(message); };
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const string = (value) => typeof value === 'string';
const sha = (value) => string(value) && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(value);
const hash = (value) => createHash('sha256').update(value).digest('hex');
const timestamp = (value) => string(value) && Number.isFinite(Date.parse(value));
function parseArgs(argv) {
  if (argv.includes('--help') || argv.includes('-h')) return { help: true };
  const [command, ...rest] = argv;
  if (!['scan', 'record-feedback'].includes(command)) fail('Expected scan or record-feedback; use --help.');
  const options = { command };
  const allowed = command === 'scan' ? ['repo', 'state'] : ['repo', 'state', 'pr', 'key', 'url'];
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i].slice(2);
    if (!rest[i].startsWith('--') || !allowed.includes(key) || options[key] !== undefined || !rest[i + 1]) fail('Invalid or duplicate option; use --help.');
    options[key] = rest[i + 1];
  }
  if (allowed.some((key) => !options[key])) fail('Missing required option; use --help.');
  if (!/^[\w.-]+\/[\w.-]+$/.test(options.repo)) fail('Invalid repository; expected owner/repo.');
  options.repo = options.repo.toLowerCase();
  if (!isAbsolute(options.state)) fail('--state must be an absolute task-local file path.');
  return options;
}
function validFeedback(feedback, repo, number) {
  return Array.isArray(feedback) && feedback.length <= 100 && feedback.every((item) =>
    object(item) && string(item.key) && item.key.length > 0 && item.key.length <= 160 &&
    validUrl(item.url, repo, number));
}
function repositoryUrlSuffix(url, repo) {
  if (!string(url)) return null;
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)(\/.*)$/.exec(url);
  return match && `${match[1]}/${match[2]}`.toLowerCase() === repo ? match[3] : null;
}
function validPullUrl(url, repo, number) {
  return repositoryUrlSuffix(url, repo) === `/pull/${number}`;
}
function validUrl(url, repo, number) {
  const suffix = repositoryUrlSuffix(url, repo);
  const prefix = `/pull/${number}#`;
  return suffix !== null && suffix.startsWith(prefix) &&
    /^(issuecomment-\d+|discussion_r\d+|pullrequestreview-\d+)$/.test(suffix.slice(prefix.length));
}
function readState(path, repo) {
  let state;
  try { state = JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return { version: 1, repo, pulls: {} };
    fail('Cannot read valid task state; previous state preserved.');
  }
  if (!object(state) || state.version !== 1 || !string(state.repo) || state.repo.toLowerCase() !== repo || !object(state.pulls)) fail('Invalid task state or repository mismatch; previous state preserved.');
  state.repo = repo;
  for (const [number, item] of Object.entries(state.pulls)) {
    if (!/^[1-9]\d*$/.test(number) || !object(item) || !['open', 'no-longer-open'].includes(item.status) ||
      !sha(item.head) || !sha(item.bodyHash) || !string(item.base) || !sha(item.targetBase) ||
      !timestamp(item.updatedAt) || typeof item.draft !== 'boolean' || !string(item.title) ||
      !validPullUrl(item.url, repo, number) || !validFeedback(item.feedback, repo, number)) fail('Invalid task state entry; previous state preserved.');
  }
  return state;
}
function saveState(path, state) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    try { unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
function api(endpoint, paginate = false) {
  let output;
  try {
    output = execFileSync('gh', ['api', endpoint, ...(paginate ? ['--paginate', '--slurp'] : [])],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch { fail('GitHub API request failed; previous state preserved.'); }
  try { return JSON.parse(output); } catch { fail('Invalid GitHub API JSON; previous state preserved.'); }
}
function scan(options, state) {
  const pages = api(`repos/${options.repo}/pulls?state=open&per_page=100`, true);
  if (!Array.isArray(pages) || pages.length === 0 || !pages.every(Array.isArray)) fail('Invalid paginated pulls response; previous state preserved.');
  const current = {};
  for (const pull of pages.flat()) {
    if (!object(pull) || !Number.isSafeInteger(pull.number) || pull.number < 1 || pull.state !== 'open' ||
      !object(pull.head) || !sha(pull.head.sha) || !object(pull.base) || !string(pull.base.ref) || !pull.base.ref ||
      !object(pull.base.repo) || (!string(pull.base.repo.full_name) || pull.base.repo.full_name.toLowerCase() !== options.repo) ||
      !(pull.body === null || string(pull.body)) || !timestamp(pull.updated_at) || typeof pull.draft !== 'boolean' ||
      !string(pull.title) || !validPullUrl(pull.html_url, options.repo, pull.number) || current[pull.number]) {
      fail('Invalid pull schema or duplicate PR; previous state preserved.');
    }
    current[pull.number] = { status: 'open', head: pull.head.sha, bodyHash: hash(pull.body ?? ''),
      base: pull.base.ref, updatedAt: pull.updated_at, draft: pull.draft,
      title: pull.title.slice(0, 160), url: pull.html_url, feedback: state.pulls[pull.number]?.feedback ?? [] };
  }
  const bases = new Map();
  const baseRefs = Object.create(null);
  for (const pull of Object.values(current)) {
    if (!bases.has(pull.base)) {
      const ref = api(`repos/${options.repo}/git/ref/heads/${encodeURIComponent(pull.base)}`);
      if (!object(ref) || ref.ref !== `refs/heads/${pull.base}` || !object(ref.object) || ref.object.type !== 'commit' || !sha(ref.object.sha)) fail('Invalid target branch ref; previous state preserved.');
      bases.set(pull.base, ref.object.sha);
      baseRefs[pull.base] = ref;
    }
    pull.targetBase = bases.get(pull.base);
  }
  const changes = [];
  const next = { ...state.pulls };
  for (const [number, pull] of Object.entries(current)) {
    const previous = state.pulls[number];
    const reasons = [];
    if (!previous) reasons.push('new');
    else {
      if (previous.status !== 'open') reasons.push('reopened');
      for (const [field, reason] of [['head', 'head'], ['bodyHash', 'body'], ['updatedAt', 'activity'], ['draft', 'draft'], ['base', 'base'], ['targetBase', 'target-base'], ['title', 'title']]) {
        if (previous[field] !== pull[field]) reasons.push(reason);
      }
    }
    if (reasons.length) changes.push(summary(number, pull, reasons));
    next[number] = pull;
  }
  for (const [number, previous] of Object.entries(state.pulls)) {
    if (!current[number] && previous.status === 'open') {
      next[number] = { ...previous, status: 'no-longer-open' };
      changes.push(summary(number, next[number], ['no-longer-open']));
    }
  }
  saveState(options.state, { version: 1, repo: options.repo, scannedAt: new Date().toISOString(), pulls: next, lastScan: { changes, evidence: { pullPages: pages, baseRefs } } });
  return { repo: options.repo, stateFile: options.state, deltaPointer: 'lastScan.changes', open: Object.keys(current).length, changed: changes.length,
    omitted: Math.max(0, changes.length - 100), changes: changes.slice(0, 100) };
}
function summary(number, pull, reasons) {
  return { pr: Number(number), title: pull.title, url: pull.url, status: pull.status, reasons,
    head: pull.head, base: pull.base, targetBase: pull.targetBase, draft: pull.draft,
    alreadyRequested: pull.feedback.map(({ key, url }) => ({ key, url })) };
}
function recordFeedback(options, state) {
  if (!/^[1-9]\d*$/.test(options.pr) || !state.pulls[options.pr]) fail('PR must exist in this task state; scan first.');
  if (!options.key.trim() || options.key.length > 160 || !validUrl(options.url, options.repo, options.pr)) fail('Invalid finding key or GitHub comment URL.');
  const feedback = state.pulls[options.pr].feedback;
  const existing = feedback.find((entry) => entry.key === options.key);
  if (existing && repositoryUrlSuffix(existing.url, options.repo) !== repositoryUrlSuffix(options.url, options.repo)) fail('Finding key already records another URL; previous state preserved.');
  if (!existing) {
    if (feedback.length >= 100) fail('Feedback ledger limit reached; previous state preserved.');
    feedback.push({ key: options.key, url: options.url });
    saveState(options.state, state);
  }
  return { repo: options.repo, pr: Number(options.pr), recorded: { key: options.key, url: options.url } };
}
try {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) process.stdout.write(HELP);
  else {
    const state = readState(options.state, options.repo);
    const result = options.command === 'scan' ? scan(options, state) : recordFeedback(options, state);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }
} catch (error) {
  process.stderr.write(`pr-review-scan: ${error.message}\n`);
  process.exitCode = 1;
}
