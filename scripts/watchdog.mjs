#!/usr/bin/env node
// watchdog.mjs — re-dispatch the scheduled pipelines when GitHub drops a cron.
//
// Evidence this exists for: in one 4.8-hour window only 4 scheduled-runs fired
// where 5-11 were expected, and run.yml itself carries the comment "only 4-5 of
// 24 hourly runs actually fired/day". The dropped cron — not the LLM quota — is
// the real ceiling on authoring throughput.
//
// The pipelines are idempotent, so the rule is deliberately simple:
//   if a pipeline is not running or queued, and its newest run started longer
//   ago than its threshold, dispatch it once.
//
// Usage:
//   node scripts/watchdog.mjs            # live — dispatches when needed
//   DRY_RUN=1 node scripts/watchdog.mjs  # decision only, never dispatches
//
// Env overrides (the local dry-run test uses them to exercise both branches):
//   RUN_MAX_AGE_MIN   silence before scheduled-run is re-dispatched (default 150 = 2.5h)
//   DRIP_MAX_AGE_MIN  silence before release-drip is re-dispatched (default 1560 = 26h)
//   REPO              owner/repo for local runs (default GITHUB_REPOSITORY)
//
// Auth: GITHUB_TOKEN — in Actions the workflow token (needs actions: write);
// locally a `gh auth token` works for a dry run.

const API = 'https://api.github.com';
const REPO = process.env.REPO || process.env.GITHUB_REPOSITORY || '';
const TOKEN = process.env.GITHUB_TOKEN || '';
const DRY = /^(1|true)$/i.test(process.env.DRY_RUN || '');
const RUN_MAX_AGE_MIN = Number(process.env.RUN_MAX_AGE_MIN || 150);
const DRIP_MAX_AGE_MIN = Number(process.env.DRIP_MAX_AGE_MIN || 1560);
const ACTIVE = new Set(['queued', 'in_progress', 'requested', 'waiting', 'pending']);

if (!REPO || !TOKEN) {
  console.error('watchdog: need REPO (or GITHUB_REPOSITORY) and GITHUB_TOKEN');
  process.exit(2);
}

const headers = {
  Authorization: `Bearer ${TOKEN}`,
  Accept: 'application/vnd.github+json',
  'User-Agent': 'bharatdn-watchdog',
  'X-GitHub-Api-Version': '2022-11-28',
};

async function api(path, init = {}) {
  const res = await fetch(API + path, { ...init, headers: { ...headers, ...(init.headers || {}) } });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${init.method || 'GET'} ${path} -> ${res.status} ${body}`.slice(0, 300));
  }
  return res.status === 204 ? null : res.json();
}

const minutesSince = (iso) => (Date.now() - Date.parse(iso)) / 60000;
const fmtAge = (min) => (min >= 120 ? (min / 60).toFixed(1) + 'h' : Math.round(min) + 'm');

async function check(file, label, maxAgeMin) {
  const runs = await api(`/repos/${REPO}/actions/workflows/${file}/runs?per_page=30`);
  const active = runs.workflow_runs.find((r) => ACTIVE.has(r.status));
  if (active) {
    console.log(`watchdog: ${label} — active run ${active.id} (${active.status}) — skip`);
    return null;
  }
  const last = runs.workflow_runs[0];
  if (last) {
    const age = minutesSince(last.run_started_at || last.created_at);
    if (age <= maxAgeMin) {
      console.log(`watchdog: ${label} — last run ${last.id} started ${fmtAge(age)} ago (limit ${fmtAge(maxAgeMin)}) — ok`);
      return null;
    }
    console.log(`watchdog: ${label} — last run ${last.id} started ${fmtAge(age)} ago (limit ${fmtAge(maxAgeMin)}) — STALE`);
  } else {
    console.log(`watchdog: ${label} — no runs found — STALE`);
  }
  if (DRY) {
    console.log(`watchdog: ${label} — DRY_RUN, would dispatch`);
    return `would-dispatch ${label}`;
  }
  await api(`/repos/${REPO}/actions/workflows/${file}/dispatches`, {
    method: 'POST',
    body: JSON.stringify({ ref: 'main' }),
  });
  console.log(`watchdog: ${label} — dispatched`);
  return `dispatched ${label}`;
}

const actions = [];
for (const [file, label, maxAge] of [
  ['run.yml', 'scheduled-run', RUN_MAX_AGE_MIN],
  ['release.yml', 'release-drip', DRIP_MAX_AGE_MIN],
]) {
  const r = await check(file, label, maxAge);
  if (r) actions.push(r);
}
console.log(`watchdog: done — ${actions.length ? actions.join('; ') : 'nothing to do'}${DRY ? ' (dry run)' : ''}`);
