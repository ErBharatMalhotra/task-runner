# orchestrator

Scheduled task-runner. Clones a private code bundle, executes its pipelines on a
cron, and publishes only the built artifacts (HTML/JSON) back here.

[![status](https://img.shields.io/badge/schedule-daily-informational)](#)
[![cost](https://img.shields.io/badge/runtime%20cost-%E2%82%B9-success)](#)

## What this is

A thin public shell around a private workspace. The private bundle holds all the
code and data; this repo holds only GitHub Actions wiring (free minutes) and the
generated static output. Nothing sensitive is ever committed here — a CI gate
(`scripts/privacy-gate.mjs`) blocks any commit that looks like code or secrets.

## Workflows

| Workflow | Schedule | What it does |
|---|---|---|
| `run.yml` | daily + dispatch | clone private bundle → run pipelines → publish artifacts → sync results back to the private repo |
| `ci.yml` | on push | privacy gate (no code / no secrets in this repo) |

## Setup

See `SETUP.md` (one-time, ~10 minutes).

## Design notes

- **Why public?** GitHub gives free Actions minutes to public repos; the private
  repo keeps the minutes metered. Splitting the two keeps running costs at zero.
- **Why the gate?** The public repo is discoverable by anyone; the gate + the
  runtime-clone pattern mean even an accidental `git add .` cannot leak the
  bundle.
- Keepalive: the run commits artifacts daily, so GitHub's 60-day scheduler
  disable never triggers.
