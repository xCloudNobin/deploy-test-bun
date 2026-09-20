import { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { join, normalize, resolve } from "node:path";
import {
  PRIORITIES,
  PROJECT_STATUSES,
  TASK_STATUSES,
  probeDb,
  type Priority,
  type ProjectStatus,
  type TaskStatus,
} from "./db.ts";
import { ROOT, resolveDbPath, type Config } from "./config.ts";

const PUBLIC_DIR = join(ROOT, "public");

export interface AppContext {
  config: Config;
  db: Database | null;
}

type BunServer = ReturnType<typeof Bun.serve>;

class ServiceUnavailable extends Error {}

function requireDb(ctx: AppContext): Database {
  if (!ctx.db) throw new ServiceUnavailable("database unavailable");
  return ctx.db;
}

export function buildFetch(ctx: AppContext): (req: Request, server: BunServer) => Promise<Response> {
  return async (req: Request, server: BunServer) => {
    try {
      const url = new URL(req.url);
      const path = url.pathname;

      if (path.startsWith("/api/")) {
        return await handleApi(ctx, req, url, path);
      }

      if (req.method !== "GET" && req.method !== "HEAD") {
        return new Response("Method Not Allowed", { status: 405 });
      }
      return serveStatic(path);
    } catch (err) {
      const message = err instanceof Error ? err.message : "internal error";
      // eslint-disable-next-line no-console
      console.error("[taskboard] request failed:", message);
      return json({ error: "Internal Server Error" }, 500);
    }
  };
}

// ---------------------------------------------------------------------------
// JSON + static helpers

function json(body: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...extraHeaders },
  });
}

function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
};

function safeResolve(base: string, target: string): string | null {
  const joined = resolve(base, "." + normalize(target));
  const prefix = base.endsWith("/") ? base : base + "/";
  if (joined !== base && !joined.startsWith(prefix)) return null;
  return joined;
}

function serveStatic(path: string): Response {
  const rel = path === "/" ? "/index.html" : path;
  const file = safeResolve(PUBLIC_DIR, rel);
  if (!file || !existsSync(file)) {
    return html("<!doctype html><meta charset=\"utf-8\"><title>Not found</title><h1>404 Not Found</h1>", 404);
  }
  const data = readFileSync(file);
  const mime = MIME[file.slice(file.lastIndexOf("."))] ?? "application/octet-stream";
  return new Response(data, { headers: { "content-type": mime } });
}

// ---------------------------------------------------------------------------
// API

type Handler = (ctx: AppContext, req: Request, url: URL) => Promise<Response>;

interface Route {
  method: string;
  pattern: RegExp;
  handler: Handler;
}

function capture<T extends Record<string, unknown>>(body: unknown): T {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new BadRequest("Request body must be a JSON object");
  }
  return body as T;
}

class BadRequest extends Error {
  fields: Record<string, string>;
  constructor(message: string, fields: Record<string, string> = {}) {
    super(message);
    this.fields = fields;
  }
}

async function readJson(req: Request): Promise<Record<string, unknown>> {
  const raw = await req.text();
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new BadRequest("Request body is not valid JSON");
  }
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new BadRequest("Field must be a string");
  return value;
}

function parseStatus(value: unknown): TaskStatus {
  if (value === undefined || value === null || value === "") return "todo";
  if (!TASK_STATUSES.includes(value as TaskStatus)) {
    throw new BadRequest(`Status must be one of: ${TASK_STATUSES.join(", ")}`);
  }
  return value as TaskStatus;
}

function parsePriority(value: unknown): Priority {
  if (value === undefined || value === null || value === "") return "medium";
  if (!PRIORITIES.includes(value as Priority)) {
    throw new BadRequest(`Priority must be one of: ${PRIORITIES.join(", ")}`);
  }
  return value as Priority;
}

function parseProjectStatus(value: unknown): ProjectStatus {
  if (value === undefined || value === null || value === "") return "active";
  if (!PROJECT_STATUSES.includes(value as ProjectStatus)) {
    throw new BadRequest(`Project status must be one of: ${PROJECT_STATUSES.join(", ")}`);
  }
  return value as ProjectStatus;
}

function parseId(raw: string): number {
  const id = Number(raw);
  if (!Number.isInteger(id) || id < 1) throw new BadRequest("Invalid identifier");
  return id;
}

const TITLE_MAX = 200;
const DESCRIPTION_MAX = 2000;
const NAME_MAX = 120;

interface TaskInput {
  project_id: number;
  title: string;
  description: string;
  status: TaskStatus;
  priority: Priority;
}

