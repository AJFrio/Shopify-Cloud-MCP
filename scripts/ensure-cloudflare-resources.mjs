#!/usr/bin/env node
/**
 * Ensures the D1 database and KV namespace referenced in wrangler.jsonc exist,
 * then writes missing IDs into wrangler.jsonc.
 *
 * Default (recommended): uses the Wrangler CLI only — works with `wrangler login`
 * (no CLOUDFLARE_API_TOKEN required). You may still need `account_id` in
 * wrangler.jsonc or CLOUDFLARE_ACCOUNT_ID if you have multiple Cloudflare accounts.
 *
 * Optional API mode: `USE_CLOUDFLARE_API=1` or `--api` uses the REST API
 * (requires CLOUDFLARE_API_TOKEN).
 *
 * Usage:
 *   npm run cloudflare:ensure-resources
 *   node scripts/ensure-cloudflare-resources.mjs
 *   node scripts/ensure-cloudflare-resources.mjs --dry-run
 *   node scripts/ensure-cloudflare-resources.mjs --api
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const wranglerPath = resolve(root, "wrangler.jsonc");

const dryRun = process.argv.includes("--dry-run");
const useApi =
  process.argv.includes("--api") ||
  process.env.USE_CLOUDFLARE_API === "1" ||
  process.env.USE_CLOUDFLARE_API === "true";

function loadWrangler() {
  const raw = readFileSync(wranglerPath, "utf8");
  return JSON.parse(raw);
}

function saveWrangler(config) {
  if (dryRun) {
    console.log("[dry-run] Would write wrangler.jsonc:\n", JSON.stringify(config, null, 2));
    return;
  }
  writeFileSync(wranglerPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

function stripAnsi(s) {
  return s.replace(/\u001b\[[0-9;]*m/g, "");
}

function wrangler(args, { json = false } = {}) {
  const r = spawnSync("npx", ["wrangler", ...args], {
    cwd: root,
    encoding: "utf8",
    shell: true,
    env: process.env,
  });
  const stdout = stripAnsi(r.stdout || "");
  const stderr = stripAnsi(r.stderr || "");
  return {
    ok: r.status === 0,
    status: r.status ?? 1,
    stdout,
    stderr,
    text: stdout + stderr,
  };
}

function wranglerWhoamiAccountId() {
  const r = wrangler(["whoami", "--json"]);
  if (!r.ok) {
    console.error(r.text.trim());
    return null;
  }
  const start = r.stdout.indexOf("{");
  if (start === -1) return null;
  try {
    const j = JSON.parse(r.stdout.slice(start));
    const accounts = j.accounts ?? j.memberships?.map((m) => m.account) ?? [];
    const def =
      accounts.find((a) => a?.id && (a.default === true || a.isDefault)) ??
      accounts[0];
    return def?.id ?? null;
  } catch {
    return null;
  }
}

/** Extract first JSON array or object from wrangler stdout (npm noise / ANSI stripped). */
function parseJsonLoose(stdout) {
  const s = stripAnsi(stdout).trim();
  const a = s.indexOf("[");
  const o = s.indexOf("{");
  let start = -1;
  if (a === -1) start = o;
  else if (o === -1) start = a;
  else start = Math.min(a, o);
  if (start === -1) throw new Error("No JSON found in output:\n" + s.slice(0, 800));
  const slice = s.slice(start);
  try {
    return JSON.parse(slice);
  } catch {
    const arrEnd = slice.lastIndexOf("]");
    const objEnd = slice.lastIndexOf("}");
    const end = Math.max(arrEnd, objEnd);
    if (end === -1) throw new Error("Invalid JSON in wrangler output");
    return JSON.parse(slice.slice(0, end + 1));
  }
}

function d1ListViaCli() {
  const r = wrangler(["d1", "list", "--json"]);
  if (!r.ok) throw new Error(`wrangler d1 list failed:\n${r.text}`);
  const data = parseJsonLoose(r.stdout);
  return Array.isArray(data) ? data : [];
}

