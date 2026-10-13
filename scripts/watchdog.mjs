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
//   API_BASE          API root, for a local server that can fail on demand
//   API_RETRIES       attempts per request before giving up (default 4)
//   API_RETRY_BASE_MS first backoff step, doubled per attempt (default 1000)
//
// Transient API failures are retried, because they are the normal state of a
// hosted API and not a signal about the pipelines. Evidence: the 12 Oct 16:09
// run died on `GET /repos/.../actions/workflows/run.yml/runs?per_page=30 -> 502
// Server Error`, forty minutes before the next scheduled run read the exact same
// endpoint and succeeded. One edge 502 turned the watchdog red, which is the one
// thing a watchdog must not do: a monitor that cries wolf gets muted.
//
// A check that fails after every attempt still exits 1 — the pipelines are
// idempotent and this runs every two hours, but a silently broken monitor is
// worse than a red one, so the failure is reported rather than swallowed.
//
// Auth: GITHUB_TOKEN — in Actions the workflow token (needs actions: write);
// locally a `gh auth token` works for a dry run.

const API = process.env.API_BASE || 'https://api.github.com';
const RETRIES = Math.max(1, Number(process.env.API_RETRIES || 4));
const RETRY_BASE_MS = Math.max(50, Number(process.env.API_RETRY_BASE_MS || 1000));
const RETRY_CAP_MS = 30000;
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

// 5xx and 408 are the API edge having a bad moment, 429 is a rate limit; none of
// them say anything about whether a pipeline ran. Everything else (401 on an
// expired token, 404 on a renamed workflow file) is a real fault and is raised
// immediately — retrying a wrong request four times only hides it for longer.
const TRANSIENT = (status) => status === 408 || status === 429 || status >= 500;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function retryAfterMs(res) {
  const seconds = Number(res.headers.get('retry-after'));
  // Ignoring Retry-After on a 429 is how a short rate limit turns into a longer
  // one, so it wins over the exponential step when it is present.
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1000, RETRY_CAP_MS) : 0;
}

async function api(path, init = {}) {
  let delay = RETRY_BASE_MS;

  for (let attempt = 1; ; attempt++) {
    let err;
    let wait = 0;

    try {
      const res = await fetch(API + path, {
        ...init,
        headers: { ...headers, ...(init.headers || {}) },
        signal: AbortSignal.timeout(20000),
      });
      if (res.ok) return res.status === 204 ? null : await res.json();
      const body = await res.text().catch(() => '');
      err = new Error(`${init.method || 'GET'} ${path} -> ${res.status} ${body}`.slice(0, 300));
      err.status = res.status;
      wait = retryAfterMs(res);
    } catch (e) {
      // A dropped socket, DNS blip or the 20s timeout above: same class, no
      // status to inspect.
      err = e;
    }

    const transient = !err.status || TRANSIENT(err.status);
    if (!transient || attempt >= RETRIES) throw err;

    const pause = wait || delay;
    console.log(`watchdog: ${err.message} — attempt ${attempt}/${RETRIES}, retrying in ${Math.round(pause / 1000)}s`);
    await sleep(pause);
    delay = Math.min(delay * 2, RETRY_CAP_MS);
  }
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
  // A dispatch that fails on the wire and is then retried can arrive twice.
  // That is safe here by design: the pipelines are idempotent, and the README
  // says so, which is also why re-dispatching a dropped run is allowed at all.
  await api(`/repos/${REPO}/actions/workflows/${file}/dispatches`, {
    method: 'POST',
    body: JSON.stringify({ ref: 'main' }),
  });
  console.log(`watchdog: ${label} — dispatched`);
  return `dispatched ${label}`;
}

const actions = [];
const failed = [];
for (const [file, label, maxAge] of [
  ['run.yml', 'scheduled-run', RUN_MAX_AGE_MIN],
  ['release.yml', 'release-drip', DRIP_MAX_AGE_MIN],
]) {
  try {
    const r = await check(file, label, maxAge);
    if (r) actions.push(r);
  } catch (err) {
    // Per-check isolation. The old flow let the throw escape the loop, so the
    // 12 Oct 502 while reading run.yml meant release.yml was never looked at
    // either — one endpoint's bad minute silently halved the watchdog's job.
    failed.push(`${label}: ${err.message}`);
    console.error(`watchdog: ${label} — check failed: ${err.message}`);
  }
}
console.log(`watchdog: done — ${actions.length ? actions.join('; ') : 'nothing to do'}${DRY ? ' (dry run)' : ''}`);
if (failed.length) {
  console.error(`watchdog: ${failed.length} check(s) gave up after ${RETRIES} attempt(s): ${failed.join('; ')}`);
  process.exitCode = 1;
}
