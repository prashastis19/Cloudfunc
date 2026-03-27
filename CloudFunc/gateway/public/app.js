const state = {
  authMode: "login",
  token: localStorage.getItem("cloudfunc_token") || "",
  user: null,
  templates: [],
  functions: [],
  jobs: [],
  selectedFunction: null,
  activeJobId: null,
  autoRefreshHandle: null,
  activeJobPollHandle: null
};

const elements = {
  authModal: document.getElementById("auth-modal"),
  authForm: document.getElementById("auth-form"),
  authSubmit: document.getElementById("auth-submit"),
  displayNameWrap: document.getElementById("display-name-wrap"),
  confirmPasswordWrap: document.getElementById("confirm-password-wrap"),
  toast: document.getElementById("toast"),
  userDisplay: document.getElementById("user-display"),
  userEmail: document.getElementById("user-email"),
  userName: document.getElementById("user-name"),
  ownedFunctionsCount: document.getElementById("owned-functions-count"),
  connectionPill: document.getElementById("connection-pill"),
  statsGrid: document.getElementById("stats-grid"),
  templateSelect: document.getElementById("template-select"),
  codeEditor: document.getElementById("code-editor"),
  registerForm: document.getElementById("register-form"),
  functionSearch: document.getElementById("function-search"),
  functionList: document.getElementById("function-list"),
  functionLookupForm: document.getElementById("function-lookup-form"),
  invokeSearch: document.getElementById("invoke-search"),
  functionPreview: document.getElementById("function-preview"),
  invokeForm: document.getElementById("invoke-form"),
  invokeFunction: document.getElementById("invoke-function"),
  payloadEditor: document.getElementById("payload-editor"),
  invokeResult: document.getElementById("invoke-result"),
  jobsList: document.getElementById("jobs-list"),
  jobSearch: document.getElementById("job-search"),
  jobStatusFilter: document.getElementById("job-status-filter")
};

const defaultCode = `module.exports = async (input) => {
  return {
    ok: true,
    payload: input
  };
};`;

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function showToast(message, isError = false) {
  elements.toast.textContent = message;
  elements.toast.style.borderColor = isError
    ? "rgba(208, 79, 69, 0.4)"
    : "rgba(255, 122, 26, 0.36)";
  elements.toast.classList.add("visible");

  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => {
    elements.toast.classList.remove("visible");
  }, 2800);
}

function formatDate(value) {
  return value ? new Date(value).toLocaleString() : "Pending";
}

function prettyJson(value) {
  return JSON.stringify(value, null, 2);
}

function setAuthMode(mode) {
  state.authMode = mode;
  document.querySelectorAll(".auth-tab").forEach((button) => {
    button.classList.toggle("active", button.dataset.authMode === mode);
  });
  elements.displayNameWrap.classList.toggle("hidden", mode !== "register");
  elements.confirmPasswordWrap.classList.toggle("hidden", mode !== "register");
  elements.confirmPasswordWrap.querySelector("input").required = mode === "register";
  elements.authSubmit.textContent = mode === "register" ? "Create Account" : "Login";
}

async function apiFetch(url, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set("Content-Type", "application/json");
  if (state.token) {
    headers.set("Authorization", `Bearer ${state.token}`);
  }

  const response = await fetch(url, { ...options, headers });
  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(data.error || "Request failed");
  }

  return data;
}

async function checkHealth() {
  try {
    const data = await apiFetch("/health", { headers: {} });
    elements.connectionPill.textContent = data.rabbitmqConnected
      ? "Gateway and queue online"
      : "Gateway online";
  } catch (_error) {
    elements.connectionPill.textContent = "Gateway offline";
  }
}

function renderStats(stats = {}) {
  const cards = [
    ["Functions", stats.functionsRegistered || 0, "Registered"],
    ["Runs", stats.totalJobs || 0, "Total jobs"],
    ["Active", (stats.runningJobs || 0) + (stats.queuedJobs || 0), "Queued or running"],
    ["Completed", stats.completedJobs || 0, "Successful"]
  ];

  elements.statsGrid.innerHTML = cards.map(([label, value, copy]) => `
    <div class="stat-card">
      <span class="eyebrow">${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
      <p>${escapeHtml(copy)}</p>
    </div>
  `).join("");
}

function renderUser() {
  const email = state.user?.email || state.user?.username || "Not signed in";
  const displayName = state.user?.displayName || "Guest";

  elements.userDisplay.textContent = email;
  elements.userEmail.textContent = email;
  elements.userName.textContent = displayName;
}

function renderTemplates() {
  elements.templateSelect.innerHTML = `<option value="">Start from scratch</option>` +
    state.templates.map((template) => `
      <option value="${escapeHtml(template.id)}">${escapeHtml(template.title)} (${escapeHtml(template.runtime)})</option>
    `).join("");
}

