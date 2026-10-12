import { env } from "cloudflare:workers";
import coreMigration from "../../db/migrations/0001_crm_core.sql?raw";
import seedMigration from "../../db/migrations/0002_seed_rules.sql?raw";
import satisfactionMigration from "../../db/migrations/0003_satisfaction.sql?raw";

// Migrations run in order, once per database; each is recorded in _migrations.
// Rollback SQL lives next to each file as NNNN_name.down.sql (see docs/CDP-CRM.md).
const migrations = [
  { id: "0001_crm_core", sql: coreMigration },
  { id: "0002_seed_rules", sql: seedMigration },
  { id: "0003_satisfaction", sql: satisfactionMigration },
];

let ready: Promise<void> | null = null;

export function d1(): D1Database {
  if (!env.DB) throw new Error("D1 資料庫尚未設定（.openai/hosting.json 的 d1 需為 DB）");
  return env.DB;
}

function statements(sql: string) {
  return sql
    .split("\n").filter((line) => !line.trim().startsWith("--")).join("\n")
    .split(/;\s*\n/).map((part) => part.trim().replace(/;$/, "")).filter(Boolean);
}

export function ensureSchema() {
  ready ??= (async () => {
    const db = d1();
    await db.prepare("CREATE TABLE IF NOT EXISTS _migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)").run();
    const applied = new Set((await db.prepare("SELECT id FROM _migrations").all<{ id: string }>()).results.map((row) => row.id));
    for (const migration of migrations) {
      if (applied.has(migration.id)) continue;
      await db.batch([
        ...statements(migration.sql).map((statement) => db.prepare(statement)),
        db.prepare("INSERT INTO _migrations (id, applied_at) VALUES (?, ?)").bind(migration.id, nowIso()),
      ]);
    }
  })().catch((error) => { ready = null; throw error; });
  return ready;
}

export async function db() {
  await ensureSchema();
  return d1();
}

export function nowIso() {
  return new Date().toISOString();
}

export function today() {
  return nowIso().slice(0, 10);
}

export async function all<T>(sql: string, ...params: unknown[]) {
  return (await (await db()).prepare(sql).bind(...params).all<T>()).results;
}

export async function first<T>(sql: string, ...params: unknown[]) {
  return (await (await db()).prepare(sql).bind(...params).first<T>()) ?? null;
}

export async function run(sql: string, ...params: unknown[]) {
  return (await db()).prepare(sql).bind(...params).run();
}

/** Runs prepared statements in D1 batches (each batch is one transaction). */
export async function batch(items: { sql: string; params: unknown[] }[], size = 400) {
  const database = await db();
  for (let index = 0; index < items.length; index += size) {
    await database.batch(items.slice(index, index + size).map((item) => database.prepare(item.sql).bind(...item.params)));
  }
}

/** Allocates readable sequential codes such as TSK-2026-000123; safe under concurrent requests. */
export async function nextCodes(prefix: string, count: number) {
  if (count <= 0) return [];
  const year = today().slice(0, 4);
  const key = `${prefix}-${year}`;
  const row = await first<{ next_value: number }>(
    "INSERT INTO code_sequences (prefix, next_value) VALUES (?, ? + 1) ON CONFLICT(prefix) DO UPDATE SET next_value = next_value + ? RETURNING next_value",
    key, count, count,
  );
  const end = (row?.next_value ?? count + 1) - 1;
  return Array.from({ length: count }, (_, index) => `${key}-${String(end - count + 1 + index).padStart(6, "0")}`);
}

/** Bind a list as a single JSON parameter (D1 caps bound parameters per statement). */
export function jsonList(values: unknown[]) {
  return JSON.stringify(values);
}