function validateTaskInput(body: Record<string, unknown>, requireProject: boolean): TaskInput {
  const fields: Record<string, string> = {};
  const projectValue = body.project_id;
  let projectId = 0;
  if (projectValue === undefined || projectValue === null) {
    if (requireProject) fields.project_id = "project_id is required";
  } else {
    if (typeof projectValue !== "number" || !Number.isInteger(projectValue) || projectValue < 1) {
      fields.project_id = "project_id must be a positive integer";
    } else projectId = projectValue;
  }

  const titleValue = body.title;
  let title = "";
  if (typeof titleValue !== "string" || titleValue.trim() === "") {
    if (typeof titleValue === "string") {
      fields.title = "title is required and must not be blank";
    } else {
      fields.title = "title is required and must be a string";
    }
  } else {
    title = titleValue.trim();
    if (title.length > TITLE_MAX) fields.title = `title must be ${TITLE_MAX} characters or fewer`;
  }

  let description = "";
  const descriptionValue = optionalString(body.description);
  if (descriptionValue !== undefined) {
    description = descriptionValue.trim();
    if (description.length > DESCRIPTION_MAX) {
      fields.description = `description must be ${DESCRIPTION_MAX} characters or fewer`;
    }
  }

  let status: TaskStatus = "todo";
  let priority: Priority = "medium";
  try {
    status = parseStatus(body.status);
    priority = parsePriority(body.priority);
  } catch (err) {
    if (err instanceof BadRequest) fields.status = err.message;
    else throw err;
  }

  if (Object.keys(fields).length > 0) throw new BadRequest("Validation failed", fields);

  if (requireProject && !projectId) {
    throw new BadRequest("Validation failed", { project_id: "project_id is required" });
  }

  return { project_id: projectId, title, description, status, priority };
}

interface ProjectInput {
  name: string;
  description: string;
  status: ProjectStatus;
}

function validateProjectInput(body: Record<string, unknown>): ProjectInput {
  const fields: Record<string, string> = {};
  const nameValue = body.name;
  let name = "";
  if (typeof nameValue !== "string" || nameValue.trim() === "") {
    fields.name =
      typeof nameValue === "string" ? "name is required and must not be blank" : "name is required and must be a string";
  } else {
    name = nameValue.trim();
    if (name.length > NAME_MAX) fields.name = `name must be ${NAME_MAX} characters or fewer`;
  }

  let description = "";
  const descriptionValue = optionalString(body.description);
  if (descriptionValue !== undefined) {
    description = descriptionValue.trim();
    if (description.length > DESCRIPTION_MAX) {
      fields.description = `description must be ${DESCRIPTION_MAX} characters or fewer`;
    }
  }

  let status: ProjectStatus = "active";
  try {
    status = parseProjectStatus(body.status);
  } catch (err) {
    if (err instanceof BadRequest) fields.status = err.message;
    else throw err;
  }

  if (Object.keys(fields).length > 0) throw new BadRequest("Validation failed", fields);
  return { name, description, status };
}

interface TaskRow {
  id: number;
  project_id: number;
  project_name: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: Priority;
  created_at: string;
  updated_at: string;
}

interface ProjectRow {
  id: number;
  name: string;
  description: string;
  status: ProjectStatus;
  created_at: string;
  updated_at: string;
}

async function handleApi(ctx: AppContext, req: Request, url: URL, path: string): Promise<Response> {
  const method = req.method;
  const route = findRoute(method, path);
  if (!route) {
    if (path.startsWith("/api") && method === "OPTIONS") return new Response("", { status: 204 });
    return json({ error: "Not found" }, 404);
  }
  try {
    return await route.handler(ctx, req, url);
  } catch (err) {
    if (err instanceof BadRequest) {
      return json({ error: err.message, ...(Object.keys(err.fields).length ? { fields: err.fields } : {}) }, 400);
    }
    if (err instanceof ServiceUnavailable) {
      return json({ error: "Service Unavailable", db: "unavailable" }, 503);
    }
    throw err;
  }
}

function findRoute(method: string, path: string): Route | null {
  for (const route of ROUTES) {
    if (route.method === method && route.pattern.test(path)) return route;
  }
  return null;
}

