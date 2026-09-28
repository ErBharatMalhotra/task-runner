# Setup — one time (~10 minutes)

## 1. Repos

1. **Private core** — the full project (code + `data/` + `engine/` + `lib/`) lives
   in a **private** repo.
2. **Public runner** — push ONLY this folder's contents (`.github/`, `scripts/`,
   `README.md`, `SETUP.md`, `site/index.html`) to a new **public** repo.

## 2. Fine-grained token (`CORE_TOKEN`)

GitHub → Settings → Developer settings → Fine-grained tokens → Generate new:

- **Repository access:** only the private core repo
- **Permissions:** Contents → **Read and write**
- Expiry: 90 days + calendar reminder (or longer)

Add it in the **public** repo: Settings → Secrets and variables → Actions →
New repository secret → Name: `CORE_TOKEN`.

## 3. Job secrets (public repo)

Add only the ones your pipelines need — they are injected as env vars inside the
job and never touch either repo's files:

| Secret | Used for |
|---|---|
| `PROVIDER_KEYS` | generation provider (comma pool) |
| `SOURCE_USER` | data-source account |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | optional alerts |

## 4. Hosting

Point your static host's git integration at this **public** repo, production
branch `main`, framework **None**, build command *(empty)*, output directory
**`site/`** (or wherever the pipelines leave artifacts). Every workflow push of
`site/` auto-deploys — no tokens, no manual deploys.

## 5. First run

Public repo → Actions → **scheduled run** → Run workflow. Watch it: clone the
private bundle → run pipelines → publish artifacts → sync results back to the
private repo.

## 6. Keepalive (important)

GitHub disables scheduled workflows on public repos after **60 days of repo
inactivity**. The run commits artifacts on every execution, so the repo never
goes quiet — keepalive is a by-product. If you ever turn artifact commits off,
add a weekly no-op commit workflow instead.

## Troubleshooting

- `Clone private bundle` fails → `CORE_TOKEN` expired or wrong repo permission
- `privacy-gate` fails → something code-like got staged in the public repo; check
  the gate output, it names the file
- Artifacts not updating → check the "Publish artifacts" step and the host's
  deployment log
