# Verification record

Bun (native) taskboard — xCloud app-compatibility fixture.

## Candidate commit

- Commit SHA: `pending` (filled by the PR head)
- Branch/PR: `feat/compatibility-bun` (PR pending reviewer)
- Repository: `xCloudNobin/deploy-test-bun`

## Environment

- Date: 2026-09-20 (UTC)
- Bun: 1.3.12
- SQLite: via `bun:sqlite` (bundled with Bun)
- Database: SQLite file on a persistent path on the same host.
- Category: Bun (native HTTP server) application deployment.
- Build method: `scripts/build.sh` → `VERSION` marker + `dist/server.js`;
  production start `bun dist/server.js`.

## Local verification (`scripts/verify.sh`)

`scripts/verify.sh` runs each step below and aborts on any failure. Full local
run executed on 2026-09-20 with every step passing (exit 0):

1. `scripts/build.sh` — release marker and production bundle written.
2. Clean install — `rm -rf node_modules && bun install --frozen-lockfile`.
3. `tsc --noEmit` strict typecheck — clean.
4. Client bundle syntax check — clean.
5. `bun test` — **34 passed, 0 failed** (CRUD, search/filter, LIKE-wildcard
   escaping, validation negatives: blank/over-long/mistyped fields, invalid
   status/priority, malformed JSON, missing/nonexistent `project_id`, empty
   PATCH, unknown 404s; schema/seed idempotency; restart-style persistence;
   database-unavailable readiness).
6. `scripts/smoke.sh` — real production process (`bun dist/server.js`),
   **50 passed / 0 failed**:
   - liveness `/api/health/live` 200 and readiness `/api/health/ready` 200
     with a real DB write probe;
   - release marker served by `/api/meta` and runtime reported as Bun;
   - UI `/`, `app.js`, `style.css` served; unknown static/API → 404;
   - project/task create/read/update/delete over HTTP;
   - search `q` (includes matching, excludes non-matching) and status filter;
   - negative cases: blank title, missing `project_id`, invalid status and
     priority, malformed JSON, blank project name, invalid project status,
     empty PATCH (all 400 with field errors), unknown resources (404),
     unhandled method (404);
   - idempotent seed present on a fresh database;
   - graceful SIGTERM stop → restart on the **same SQLite path** → persistence
     survivor task still served, task counts stable across restart;
   - database-unavailable phase: `/api/health/live` 200 while
     `/api/health/ready` returns **503** with `status:"unavailable"` and API
     list routes degrade to 503 (no stack traces); static UI still served.

## Limitations

- Local verification only. Live xCloud category deployment and external
  qualification are **not** claimed; status stays `local-verified` until then.
- No cookie-authenticated sessions, so CSRF does not apply; the JSON API is
  same-origin and output is escaped client-side (`textContent` only, no
  `innerHTML` with user data).
- SQLite is a reasonable default; redeploys must mount a persistent volume at
  `DATA_DIR`/`DATABASE_PATH` (or inject an external database path).
- Demo fixtures hold no sensitive data; `.env.example` uses only placeholders.

## Evidence chain

Command run at the candidate commit: `scripts/verify.sh` (exit 0). Smoke
summary line:
`=== Bun smoke summary: 50 passed, 0 failed ===`
Test summary line: `34 pass, 0 fail` from `bun test`.