function d1FindByName(databases, name) {
  return databases.find((d) => d.name === name) ?? null;
}

/** Merge duplicate `kv_namespaces` entries with the same `binding`. */
function dedupeKvNamespaces(config) {
  const list = config.kv_namespaces;
  if (!Array.isArray(list) || list.length < 2) return false;
  const byBinding = new Map();
  for (const e of list) {
    const b = e?.binding;
    if (!b) continue;
    const prev = byBinding.get(b);
    if (!prev) {
      byBinding.set(b, { ...e });
    } else {
      byBinding.set(b, { ...prev, ...e });
    }
  }
  const merged = [...byBinding.values()];
  if (merged.length === list.length) return false;
  config.kv_namespaces = merged;
  return true;
}

/** Merge duplicate `d1_databases` entries with the same `binding` (wrangler --update-config can append). */
function dedupeD1Databases(config) {
  const list = config.d1_databases;
  if (!Array.isArray(list) || list.length < 2) return false;
  const byBinding = new Map();
  for (const e of list) {
    const b = e?.binding;
    if (!b) continue;
    const prev = byBinding.get(b);
    if (!prev) {
      byBinding.set(b, { ...e });
    } else {
      byBinding.set(b, { ...prev, ...e });
    }
  }
  const merged = [...byBinding.values()];
  if (merged.length === list.length) return false;
  config.d1_databases = merged;
  return true;
}

/**
 * Parse `wrangler kv namespace list` table output into { id, title }[].
 */
function kvListViaCliParse(stdout) {
  const lines = stripAnsi(stdout).split(/\r?\n/);
  const rows = [];
  for (const line of lines) {
    if (!line.includes("|") && !line.includes("│")) continue;
    const parts = line
      .split(/[│|]/)
      .map((c) => c.trim())
      .filter((c) => c && !/^[-─]+$/.test(c));
    if (parts.length < 2) continue;
    const idCell = parts[0];
    if (!/^[0-9a-f]{32}$/i.test(idCell)) continue;
    const title = parts[parts.length - 1] || parts[1];
    if (/^id$/i.test(title) || /^title$/i.test(title)) continue;
    rows.push({ id: idCell.toLowerCase(), title });
  }
  const seen = new Set();
  return rows.filter((r) => {
    if (seen.has(r.id)) return false;
    seen.add(r.id);
    return true;
  });
}

function kvListViaCli() {
  const r = wrangler(["kv", "namespace", "list"]);
  if (!r.ok) throw new Error(`wrangler kv namespace list failed:\n${r.text}`);
  try {
    const data = parseJsonLoose(r.stdout);
    if (Array.isArray(data)) {
      return data
        .filter((x) => x?.id && x?.title)
        .map((x) => ({ id: String(x.id).toLowerCase(), title: x.title }));
    }
  } catch {
    /* fall through to table parser for older wrangler output */
  }
  return kvListViaCliParse(r.stdout);
}

// ---------- Optional Cloudflare API (when --api / USE_CLOUDFLARE_API) ----------