function renderFunctionList(functions = state.functions) {
  elements.ownedFunctionsCount.textContent = String(functions.length);

  if (!functions.length) {
    elements.functionList.innerHTML = `
      <div class="result-card empty">
        No functions yet.
      </div>
    `;
    return;
  }

  elements.functionList.innerHTML = functions.map((fn) => `
    <article class="function-card">
      <div class="card-head">
        <div>
          <h4>${escapeHtml(fn.name)}</h4>
          <p>Created ${escapeHtml(formatDate(fn.created_at))}</p>
        </div>
        <div class="badge-row">
          <span class="chip">${escapeHtml(fn.runtime || "nodejs18")}</span>
          <span class="chip">${escapeHtml(fn.image_name)}</span>
        </div>
      </div>

      <div class="action-row">
        <button class="ghost-button" type="button" data-fill-function="${escapeHtml(fn.name)}">Invoke</button>
        <button class="ghost-button danger" type="button" data-delete-function="${escapeHtml(fn.name)}">Delete</button>
      </div>
    </article>
  `).join("");
}

function renderJobs(jobs = state.jobs) {
  if (!jobs.length) {
    elements.jobsList.innerHTML = `
      <div class="result-card empty">
        No jobs found.
      </div>
    `;
    return;
  }

  elements.jobsList.innerHTML = jobs.map((job) => {
    const summary = job.result ?? job.error ?? {};
    return `
      <article class="job-card">
        <div class="card-head">
          <div>
            <h4>${escapeHtml(job.function_name)}</h4>
            <p>${escapeHtml(job.job_id)}</p>
          </div>
          <span class="status-badge" data-status="${escapeHtml(job.status)}">${escapeHtml(job.status)}</span>
        </div>

        <p>${escapeHtml(formatDate(job.submitted_at))}</p>
        <pre>${escapeHtml(prettyJson(summary))}</pre>

        <div class="action-row">
          <button class="ghost-button" type="button" data-job-id="${escapeHtml(job.job_id)}">View Details</button>
        </div>
      </article>
    `;
  }).join("");
}

function renderFunctionPreview(fn, searchTerm = "") {
  if (!fn) {
    elements.functionPreview.className = "result-card empty";
    elements.functionPreview.textContent = searchTerm
      ? `Function "${searchTerm}" is not there.`
      : "Search for a function to continue.";
    elements.invokeForm.classList.add("hidden");
    return;
  }

  elements.functionPreview.className = "result-card";
  elements.functionPreview.innerHTML = `
    <div class="card-head">
      <div>
        <h4>${escapeHtml(fn.name)}</h4>
      </div>
      <span class="status-badge" data-status="completed">Ready</span>
    </div>
    <div class="meta-row">
      <span class="chip">Runtime: ${escapeHtml(fn.runtime || "nodejs18")}</span>
      <span class="chip">Image: ${escapeHtml(fn.image_name)}</span>
      <span class="chip">Created: ${escapeHtml(formatDate(fn.created_at))}</span>
    </div>
  `;
  elements.invokeForm.classList.remove("hidden");
  elements.invokeFunction.value = fn.name;
}

function renderInvokeResult(content) {
  elements.invokeResult.className = "result-card";
  elements.invokeResult.innerHTML = content;
}

function renderJobResult(job) {
  const output = job.result ?? job.error ?? {};
  renderInvokeResult(`
    <div class="card-head">
      <div>
        <h4>${escapeHtml(job.function_name)}</h4>
      </div>
      <span class="status-badge" data-status="${escapeHtml(job.status)}">${escapeHtml(job.status)}</span>
    </div>
    <p>Job ID: ${escapeHtml(job.job_id)}</p>
    <p>Submitted: ${escapeHtml(formatDate(job.submitted_at))}</p>
    <p>Completed: ${escapeHtml(formatDate(job.completed_at))}</p>
    <pre>${escapeHtml(prettyJson(output))}</pre>
  `);
}

async function loadTemplates() {
  state.templates = await apiFetch("/api/templates");
  renderTemplates();
}

async function loadDashboard() {
  const dashboard = await apiFetch("/api/dashboard");
  renderStats(dashboard.stats);
  state.functions = dashboard.functions || [];
  renderFunctionList(state.functions);
}

async function loadFunctions(search = "") {
  const query = new URLSearchParams();
  if (search) {
    query.set("search", search);
  }

  state.functions = await apiFetch(`/api/functions${query.toString() ? `?${query.toString()}` : ""}`);
  renderFunctionList(state.functions);
}

