import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../src/config";
import { openDb } from "../src/db";
import { buildFetch } from "../src/app";

let workDir: string;
let dbPath: string;
let db: ReturnType<typeof openDb>;
let server: ReturnType<typeof Bun.serve>;
let base: string;

async function parseJson<T = Record<string, any>>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

async function createProject(name = "Test project") {
  const res = await fetch(`${base}/api/projects`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, description: "a", status: "active" }),
  });
  expect(res.status).toBe(201);
  return (await parseJson(res)).project;
}

async function createTask(overrides: Record<string, unknown> = {}) {
  const payload = {
    project_id: overrides.project_id ?? 1,
    title: "Task title",
    description: "desc",
    status: "todo",
    priority: "medium",
    ...overrides,
  };
  const res = await fetch(`${base}/api/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  expect(res.status).toBe(201);
  return (await parseJson(res)).task;
}

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), "bun-taskboard-test-"));
  dbPath = join(workDir, "taskboard.db");
  db = openDb(dbPath);
  server = Bun.serve({
    port: 0,
    fetch: buildFetch({
      config: { ...defaultConfig(), dbPath, port: 0, bind: "127.0.0.1", buildMarker: "test-marker" },
      db,
    }),
  });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  server.stop(true);
  db.close();
  rmSync(workDir, { recursive: true, force: true });
});

describe("health and readiness", () => {
  test("liveness is OK", async () => {
    const res = await fetch(`${base}/api/health/live`);
    expect(res.status).toBe(200);
    const body = await parseJson(res);
    expect(body.status).toBe("alive");
  });

  test("readiness is OK when database reachable", async () => {
    const res = await fetch(`${base}/api/health/ready`);
    expect(res.status).toBe(200);
    const body = await parseJson(res);
    expect(body.status).toBe("ready");
  });

  test("readiness fails when the database is unavailable", async () => {
    const blockedDir = join(workDir, "blocked");
    writeFileSync(blockedDir, "a regular file, not a directory");
    const blockedPath = join(blockedDir, "unreachable.db");

    expect(() => openDb(blockedPath)).toThrow();

    const ctx = {
      config: { ...defaultConfig(), dbPath: blockedPath, port: 0, bind: "127.0.0.1", buildMarker: "test-marker" },
      db: null,
    };
    const degraded = Bun.serve({ port: 0, fetch: buildFetch(ctx) });
    try {
      const baseUrl = `http://127.0.0.1:${degraded.port}`;
      const live = await fetch(`${baseUrl}/api/health/live`);
      expect(live.status).toBe(200);
      const ready = await fetch(`${baseUrl}/api/health/ready`);
      expect(ready.status).toBe(503);
      const readyBody = (await ready.json()) as { status: string };
      expect(readyBody.status).toBe("unavailable");
      const list = await fetch(`${baseUrl}/api/projects`);
      expect(list.status).toBe(503);
      const listBody = (await list.json()) as { error: string };
      expect(listBody.error).toBe("Service Unavailable");
    } finally {
      degraded.stop(true);
    }
  });

  test("meta exposes non-sensitive release marker", async () => {
    const res = await fetch(`${base}/api/meta`);
    expect(res.status).toBe(200);
    const body = await parseJson(res);
    expect(body.release).toBe("test-marker");
    expect(body.runtime.name).toBe("bun");
    expect(body.database.engine).toBe("sqlite");
  });
});

describe("static UI", () => {
  test("serves index.html at /", async () => {
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    expect((res.headers.get("content-type") ?? "").includes("text/html")).toBe(true);
    expect(await res.text()).toContain("Bun Taskboard");
  });

  test("serves client assets", async () => {
    const js = await fetch(`${base}/app.js`);
    expect(js.status).toBe(200);
    expect((js.headers.get("content-type") ?? "").includes("javascript")).toBe(true);
    const css = await fetch(`${base}/style.css`);
    expect(css.status).toBe(200);
  });

  test("unknown asset is 404", async () => {
    const res = await fetch(`${base}/nope.txt`);
    expect(res.status).toBe(404);
  });
});