async function cfFetch(path, token, init = {}) {
  const url = `https://api.cloudflare.com/client/v4${path}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.success === false) {
    const err = data.errors?.length
      ? JSON.stringify(data.errors, null, 2)
      : `${res.status} ${res.statusText} ${JSON.stringify(data)}`;
    throw new Error(err);
  }
  return data.result;
}

async function listAllKvNamespacesApi(accountId, token) {
  const all = [];
  let page = 1;
  const perPage = 100;
  while (true) {
    const result = await cfFetch(
      `/accounts/${accountId}/storage/kv/namespaces?page=${page}&per_page=${perPage}`,
      token,
    );
    const batch = Array.isArray(result) ? result : [];
    all.push(...batch);
    if (batch.length < perPage) break;
    page += 1;
  }
  return all;
}

async function findD1ByNameApi(accountId, token, name) {
  const result = await cfFetch(
    `/accounts/${accountId}/d1/database?name=${encodeURIComponent(name)}`,
    token,
  );
  const list = Array.isArray(result) ? result : [];
  return list.find((d) => d.name === name) ?? null;
}

async function createD1Api(accountId, token, name) {
  return cfFetch(`/accounts/${accountId}/d1/database`, token, {
    method: "POST",
    body: JSON.stringify({ name }),
  });
}

async function createKvNamespaceApi(accountId, token, title) {
  return cfFetch(`/accounts/${accountId}/storage/kv/namespaces`, token, {
    method: "POST",
    body: JSON.stringify({ title }),
  });
}

// ---------- main ----------

async function ensureD1Cli(config) {
  let changed = dedupeD1Databases(config);
  if (changed) {
    console.log("Merged duplicate D1 bindings in wrangler.jsonc.");
  }
  const d1Entry = config.d1_databases?.[0];
  if (!d1Entry?.database_name) {
    console.log("No d1_databases[0].database_name; skipping D1.");
    return changed;
  }
  const name = d1Entry.database_name;
  const binding = d1Entry.binding || "DB";

  let databases = d1ListViaCli();
  let row = d1FindByName(databases, name);

  if (!row) {
    console.log(`Creating D1 database "${name}" (wrangler)…`);
    if (dryRun) {
      console.log("[dry-run] Would run: wrangler d1 create ... --update-config");
    } else {
      const r = wrangler([
        "d1",
        "create",
        name,
        "--binding",
        binding,
        "--update-config",
      ]);
      if (!r.ok) throw new Error(`wrangler d1 create failed:\n${r.text}`);
      console.log(r.stdout.trim());
      Object.assign(config, loadWrangler());
      if (dedupeD1Databases(config)) changed = true;
      databases = d1ListViaCli();
      row = d1FindByName(databases, name);
    }
  } else {
    console.log(`D1 "${name}" already exists (${row.uuid}).`);
  }

  const fresh = config.d1_databases?.[0];
  if (row?.uuid && fresh && fresh.database_id !== row.uuid) {
    fresh.database_id = row.uuid;
    changed = true;
    console.log(`Bound D1 database_id: ${row.uuid}`);
  }
  return changed;
}

async function ensureKvCli(config) {
  let changed = dedupeKvNamespaces(config);
  if (changed) {
    console.log("Merged duplicate KV bindings in wrangler.jsonc.");
  }
  const kvEntries = config.kv_namespaces ?? [];
  if (!kvEntries.length) {
    console.log("No kv_namespaces; skipping KV.");
    return changed;
  }

  for (const kv of kvEntries) {
    if (!kv?.binding) continue;
    const title = `${config.name}-${kv.binding}`;
    let list = kvListViaCli();
    const idNorm = kv.id ? String(kv.id).toLowerCase() : "";
    let ns =
      (idNorm && list.find((n) => n.id === idNorm)) ||
      list.find((n) => n.title === title);

    if (!ns) {
      console.log(`Creating KV namespace "${title}" (binding ${kv.binding})…`);
      if (dryRun) {
        console.log(
          "[dry-run] Would run: wrangler kv namespace create ... --update-config",
        );
      } else {
        const r = wrangler([
          "kv",
          "namespace",
          "create",
          title,
          "--binding",
          kv.binding,
          "--update-config",
        ]);
        if (r.ok) {
          if (r.stdout.trim()) console.log(r.stdout.trim());
          Object.assign(config, loadWrangler());
          if (dedupeKvNamespaces(config)) changed = true;
          const updated = config.kv_namespaces?.find((k) => k.binding === kv.binding);
          if (updated?.id) ns = { id: updated.id, title };
        } else {
          list = kvListViaCli();
          ns =
            (idNorm && list.find((n) => n.id === idNorm)) ||
            list.find((n) => n.title === title);
          if (!ns) {
            throw new Error(
              `wrangler kv namespace create failed (namespace may already exist under another title):\n${r.text}`,
            );
          }
          console.log(`Re-used existing KV namespace "${ns.title}" (${ns.id}).`);
        }
      }
    } else {
      console.log(`KV "${ns.title}" (${ns.id}) matches binding ${kv.binding}.`);
    }

    const current = config.kv_namespaces?.find((k) => k.binding === kv.binding);
    if (ns?.id && current && current.id !== ns.id) {
      current.id = ns.id;
      changed = true;
      console.log(`Bound KV id for ${kv.binding}: ${ns.id}`);
    }
  }
  return changed;
}

async function ensureD1Api(config, accountId, token) {
  const d1Entry = config.d1_databases?.[0];
  if (!d1Entry?.database_name) return false;
  const name = d1Entry.database_name;
  let row = await findD1ByNameApi(accountId, token, name);
  if (!row) {
    console.log(`Creating D1 database "${name}" (API)…`);
    if (!dryRun) row = await createD1Api(accountId, token, name);
  } else {
    console.log(`D1 "${name}" already exists (${row.uuid}).`);
  }
  let changed = false;
  if (row?.uuid && d1Entry.database_id !== row.uuid) {
    d1Entry.database_id = row.uuid;
    changed = true;
    console.log(`Bound D1 database_id: ${row.uuid}`);
  }
  return changed;
}

async function ensureKvApi(config, accountId, token) {
  const kvEntries = config.kv_namespaces ?? [];
  if (!kvEntries.length) return false;
  const namespaces = await listAllKvNamespacesApi(accountId, token);
  let changed = false;
  for (const kv of kvEntries) {
    if (!kv?.binding) continue;
    const title = `${config.name}-${kv.binding}`;
    let ns =
      (kv.id && namespaces.find((n) => n.id === kv.id)) ||
      namespaces.find((n) => n.title === title);
    if (!ns) {
      console.log(`Creating KV namespace "${title}" (API)…`);
      if (!dryRun) ns = await createKvNamespaceApi(accountId, token, title);
    }
    if (ns?.id && kv.id !== ns.id) {
      kv.id = ns.id;
      changed = true;
      console.log(`Bound KV id for ${kv.binding}: ${ns.id}`);
    }
  }
  return changed;
}

async function main() {
  let config = loadWrangler();
  const accountId =
    process.env.CLOUDFLARE_ACCOUNT_ID ||
    config.account_id ||
    wranglerWhoamiAccountId();

  if (!accountId) {
    console.error(
      "Could not determine Cloudflare account id.\n" +
        'Add "account_id" to wrangler.jsonc, or set CLOUDFLARE_ACCOUNT_ID, or run `wrangler login` and use an account `wrangler whoami --json` can see.',
    );
    process.exit(1);
  }

  let changed = false;
  if (!config.account_id) {
    config.account_id = accountId;
    changed = true;
    console.log(`Set wrangler account_id to ${accountId}`);
  }

  if (useApi) {
    const token = process.env.CLOUDFLARE_API_TOKEN;
    if (!token) {
      console.error(
        "API mode requires CLOUDFLARE_API_TOKEN (Workers KV + D1 edit, or broader Account token).",
      );
      process.exit(1);
    }
    console.log("Using Cloudflare REST API (--api / USE_CLOUDFLARE_API).\n");
    changed = (await ensureD1Api(config, accountId, token)) || changed;
    changed = (await ensureKvApi(config, accountId, token)) || changed;
  } else {
    console.log("Using Wrangler CLI (default). Run `wrangler login` if needed.\n");
    changed = (await ensureD1Cli(config)) || changed;
    changed = (await ensureKvCli(config)) || changed;
  }

  if (changed) {
    saveWrangler(config);
    console.log(`Updated ${wranglerPath}`);
  } else if (!dryRun) {
    console.log("No wrangler.jsonc changes needed.");
  }

  const dbName = config.d1_databases?.[0]?.database_name;
  console.log(
    "\nIf you created a new D1 database, apply migrations:\n" +
      `  npx wrangler d1 migrations apply ${dbName ?? "<db-name>"} --remote\n` +
      "  (omit --remote for the local dev database)\n",
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
