/* Native Bun taskboard client. Pure DOM rendering (no innerHTML with user
 * data) so task titles/descriptions are never interpreted as HTML. */

const RELEASE_EL = document.getElementById("release");
const HEALTH_EL = document.getElementById("health");
const PROJECT_FORM = document.getElementById("project-form");
const PROJECT_ERROR = document.getElementById("project-error");
const PROJECT_SELECT = document.getElementById("project-select");
const TASK_FORM = document.getElementById("task-form");
const TASK_ERROR = document.getElementById("task-error");
const SEARCH = document.getElementById("search");
const FILTER_STATUS = document.getElementById("filter-status");
const FILTER_PRIORITY = document.getElementById("filter-priority");
const TASK_LIST = document.getElementById("task-list");
const TASK_COUNT = document.getElementById("task-count");
const TASK_EMPTY = document.getElementById("task-empty");
const TEMPLATE = document.getElementById("task-template");

let activeProject = 0;
let projects = [];
let tasks = [];

async function api(path, options) {
  const res = await fetch(path, {
    headers: options && options.body ? { "content-type": "application/json" } : undefined,
    ...options,
  });
  let body = null;
  const text = await res.text();
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }
  return { res, body };
}

function showError(el, message) {
  el.textContent = message;
  el.hidden = !message;
}

function formatError(body) {
  if (!body) return "Request failed.";
  if (body.error && body.fields) {
    return `${body.error}: ${Object.values(body.fields).join("; ")}`;
  }
  return body.error || "Request failed.";
}

async function loadMeta() {
  const { res, body } = await api("/api/meta");
  if (res.ok && body) {
    RELEASE_EL.textContent = `release ${body.release} · bun ${body.runtime.version}`;
    document.title = `Bun Taskboard · ${body.release}`;
  }
  const health = await api("/api/health/ready");
  if (health.res.ok) {
    HEALTH_EL.textContent = "ready";
    HEALTH_EL.classList.add("ok");
  } else {
    HEALTH_EL.textContent = "db unavailable";
    HEALTH_EL.classList.add("bad");
  }
  setTimeout(loadMeta, 5000);
}

async function refreshProjects() {
  const { res, body } = await api("/api/projects");
  if (!res.ok) {
    showError(PROJECT_ERROR, "Could not load projects.");
    return;
  }
  projects = body.projects;
  const previous = PROJECT_SELECT.value;
  PROJECT_SELECT.length = 0;
  for (const p of projects) {
    const opt = document.createElement("option");
    opt.value = String(p.id);
    opt.textContent = `${p.name} (${p.todo + p.in_progress + p.done} tasks)`;
    PROJECT_SELECT.appendChild(opt);
  }
  let value = previous && projects.some((p) => String(p.id) === previous) ? previous : null;
  if (!value && projects.length) value = String(projects[0].id);
  if (!value) {
    activeProject = 0;
    PROJECT_SELECT.length = 0;
  } else {
    PROJECT_SELECT.value = value;
    activeProject = Number(value);
  }
  refreshTasks();
}

function currentFilters() {
  const params = new URLSearchParams();
  if (activeProject) params.set("project_id", String(activeProject));
  const q = SEARCH.value.trim();
  if (q) params.set("q", q);
  const status = FILTER_STATUS.value;
  if (status) params.set("status", status);
  const priority = FILTER_PRIORITY.value;
  if (priority) params.set("priority", priority);
  return params;
}

async function refreshTasks() {
  if (!activeProject) {
    while (TASK_LIST.firstChild) TASK_LIST.firstChild.remove();
    TASK_COUNT.textContent = "";
    TASK_EMPTY.hidden = false;
    TASK_EMPTY.textContent = projects.length ? "Select a project to see its tasks." : "Create a project to get started.";
    return;
  }
  const params = currentFilters();
  const { res, body } = await api(`/api/tasks?${params}`);
  if (!res.ok) {
    showError(TASK_ERROR, "Could not load tasks.");
    return;
  }
  tasks = body.tasks;
  TASK_COUNT.textContent = `${body.count} task${body.count === 1 ? "" : "s"}`;
  while (TASK_LIST.firstChild) TASK_LIST.firstChild.remove();
  TASK_EMPTY.hidden = tasks.length > 0;
  for (const task of tasks) TASK_LIST.appendChild(renderTask(task));
}