const ROUTES: Route[] = [
  {
    method: "GET",
    pattern: /^\/api\/health\/live\/?$/,
    handler: async () => json({ status: "alive", timestamp: new Date().toISOString() }),
  },
  {
    method: "GET",
    pattern: /^\/api\/health\/ready\/?$/,
    handler: async (ctx) => {
      const probe = probeDb(ctx.config.dbPath);
      if (probe.ok) return json({ status: "ready", db: "sqlite", checked_at: probe.detail || null });
      return json({ status: "unavailable", db: "sqlite", detail: probe.detail }, 503);
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/meta\/?$/,
    handler: async (ctx) =>
      json({
        name: "deploy-test-bun",
        description: "Native Bun taskboard (no web framework): SQLite persistence, validated CRUD, search/filter.",
        release: ctx.config.buildMarker,
        runtime: { name: "bun", version: Bun.version },
        database: { engine: "sqlite", path: ctx.config.dbPath },
      }),
  },
  {
    method: "GET",
    pattern: /^\/api\/projects\/?$/,
    handler: async (ctx) => {
      const db = requireDb(ctx);
      const rows = db
        .query(
          `SELECT p.id, p.name, p.description, p.status, p.created_at, p.updated_at,
                  COUNT(t.id) AS task_total,
                  SUM(CASE WHEN t.status = 'todo' THEN 1 ELSE 0 END) AS todo,
                  SUM(CASE WHEN t.status = 'in_progress' THEN 1 ELSE 0 END) AS in_progress,
                  SUM(CASE WHEN t.status = 'done' THEN 1 ELSE 0 END) AS done
             FROM project p LEFT JOIN task t ON t.project_id = p.id
            GROUP BY p.id ORDER BY p.id ASC`,
        )
        .all() as Array<Record<string, unknown>>;
      return json({ projects: rows.map((r) => ({ ...r, task_total: Number(r.task_total) ?? 0, todo: Number(r.todo) ?? 0, in_progress: Number(r.in_progress) ?? 0, done: Number(r.done) ?? 0 })) });
    },
  },
  {
    method: "POST",
    pattern: /^\/api\/projects\/?$/,
    handler: async (ctx, req) => {
      const db = requireDb(ctx);
      const input = validateProjectInput(capture(await readJson(req)));
      const res = db
        .query("INSERT INTO project (name, description, status) VALUES (?, ?, ?)")
        .run(input.name, input.description, input.status);
      const project = getProject(db, Number(res.lastInsertRowid));
      return json({ project }, 201);
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/projects\/\d+\/?$/,
    handler: async (ctx, _req, url) => {
      const db = requireDb(ctx);
      const id = parseProjectIdFromUrl(url);
      const project = getProject(db, id);
      if (!project) return json({ error: "Project not found" }, 404);
      const tasks = db
        .query("SELECT * FROM task WHERE project_id = ? ORDER BY id DESC")
        .all(id) as TaskRow[];
      return json({ project, tasks });
    },
  },
  {
    method: "PATCH",
    pattern: /^\/api\/projects\/\d+\/?$/,
    handler: async (ctx, req, url) => {
      const db = requireDb(ctx);
      const id = parseProjectIdFromUrl(url);
      if (!getProject(db, id)) return json({ error: "Project not found" }, 404);
      const body = capture(await readJson(req));
      const merged: Record<string, unknown> = {};
      const current = getProject(db, id)!;
      if (body.name === undefined && body.description === undefined && body.status === undefined) {
        throw new BadRequest("Nothing to update: provide at least one of name, description, status");
      }
      merged.name = body.name ?? current.name;
      merged.description = body.description ?? current.description;
      merged.status = body.status ?? current.status;
      const input = validateProjectInput(merged);
      db
        .query("UPDATE project SET name = ?, description = ?, status = ?, updated_at = datetime('now') WHERE id = ?")
        .run(input.name, input.description, input.status, id);
      return json({ project: getProject(db, id) });
    },
  },
  {
    method: "DELETE",
    pattern: /^\/api\/projects\/\d+\/?$/,
    handler: async (ctx, _req, url) => {
      const db = requireDb(ctx);
      const id = parseProjectIdFromUrl(url);
      const res = db.query("DELETE FROM project WHERE id = ?").run(id);
      if (Number(res.changes) === 0) return json({ error: "Project not found" }, 404);
      return new Response("", { status: 204 });
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/tasks\/?$/,
    handler: async (ctx, _req, url) => {
      const db = requireDb(ctx);
      const params = url.searchParams;
      const q = params.get("q")?.trim() ?? "";
      const status = params.get("status")?.trim() || null;
      const priority = params.get("priority")?.trim() || null;
      const projectRaw = params.get("project_id")?.trim() || null;
      const projectId = projectRaw === null || projectRaw === "" ? null : parseId(projectRaw);

      if (status !== null && !TASK_STATUSES.includes(status as TaskStatus)) {
        throw new BadRequest(`status filter must be one of: ${TASK_STATUSES.join(", ")}`);
      }
      if (priority !== null && !PRIORITIES.includes(priority as Priority)) {
        throw new BadRequest(`priority filter must be one of: ${PRIORITIES.join(", ")}`);
      }

      const like = q ? `%${q.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_")}%` : null;

      const tasks = db
        .query(
          `SELECT t.id, t.project_id, p.name AS project_name, t.title, t.description,
                  t.status, t.priority, t.created_at, t.updated_at
             FROM task t JOIN project p ON p.id = t.project_id
            WHERE (($project IS NULL) OR t.project_id = $project)
              AND (($status IS NULL) OR t.status = $status)
              AND (($priority IS NULL) OR t.priority = $priority)
              AND (($q IS NULL) OR t.title LIKE $q ESCAPE '\\' OR t.description LIKE $q ESCAPE '\\')
            ORDER BY t.id DESC`,
        )
        .all({ $project: projectId, $status: status, $priority: priority, $q: like }) as TaskRow[];

      return json({ tasks, count: tasks.length, query: { q, status, priority, project_id: projectId } });
    },
  },
  {
    method: "POST",
    pattern: /^\/api\/tasks\/?$/,
    handler: async (ctx, req) => {
      const db = requireDb(ctx);
      const body = capture(await readJson(req));
      const input = validateTaskInput(body, true);
      if (!getProject(db, input.project_id)) {
        throw new BadRequest("project_id does not exist", { project_id: "no project with that id" });
      }
      const res = db
        .query(
          "INSERT INTO task (project_id, title, description, status, priority) VALUES (?, ?, ?, ?, ?)",
        )
        .run(input.project_id, input.title, input.description, input.status, input.priority);
      const task = getTask(db, Number(res.lastInsertRowid));
      return json({ task }, 201);
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/tasks\/\d+\/?$/,
    handler: async (ctx, _req, url) => {
      const db = requireDb(ctx);
      const id = parseTaskIdFromUrl(url);
      const task = getTask(db, id);
      if (!task) return json({ error: "Task not found" }, 404);
      return json({ task });
    },
  },
  {
    method: "PATCH",
    pattern: /^\/api\/tasks\/\d+\/?$/,
    handler: async (ctx, req, url) => {
      const db = requireDb(ctx);
      const id = parseTaskIdFromUrl(url);
      const current = getTask(db, id);
      if (!current) return json({ error: "Task not found" }, 404);
      const body = capture(await readJson(req));
      const keys = ["title", "description", "status", "priority", "project_id"];
      if (!keys.some((k) => body[k] !== undefined)) {
        throw new BadRequest("Nothing to update: provide at least one of title, description, status, priority");
      }
      const merged: Record<string, unknown> = {};
      if (body.title !== undefined) merged.title = body.title;
      if (body.description !== undefined) merged.description = body.description;
      if (body.status !== undefined) merged.status = body.status;
      if (body.priority !== undefined) merged.priority = body.priority;
      if (body.project_id !== undefined) merged.project_id = body.project_id;
      const input = validateTaskInput(merged, false);
      if (input.project_id && !getProject(db, input.project_id)) {
        throw new BadRequest("project_id does not exist", { project_id: "no project with that id" });
      }
      if (!input.project_id) input.project_id = current.project_id;
      db
        .query(
          `UPDATE task SET project_id = ?, title = ?, description = ?, status = ?, priority = ?,
                  updated_at = datetime('now') WHERE id = ?`,
        )
        .run(input.project_id, input.title, input.description, input.status, input.priority, id);
      return json({ task: getTask(db, id) });
    },
  },
  {
    method: "DELETE",
    pattern: /^\/api\/tasks\/\d+\/?$/,
    handler: async (ctx, _req, url) => {
      const db = requireDb(ctx);
      const id = parseTaskIdFromUrl(url);
      const res = db.query("DELETE FROM task WHERE id = ?").run(id);
      if (Number(res.changes) === 0) return json({ error: "Task not found" }, 404);
      return new Response("", { status: 204 });
    },
  },
];

function getProject(db: Database, id: number): ProjectRow | null {
  const row = db.query("SELECT * FROM project WHERE id = ?").get(id);
  return row ? (row as ProjectRow) : null;
}

function getTask(db: Database, id: number): TaskRow | null {
  const row = db
    .query(
      `SELECT t.id, t.project_id, p.name AS project_name, t.title, t.description,
              t.status, t.priority, t.created_at, t.updated_at
         FROM task t JOIN project p ON p.id = t.project_id WHERE t.id = ?`,
    )
    .get(id);
  return row ? (row as TaskRow) : null;
}

function parseProjectIdFromUrl(url: URL): number {
  const m = url.pathname.match(/^\/api\/projects\/(\d+)/);
  if (!m) throw new BadRequest("Invalid project id");
  return parseId(m[1]);
}

function parseTaskIdFromUrl(url: URL): number {
  const m = url.pathname.match(/^\/api\/tasks\/(\d+)/);
  if (!m) throw new BadRequest("Invalid task id");
  return parseId(m[1]);
}