describe("project CRUD with validation", () => {
  test("creates and lists projects", async () => {
    await createProject("CRUD alpha");
    const res = await fetch(`${base}/api/projects`);
    expect(res.status).toBe(200);
    const body = await parseJson(res);
    expect(body.projects.some((p: { name: string }) => p.name === "CRUD alpha")).toBe(true);
    const seeded = body.projects.find((p: { name: string }) => p.name === "Launch checklist");
    expect(seeded).toBeDefined();
    expect(typeof seeded.task_total).toBe("number");
  });

  test("reads a project with its tasks", async () => {
    const project = await createTask({});
    const res = await fetch(`${base}/api/projects/${project.project_id}`);
    expect(res.status).toBe(200);
    const body = await parseJson(res);
    expect(body.project.id).toBe(project.project_id);
    expect(body.tasks.some((t: { id: number }) => t.id === project.id)).toBe(true);
  });

  test("updates a project", async () => {
    const p = await createProject("rename-me");
    const res = await fetch(`${base}/api/projects/${p.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "renamed", status: "archived" }),
    });
    expect(res.status).toBe(200);
    const body = await parseJson(res);
    expect(body.project.name).toBe("renamed");
    expect(body.project.status).toBe("archived");
  });

  test("deletes a project and cascades its tasks", async () => {
    const p = await createProject("to-delete");
    const task = await createTask({ project_id: p.id, title: "cascade me" });
    const res = await fetch(`${base}/api/projects/${p.id}`, { method: "DELETE" });
    expect(res.status).toBe(204);
    const missing = await fetch(`${base}/api/projects/${p.id}`);
    expect(missing.status).toBe(404);
    const missingTask = await fetch(`${base}/api/tasks/${task.id}`);
    expect(missingTask.status).toBe(404);
  });

  test("rejects blank project name", async () => {
    const res = await fetch(`${base}/api/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "   ", status: "active" }),
    });
    expect(res.status).toBe(400);
    const body = await parseJson(res);
    expect(body.fields.name).toBeTruthy();
  });

  test("rejects over-long project name", async () => {
    const res = await fetch(`${base}/api/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "x".repeat(121) }),
    });
    expect(res.status).toBe(400);
  });

  test("rejects invalid project status", async () => {
    const res = await fetch(`${base}/api/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "ok", status: "warp" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("task CRUD with validation", () => {
  test("creates, reads, lists tasks", async () => {
    const task = await createTask({ title: "first task", status: "done", priority: "high" });
    expect(task.title).toBe("first task");
    const got = await fetch(`${base}/api/tasks/${task.id}`);
    expect(got.status).toBe(200);
    const body = await parseJson(got);
    expect(body.task.id).toBe(task.id);
    const list = await fetch(`${base}/api/tasks?project_id=1`);
    const listed = await parseJson(list);
    expect(listed.tasks.some((t: { id: number }) => t.id === task.id)).toBe(true);
  });

  test("updates a task", async () => {
    const task = await createTask({ title: "before" });
    const res = await fetch(`${base}/api/tasks/${task.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "after", status: "in_progress", priority: "high" }),
    });
    expect(res.status).toBe(200);
    const body = await parseJson(res);
    expect(body.task.title).toBe("after");
    expect(body.task.status).toBe("in_progress");
    expect(body.task.priority).toBe("high");
  });

  test("deletes a task", async () => {
    const task = await createTask({ title: "to-remove" });
    const res = await fetch(`${base}/api/tasks/${task.id}`, { method: "DELETE" });
    expect(res.status).toBe(204);
    const gone = await fetch(`${base}/api/tasks/${task.id}`);
    expect(gone.status).toBe(404);
  });

  test("rejects blank task title", async () => {
    const res = await fetch(`${base}/api/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project_id: 1, title: " \t ", status: "todo" }),
    });
    expect(res.status).toBe(400);
    const body = await parseJson(res);
    expect(body.fields.title).toBeTruthy();
  });

  test("rejects non-string task title", async () => {
    const res = await fetch(`${base}/api/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project_id: 1, title: 42 }),
    });
    expect(res.status).toBe(400);
  });

  test("rejects over-long task title", async () => {
    const res = await fetch(`${base}/api/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project_id: 1, title: "x".repeat(201) }),
    });
    expect(res.status).toBe(400);
    const body = await parseJson(res);
    expect(body.fields.title).toBeTruthy();
  });

  test("rejects invalid status and priority", async () => {
    const badStatus = await fetch(`${base}/api/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project_id: 1, title: "x", status: "warp" }),
    });
    expect(badStatus.status).toBe(400);
    const badPriority = await fetch(`${base}/api/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project_id: 1, title: "x", priority: "urgent" }),
    });
    expect(badPriority.status).toBe(400);
  });

  test("rejects missing or nonexistent project_id", async () => {
    const missing = await fetch(`${base}/api/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "x" }),
    });
    expect(missing.status).toBe(400);
    const none = await fetch(`${base}/api/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project_id: 999999, title: "x" }),
    });
    expect(none.status).toBe(400);
    const body = await parseJson(none);
    expect(body.fields.project_id).toBeTruthy();
  });

  test("rejects malformed JSON and non-object bodies", async () => {
    const badJson = await fetch(`${base}/api/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    expect(badJson.status).toBe(400);
    const arrayBody = await fetch(`${base}/api/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "[1,2,3]",
    });
    expect(arrayBody.status).toBe(400);
  });

  test("rejects empty PATCH body", async () => {
    const task = await createTask({ title: "stable" });
    const res = await fetch(`${base}/api/tasks/${task.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});

describe("not found handling", () => {
  test("unknown project and task ids return 404", async () => {
    expect((await fetch(`${base}/api/projects/999999`)).status).toBe(404);
    expect((await fetch(`${base}/api/tasks/999999`)).status).toBe(404);
    expect((await fetch(`${base}/api/projects/999999`, { method: "PATCH", body: "{}" })).status).toBe(404);
    expect((await fetch(`${base}/api/tasks/999999`, { method: "PATCH", body: "{}" })).status).toBe(404);
    expect((await fetch(`${base}/api/projects/999999`, { method: "DELETE" })).status).toBe(404);
    expect((await fetch(`${base}/api/tasks/999999`, { method: "DELETE" })).status).toBe(404);
    expect((await fetch(`${base}/api/unknown`)).status).toBe(404);
  });

  test("invalid method returns 404 with a JSON body", async () => {
    const res = await fetch(`${base}/api/tasks`, { method: "PUT" });
    expect(res.status).toBe(404);
    const body = await parseJson(res);
    expect(body.error).toBe("Not found");
  });
});

describe("search and filter", () => {
  test("searches titles and descriptions", async () => {
    await createTask({ title: "Hiring pipeline review", description: "schedule interviews" });
    await createTask({ title: "Fix checkout bug", description: "nothing here" });
    const res = await fetch(`${base}/api/tasks?q=Hiring`);
    const body = await parseJson(res);
    expect(body.tasks.some((t: { title: string }) => t.title === "Hiring pipeline review")).toBe(true);
    expect(body.tasks.some((t: { title: string }) => t.title === "Fix checkout bug")).toBe(false);
    const desc = await fetch(`${base}/api/tasks?q=interviews`);
    const descBody = await parseJson(desc);
    expect(descBody.tasks.some((t: { title: string }) => t.title === "Hiring pipeline review")).toBe(true);
  });

  test("escapes LIKE wildcards in queries", async () => {
    await createTask({ title: "100% done milestone", description: "" });
    const res = await fetch(`${base}/api/tasks?q=${encodeURIComponent("%")}`);
    const body = await parseJson(res);
    expect(body.tasks.some((t: { title: string }) => t.title === "100% done milestone")).toBe(true);
    expect(body.tasks.length).toBeGreaterThan(0);
    expect(body.tasks.every((t: { title: string }) => !t.title.includes("Hiring"))).toBe(true);
  });

  test("filters by status and priority and combines them", async () => {
    await createTask({ title: "status done one", status: "done", priority: "high" });
    await createTask({ title: "status in_progress one", status: "in_progress", priority: "high" });
    const done = await parseJson(await fetch(`${base}/api/tasks?status=done`));
    expect(done.tasks.every((t: { status: string }) => t.status === "done")).toBe(true);
    expect(done.tasks.some((t: { title: string }) => t.title === "status done one")).toBe(true);
    const highDone = await parseJson(
      await fetch(`${base}/api/tasks?status=done&priority=high&q=status`),
    );
    expect(highDone.tasks.length).toBe(1);
    expect(highDone.tasks[0].title).toBe("status done one");
  });

  test("rejects an invalid status filter", async () => {
    const res = await fetch(`${base}/api/tasks?status=warp`);
    expect(res.status).toBe(400);
  });
});

describe("schema, seed, and persistence", () => {
  test("seed data is idempotent across database opens", () => {
    const fresh = openDb(dbPath);
    const counts = {
      projects: Number((fresh.query("SELECT COUNT(*) AS n FROM project").get() as { n: number }).n),
      tasks: Number((fresh.query("SELECT COUNT(*) AS n FROM task").get() as { n: number }).n),
    };
    fresh.close();
    expect(counts.projects).toBeGreaterThanOrEqual(3);
    const second = openDb(dbPath);
    const counts2 = {
      projects: Number((second.query("SELECT COUNT(*) AS n FROM project").get() as { n: number }).n),
      tasks: Number((second.query("SELECT COUNT(*) AS n FROM task").get() as { n: number }).n),
    };
    second.close();
    expect(counts2).toEqual(counts);
  });

  test("migrate is idempotent", async () => {
    const fresh = openDb(dbPath);
    fresh.exec(
      `INSERT INTO project (name, description, status)
       VALUES ('persist target', 'proves restart persistence', 'active')`,
    );
    const projId = Number((fresh.query("SELECT last_insert_rowid() AS id").get() as { id: number }).id);
    fresh.close();

    const reopened = openDb(dbPath); // runs migrate + seed again on the same file
    const row = reopened.query("SELECT * FROM project WHERE id = ?").get(projId);
    reopened.close();
    expect(row).toBeTruthy();
    expect((row as { name: string }).name).toBe("persist target");
  });

  test("records survive a fresh connection on the same storage", () => {
    const db2 = openDb(dbPath);
    const row = db2.query("SELECT name FROM project WHERE description = 'proves restart persistence'").get();
    db2.close();
    expect(row).toBeTruthy();
  });

  test("database grows a non-empty file on disk", () => {
    expect(existsSync(dbPath)).toBe(true);
    expect(statSync(dbPath).size).toBeGreaterThan(0);
  });
});