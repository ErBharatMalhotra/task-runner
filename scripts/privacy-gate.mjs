#!/usr/bin/env node
// privacy-gate.mjs — fail CI if anything code-like or secret-like is about to
// live in this public repo. The private bundle is cloned at RUNTIME into core/
// and never committed; the gate checks the git index so a live clone never
// trips it.
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();

const KEY_PATTERNS = [
  [/AIza[A-Za-z0-9_\-]{30,}/, "provider API key"],
  [/gsk_[A-Za-z0-9]{20,}/, "Groq key"],
  [/sk-or-v1-[A-Za-z0-9]{20,}/, "OpenRouter key"],
  [/ghp_[A-Za-z0-9]{30,}/, "GitHub PAT"],
  [/github_pat_[A-Za-z0-9_]{30,}/, "GitHub fine-grained PAT"],
  [/xox[baprs]-[A-Za-z0-9\-]{10,}/, "Slack token"],
  [/-----BEGIN (RSA |EC )?PRIVATE KEY-----/, "private key"],
];

// only these top-level entries may exist here
const ALLOWED_TOP = new Set([
  ".git", ".github", "scripts", "site", "README.md", "SETUP.md", "LICENSE",
]);

const CODE_EXT = /\.(js|mjs|cjs|ts|py|rb|go|rs|java|sh|ps1|toml|yaml|yml)$/i;
const CODE_DIRS = /(^|\/)(engine|lib|templates|console|tests|design-system)(\/|$)/;

let problems = [];

// 1. unexpected top-level entries (catches stray engine/, data/, .env etc.)
for (const entry of fs.readdirSync(ROOT)) {
  if (ALLOWED_TOP.has(entry)) continue;
  problems.push(`unexpected top-level entry: ${entry} (private-bundle material?)`);
}

// 2. forbidden / code-like files anywhere in the INDEX (not the working tree)
const { execSync } = await import("node:child_process");
let tracked = [];
try {
  tracked = execSync("git ls-files", { cwd: ROOT, encoding: "utf8" })
    .split("\n").map((s) => s.trim()).filter(Boolean);
} catch { /* fresh repo before first commit — top-level check already ran */ }

for (const f of tracked) {
  if (f === ".env" || f.endsWith(".env")) problems.push(`forbidden file: ${f}`);
  if (CODE_DIRS.test(f)) problems.push(`code-like path in public repo: ${f}`);
  if (CODE_EXT.test(f) && !f.startsWith("scripts/") && !f.startsWith(".github/") && !f.startsWith("site/assets/")) {
    problems.push(`code-like file in public repo: ${f}`);
  }
  const raw = (() => { try { return fs.readFileSync(path.join(ROOT, f), "utf8"); } catch { return ""; } })();
  for (const [re, label] of KEY_PATTERNS) {
    if (re.test(raw)) problems.push(`${label} detected in ${f}`);
  }
}

if (problems.length) {
  console.error("PRIVACY GATE — public repo must not contain bundle code or secrets:");
  for (const p of [...new Set(problems)]) console.error("  ✗ " + p);
  process.exit(1);
}
console.log("privacy-gate: clean (" + tracked.length + " tracked files scanned)");
