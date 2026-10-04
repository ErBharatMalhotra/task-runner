#!/usr/bin/env node
// Site health gate — catches the class of bug that ships silently:
//   * relative links that 404 because a page moved one directory deeper
//   * canonical URLs that point at a path which itself redirects
//   * _redirects entries whose destination no longer exists
//   * sitemap URLs with no page behind them
//   * two pages claiming the same canonical
//
// Run standalone:  node scripts/site-health.mjs site/dist
// Import from tests: const { auditSite } = await import("../scripts/site-health.mjs")

import fs from "node:fs";
import path from "node:path";

const SITE = process.env.SITE_ORIGIN || "https://bharatdn.com";

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

// URL a page answers on: /x/index.html -> /x/ ; /x.html -> /x
const urlOf = (dist, absPath) => {
  const n = "/" + path.relative(dist, absPath).split(path.sep).join("/");
  if (n.endsWith("/index.html")) return n.slice(0, -"index.html".length);
  return n.replace(/\.html$/, "");
};

export function auditSite(dist) {
  if (!fs.existsSync(dist)) throw new Error(`no build output at ${dist}`);

  const files = walk(dist);
  const html = files.filter((f) => f.endsWith(".html"));
  const norm = (f) => "/" + path.relative(dist, f).split(path.sep).join("/");
  const onDisk = new Set(files.map(norm)); // exact files, with extensions
  const pageUrls = new Set(html.map((f) => urlOf(dist, f))); // extensionless URLs that answer

  const redirects = new Map();
  const rd = path.join(dist, "_redirects");
  if (fs.existsSync(rd)) {
    for (const line of fs.readFileSync(rd, "utf8").split("\n")) {
      const m = line.trim().match(/^(\S+)\s+(\S+)\s+(30[1278])$/);
      // Skip host rewrites like "https://www.example.com/* -> https://example.com/:splat".
      // Those match the same shape but resolve at the DNS/host level, so there is no
      // in-tree destination page for them to point at.
      if (m && !/^https?:\/\//i.test(m[1]) && !/:splat/.test(m[1]) && !/:splat/.test(m[2])) redirects.set(m[1], m[2]);
    }
  }

  // Does this URL answer? Direct page, a redirect source, or a real asset.
  const answers = (u) => {
    const clean = u.split("#")[0].split("?")[0];
    if (!clean) return true;
    if (pageUrls.has(clean)) return true;
    const noTrail = clean.length > 1 ? clean.replace(/\/$/, "") : clean;
    if (pageUrls.has(noTrail) || pageUrls.has(noTrail + "/")) return true;
    return onDisk.has(clean) || onDisk.has(noTrail) || onDisk.has(noTrail + "/index.html");
  };

  const broken = [];
  const canonBad = [];
  const canonSeen = new Map();
  let checked = 0;
  let external = 0;
  let viaRedirect = 0;

  for (const f of html) {
    const src = fs.readFileSync(f, "utf8");
    const self = urlOf(dist, f);

    // Every canonical on the page is checked, not just the first one: a page that
    // carries two conflicting canonicals passes if you only look at the first.
    const canons = [...src.matchAll(/<link[^>]+rel="canonical"[^>]+href="([^"]+)"/g)].map((m) => m[1]);
    if (canons.length > 1) canonBad.push(`${self} — ${canons.length} canonical tags: ${canons.join(" , ")}`);
    for (const canon of canons) {
      const c = canon.replace(SITE, "") || "/";
      if (c !== self) canonBad.push(`${self} -> ${canon}`);
      canonSeen.set(canon, (canonSeen.get(canon) || 0) + 1);
    }

    const base = self.endsWith("/") ? self : self.slice(0, self.lastIndexOf("/") + 1) || "/";
    // Only scan real markup. Inline <script> blocks carry client-side template
    // literals like href="/city/'+c.slug+'/" that nobody can click, and Cloudflare
    // injects its own /cdn-cgi/ assets into the response. Counting either as a
    // broken link turns the gate into noise, and a noisy gate gets ignored.
    const markup = src
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ");
    for (const m of markup.matchAll(/(?:href|src)="([^"]+)"/g)) {
      const raw = m[1];
      if (/^\/cdn-cgi\//.test(raw)) continue;
      if (/^(https?:)?\/\//i.test(raw) || /^(mailto|tel|javascript|data):/i.test(raw) || raw.startsWith("#")) {
        external++;
        continue;
      }
      checked++;
      const target = raw.startsWith("/") ? raw : path.posix.normalize(base + raw);
      if (answers(target)) continue;
      if (redirects.has(target) || redirects.has(target.replace(/\/$/, ""))) {
        viaRedirect++;
        continue;
      }
      broken.push(`${self} -> ${raw}`);
    }
  }

  const deadRedirects = [];
  for (const [from, to] of redirects) if (!answers(to)) deadRedirects.push(`${from} -> ${to}`);

  const smPath = path.join(dist, "sitemap.xml");
  const smLocs = fs.existsSync(smPath)
    ? [...fs.readFileSync(smPath, "utf8").matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].replace(SITE, "") || "/")
    : [];
  const smMissing = smLocs.filter((u) => !answers(u));
  const dupCanon = [...canonSeen.entries()].filter(([, n]) => n > 1).map(([c, n]) => `${n}x ${c}`);

  const total = broken.length + deadRedirects.length + canonBad.length + smMissing.length + dupCanon.length;
  return {
    ok: total === 0,
    total,
    stats: { pages: html.length, links: checked, external, viaRedirect, redirects: redirects.size, sitemap: smLocs.length },
    broken,
    deadRedirects,
    canonBad,
    smMissing,
    dupCanon,
  };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
if (isMain) {
  const dist = process.argv[2] || "site/dist";
  let r;
  try {
    r = auditSite(dist);
  } catch (e) {
    console.error(`SITE HEALTH FAILED: ${e.message}`);
    process.exit(1);
  }
  const s = r.stats;
  console.log(`pages              : ${s.pages}`);
  console.log(`links checked      : ${s.links} (${s.external} external/data skipped), ${s.viaRedirect} resolve via 301`);
  console.log(`redirects          : ${s.redirects} rules, ${r.deadRedirects.length} dead`);
  console.log(`sitemap            : ${s.sitemap} urls, ${r.smMissing.length} missing`);
  console.log(`canonical mismatch : ${r.canonBad.length}`);
  console.log(`duplicate canonical: ${r.dupCanon.length}`);
  const show = (label, arr, n = 10) => {
    if (!arr.length) return;
    console.log(`\n--- ${label} (${arr.length})`);
    arr.slice(0, n).forEach((x) => console.log("  " + x));
    if (arr.length > n) console.log(`  ... +${arr.length - n} more`);
  };
  show("BROKEN links", r.broken);
  show("DEAD redirects", r.deadRedirects);
  show("canonical mismatch", r.canonBad);
  show("sitemap missing", r.smMissing);
  show("duplicate canonicals", r.dupCanon);
  console.log(`\nRESULT: ${r.ok ? "CLEAN" : r.total + " issue(s)"}`);
  process.exit(r.ok ? 0 : 1);
}