async function loadJobs() {
  const query = new URLSearchParams();
  if (elements.jobSearch.value.trim()) query.set("search", elements.jobSearch.value.trim());
  if (elements.jobStatusFilter.value) query.set("status", elements.jobStatusFilter.value);
  state.jobs = await apiFetch(`/api/jobs${query.toString() ? `?${query.toString()}` : ""}`);
  renderJobs(state.jobs);
}

async function refreshAll() {
  await Promise.all([
    loadDashboard(),
    loadFunctions(elements.functionSearch.value.trim()),
    loadJobs()
  ]);
}

function stopActiveJobPolling() {
  clearInterval(state.activeJobPollHandle);
  state.activeJobPollHandle = null;
}

function startActiveJobPolling(jobId) {
  stopActiveJobPolling();
  state.activeJobId = jobId;

  state.activeJobPollHandle = setInterval(async () => {
    if (!state.activeJobId || !state.token) {
      return;
    }

    try {
      const job = await apiFetch(`/api/jobs/${state.activeJobId}`);
      renderJobResult(job);

      if (job.status === "completed" || job.status === "failed") {
        stopActiveJobPolling();
        await Promise.all([loadDashboard(), loadJobs()]);
      }
    } catch (_error) {
      stopActiveJobPolling();
    }
  }, 2500);
}

async function loadSession() {
  if (!state.token) {
    elements.authModal.classList.remove("hidden");
    return;
  }

  try {
    const session = await apiFetch("/auth/me");
    state.user = session.user;
    renderUser();
    elements.authModal.classList.add("hidden");
    await Promise.all([loadTemplates(), refreshAll()]);
    startAutoRefresh();
  } catch (_error) {
    state.token = "";
    state.user = null;
    localStorage.removeItem("cloudfunc_token");
    renderUser();
    elements.authModal.classList.remove("hidden");
  }
}

function startAutoRefresh() {
  clearInterval(state.autoRefreshHandle);
  state.autoRefreshHandle = setInterval(() => {
    if (!state.token) return;
    loadDashboard().catch(() => {});
    loadJobs().catch(() => {});
  }, 6000);
}

async function handleAuthSubmit(event) {
  event.preventDefault();
  const formData = new FormData(elements.authForm);
  const email = String(formData.get("email") || "").trim();
  const password = String(formData.get("password") || "");
  const confirmPassword = String(formData.get("confirmPassword") || "");

  if (state.authMode === "register" && password !== confirmPassword) {
    showToast("Passwords do not match", true);
    return;
  }

  const payload = {
    email,
    password
  };

  if (state.authMode === "register") {
    payload.displayName = String(formData.get("displayName") || "").trim();
  }

  try {
    const response = await apiFetch(`/auth/${state.authMode}`, {
      method: "POST",
      body: JSON.stringify(payload)
    });

    state.token = response.token;
    state.user = response.user;
    localStorage.setItem("cloudfunc_token", state.token);
    renderUser();
    elements.authModal.classList.add("hidden");
    elements.authForm.reset();
    showToast(state.authMode === "register" ? "Account created" : "Logged in");
    await Promise.all([loadTemplates(), refreshAll()]);
    startAutoRefresh();
  } catch (error) {
    showToast(error.message, true);
  }
}

async function handleRegisterFunction(event) {
  event.preventDefault();
  const formData = new FormData(elements.registerForm);
  const payload = Object.fromEntries(formData.entries());

  try {
    await apiFetch("/api/functions", {
      method: "POST",
      body: JSON.stringify(payload)
    });
    elements.registerForm.reset();
    elements.codeEditor.value = defaultCode;
    showToast("Function registered");
    await Promise.all([loadDashboard(), loadFunctions(), loadJobs()]);
  } catch (error) {
    showToast(error.message, true);
  }
}

async function handleFunctionLookup(event) {
  event.preventDefault();
  const searchTerm = elements.invokeSearch.value.trim();

  if (!searchTerm) {
    renderFunctionPreview(null);
    return;
  }

  try {
    const fn = await apiFetch(`/api/functions/${encodeURIComponent(searchTerm)}`);
    state.selectedFunction = fn;
    renderFunctionPreview(fn);
    showToast("Function found");
  } catch (error) {
    state.selectedFunction = null;
    renderFunctionPreview(null, searchTerm);
    showToast(error.message, true);
  }
}

