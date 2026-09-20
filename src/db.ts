import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const TASK_STATUSES = ["todo", "in_progress", "done"] as const;
export const PRIORITIES = ["low", "medium", "high"] as const;
export const PROJECT_STATUSES = ["active", "archived"] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];
export type Priority = (typeof PRIORITIES)[number];
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS project (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'active'
              CHECK (status IN ('active', 'archived')),
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS task (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id  INTEGER NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'todo'
              CHECK (status IN ('todo', 'in_progress', 'done')),
  priority    TEXT NOT NULL DEFAULT 'medium'
              CHECK (priority IN ('low', 'medium', 'high')),
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_task_project ON task(project_id, status);
CREATE INDEX IF NOT EXISTS idx_task_status ON task(status);

CREATE TABLE IF NOT EXISTS seed_flag (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  seeded_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS heartbeat (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  checked_at  TEXT NOT NULL
);
`;

const SEED_PROJECTS = [
  { name: "Launch checklist", description: "Demo project created by the idempotent seeder." },
  { name: "Support triage", description: "Second demo board, also created once." },
] as const;

const SEED_TASKS = [
  { project: 0, title: "Write the launch blurb", status: "done", priority: "high" },
  { project: 0, title: "Schedule demo for the team", status: "in_progress", priority: "medium" },
  { project: 0, title: "Prepare rollback notes", status: "todo", priority: "low" },
  { project: 1, title: "Reproduce reported bug #42", status: "in_progress", priority: "high" },
] as const;

export interface SeedResult {
  seeded: boolean;
  projects: number;
  tasks: number;
}

export function openDb(path: string): Database {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  migrate(db);
  const seedResult = seed(db);
  // eslint-disable-next-line no-console
  console.log(
    `[taskboard] sqlite ready ${path} (seeded=${seedResult.seeded} projects=${seedResult.projects} tasks=${seedResult.tasks})`,
  );
  return db;
}

export function migrate(db: Database): void {
  db.exec(SCHEMA);
}

export function seed(db: Database): SeedResult {
  const flag = db.query("SELECT seeded_at FROM seed_flag WHERE id = 1").get();
  if (flag !== null) {
    const projects = (db.query("SELECT COUNT(*) AS n FROM project").get() as { n: number }).n;
    const tasks = (db.query("SELECT COUNT(*) AS n FROM task").get() as { n: number }).n;
    return { seeded: false, projects, tasks };
  }

  const apply = db.transaction(() => {
    const insertProject = db.query(
      "INSERT INTO project (name, description, status) VALUES (?, ?, 'active')",
    );
    const insertTask = db.query(
      "INSERT INTO task (project_id, title, description, status, priority) VALUES (?, ?, '', ?, ?)",
    );
    const projectIds: number[] = [];
    for (const p of SEED_PROJECTS) {
      const res = insertProject.run(p.name, p.description);
      projectIds.push(Number(res.lastInsertRowid));
    }
    for (const t of SEED_TASKS) {
      insertTask.run(projectIds[t.project], t.title, t.status, t.priority);
    }
    db.query("REPLACE INTO seed_flag (id, seeded_at) VALUES (1, datetime('now'))").run();
  });
  apply();

  return {
    seeded: true,
    projects: SEED_PROJECTS.length,
    tasks: SEED_TASKS.length,
  };
}

export interface ProbeResult {
  ok: boolean;
  detail: string;
}

export function probeDb(dbPath: string): ProbeResult {
  let db: Database;
  try {
    db = new Database(dbPath);
  } catch (err) {
    return { ok: false, detail: errorMessage(err, `cannot open database at ${dbPath}`) };
  }
  try {
    db.exec("PRAGMA foreign_keys = ON;");
    db.query("INSERT OR REPLACE INTO heartbeat (id, checked_at) VALUES (1, datetime('now'))").run();
    const row = db.query("SELECT checked_at FROM heartbeat WHERE id = 1").get();
    return { ok: true, detail: row ? String((row as { checked_at: string }).checked_at) : "" };
  } catch (err) {
    return { ok: false, detail: errorMessage(err, "database probe failed") };
  } finally {
    db.close();
  }
}

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

export function countRows(db: Database, table: "project" | "task"): number {
  return (db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}