function renderTask(task) {
  const node = TEMPLATE.content.firstElementChild.cloneNode(true);
  node.querySelector(".task-title").textContent = task.title;
  node.querySelector(".task-meta").textContent = `${task.status} · ${task.priority} · updated ${task.updated_at}`;
  node.querySelector(".task-desc").textContent = task.description || "";
  node.dataset.id = String(task.id);
  return node;
}

async function submitProject(event) {
  event.preventDefault();
  showError(PROJECT_ERROR, "");
  const payload = {
    name: document.getElementById("project-name").value,
    description: document.getElementById("project-desc").value,
    status: "active",
  };
  const { res, body } = await api("/api/projects", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    showError(PROJECT_ERROR, formatError(body));
    return;
  }
  PROJECT_FORM.reset();
  await refreshProjects();
}

async function submitTask(event) {
  event.preventDefault();
  showError(TASK_ERROR, "");
  const payload = {
    project_id: activeProject,
    title: document.getElementById("task-title").value,
    description: document.getElementById("task-desc").value,
    status: TASK_FORM.status.value,
    priority: TASK_FORM.priority.value,
  };
  const { res, body } = await api("/api/tasks", { method: "POST", body: JSON.stringify(payload) });
  if (!res.ok) {
    showError(TASK_ERROR, formatError(body));
    return;
  }
  TASK_FORM.reset();
  refreshProjects();
}

async function updateTask(task, payload) {
  const { res, body } = await api(`/api/tasks/${task.id}`, { method: "PATCH", body: JSON.stringify(payload) });
  if (!res.ok) throw Object.assign(new Error(formatError(body)), { handled: true });
  return body.task;
}

async function deleteTask(task) {
  const { res } = await api(`/api/tasks/${task.id}`, { method: "DELETE" });
  if (!res.ok) throw Object.assign(new Error("Could not delete task."), { handled: true });
}

async function handleTaskAction(event) {
  const action = event.target.closest("button");
  if (!action) return;
  const item = action.closest(".task");
  const form = item.querySelector(".task-editform");
  const id = Number(item.dataset.id);
  const task = tasks.find((t) => t.id === id);
  if (!task) return;

  if (action.classList.contains("edit")) {
    item.querySelector(".task-main").hidden = true;
    item.querySelector(".task-actions").hidden = true;
    form.hidden = false;
    form.querySelector(".edit-title").value = task.title;
    form.querySelector(".edit-desc").value = task.description || "";
    form.querySelector(".edit-status").value = task.status;
    form.querySelector(".edit-priority").value = task.priority;
  } else if (action.classList.contains("delete")) {
    try {
      await deleteTask(task);
      refreshProjects();
    } catch (err) {
      const box = item.querySelector(".edit-error");
      box.textContent = err.message;
      box.hidden = false;
    }
  } else if (action.classList.contains("cancel")) {
    form.hidden = true;
    item.querySelector(".task-main").hidden = false;
    item.querySelector(".task-actions").hidden = false;
  }
}

async function submitEdit(event) {
  const form = event.target;
  if (!form.classList.contains("task-editform")) return;
  event.preventDefault();
  const item = form.closest(".task");
  const id = Number(item.dataset.id);
  const errorBox = form.querySelector(".edit-error");
  errorBox.hidden = true;
  try {
    const updated = await updateTask(id, {
      title: form.querySelector(".edit-title").value,
      description: form.querySelector(".edit-desc").value,
      status: form.querySelector(".edit-status").value,
      priority: form.querySelector(".edit-priority").value,
    });
    form.hidden = true;
    item.querySelector(".task-main").hidden = false;
    item.querySelector(".task-actions").hidden = false;
    item.querySelector(".task-title").textContent = updated.title;
    item.querySelector(".task-meta").textContent = `${updated.status} · ${updated.priority} · updated ${updated.updated_at}`;
    item.querySelector(".task-desc").textContent = updated.description || "";
    refreshProjects();
  } catch (err) {
    if (err.handled) {
      errorBox.textContent = err.message;
      errorBox.hidden = false;
    } else {
      throw err;
    }
  }
}

PROJECT_FORM.addEventListener("submit", submitProject);
TASK_FORM.addEventListener("submit", submitTask);
PROJECT_SELECT.addEventListener("change", () => {
  activeProject = Number(PROJECT_SELECT.value || 0);
  refreshTasks();
});
SEARCH.addEventListener("input", refreshTasks);
FILTER_STATUS.addEventListener("change", refreshTasks);
FILTER_PRIORITY.addEventListener("change", refreshTasks);
TASK_LIST.addEventListener("click", handleTaskAction);
TASK_LIST.addEventListener("submit", submitEdit);

loadMeta();
refreshProjects();