async function handleInvoke(event) {
  event.preventDefault();

  try {
    const payload = JSON.parse(elements.payloadEditor.value);
    const response = await apiFetch("/api/invoke", {
      method: "POST",
      body: JSON.stringify({
        functionName: elements.invokeFunction.value,
        payload
      })
    });

    renderInvokeResult(`
      <div class="card-head">
        <div>
          <h4>${escapeHtml(elements.invokeFunction.value)}</h4>
        </div>
        <span class="status-badge" data-status="queued">queued</span>
      </div>
      <p>Job ID: ${escapeHtml(response.jobId)}</p>
      <p>Running now. Result will update automatically.</p>
    `);

    showToast("Invocation queued");
    await Promise.all([loadDashboard(), loadJobs()]);
    startActiveJobPolling(response.jobId);
  } catch (error) {
    showToast(error.message, true);
  }
}

async function handleDeleteFunction(functionName) {
  if (!window.confirm(`Delete function "${functionName}"?`)) {
    return;
  }

  try {
    await apiFetch(`/api/functions/${encodeURIComponent(functionName)}`, { method: "DELETE" });
    if (state.selectedFunction?.name === functionName) {
      state.selectedFunction = null;
      renderFunctionPreview(null);
    }
    showToast("Function deleted");
    await Promise.all([loadDashboard(), loadFunctions(), loadJobs()]);
  } catch (error) {
    showToast(error.message, true);
  }
}

async function handleJobDetail(jobId) {
  try {
    const job = await apiFetch(`/api/jobs/${jobId}`);
    renderJobResult(job);
    showToast("Loaded run details");
  } catch (error) {
    showToast(error.message, true);
  }
}

function applyTemplate(templateId) {
  const template = state.templates.find((item) => item.id === templateId);
  if (!template) return;

  elements.codeEditor.value = template.code;
  elements.registerForm.querySelector('[name="runtime"]').value = template.runtime;
  showToast(`Loaded ${template.title}`);
}

function setupRevealAnimations() {
  const revealNodes = document.querySelectorAll("[data-reveal]");

  if (!("IntersectionObserver" in window)) {
    revealNodes.forEach((node) => node.classList.add("visible"));
    return;
  }

  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      entry.target.classList.add("visible");
      observer.unobserve(entry.target);
    });
  }, { threshold: 0.15 });

  revealNodes.forEach((node, index) => {
    node.style.transitionDelay = `${Math.min(index * 60, 240)}ms`;
    observer.observe(node);
  });
}

document.querySelectorAll(".auth-tab").forEach((button) => {
  button.addEventListener("click", () => setAuthMode(button.dataset.authMode));
});

elements.authForm.addEventListener("submit", handleAuthSubmit);
elements.registerForm.addEventListener("submit", handleRegisterFunction);
elements.functionLookupForm.addEventListener("submit", handleFunctionLookup);
elements.invokeForm.addEventListener("submit", handleInvoke);
elements.templateSelect.addEventListener("change", (event) => {
  if (event.target.value) {
    applyTemplate(event.target.value);
  }
});

elements.functionList.addEventListener("click", (event) => {
  const invokeButton = event.target.closest("[data-fill-function]");
  const deleteButton = event.target.closest("[data-delete-function]");

  if (invokeButton) {
    const functionName = invokeButton.dataset.fillFunction;
    elements.invokeSearch.value = functionName;
    handleFunctionLookup(new Event("submit")).catch((error) => showToast(error.message, true));
  }

  if (deleteButton) {
    handleDeleteFunction(deleteButton.dataset.deleteFunction);
  }
});

elements.jobsList.addEventListener("click", (event) => {
  const button = event.target.closest("[data-job-id]");
  if (!button) return;
  handleJobDetail(button.dataset.jobId);
});

elements.functionSearch.addEventListener("input", () => {
  loadFunctions(elements.functionSearch.value.trim()).catch((error) => showToast(error.message, true));
});

elements.jobSearch.addEventListener("input", () => {
  loadJobs().catch((error) => showToast(error.message, true));
});

elements.jobStatusFilter.addEventListener("change", () => {
  loadJobs().catch((error) => showToast(error.message, true));
});

document.getElementById("refresh-functions-btn").addEventListener("click", () => {
  loadFunctions(elements.functionSearch.value.trim()).catch((error) => showToast(error.message, true));
});

document.getElementById("refresh-jobs-btn").addEventListener("click", () => {
  loadJobs().catch((error) => showToast(error.message, true));
});

document.getElementById("logout-btn").addEventListener("click", () => {
  state.token = "";
  state.user = null;
  state.selectedFunction = null;
  state.activeJobId = null;
  localStorage.removeItem("cloudfunc_token");
  clearInterval(state.autoRefreshHandle);
  stopActiveJobPolling();
  renderUser();
  renderFunctionPreview(null);
  renderInvokeResult("No result yet.");
  elements.authModal.classList.remove("hidden");
  showToast("Logged out");
});

elements.codeEditor.value = defaultCode;
checkHealth();
setAuthMode("login");
renderUser();
renderFunctionPreview(null);
setupRevealAnimations();
loadSession();
