const $ = (id) => document.getElementById(id);
const logs = $("logs");
const taskBadge = $("taskBadge");

let lastBuildResult = null;
let materials = [];
let executors = [];
let workspaceDir = "";
let currentExecutionId = "";
let currentExecutionTaskId = "";
let isBuilding = false;
let isMaterialBuilding = false;
let isExecuting = false;
let isExporting = false;
let validationPassed = false;
let aiCompleted = false;
let currentStep = 1;
const actionLabels = {};

function log(message, level = "info") {
  const prefix = level === "stderr" ? "[err]" : level === "stdout" ? "[out]" : "[info]";
  logs.textContent += `${prefix} ${message}`;
  if (!message.endsWith("\n")) logs.textContent += "\n";
  logs.scrollTop = logs.scrollHeight;
}

function values() {
  return {
    productName: $("productName").value.trim(),
    domainName: $("domainName").value.trim(),
    domainScope: $("domainScope").value.trim(),
    repoDirs: $("repoDirs").value.split(/\r?\n/).map((value) => value.trim()).filter(Boolean),
    rawDocsDir: $("rawDocsDir").value.trim(),
    outputRootDir: $("outputRootDir").value.trim(),
    materialDir: $("materialSelect").value,
  };
}

function escapeHtml(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function slugifyClient(value, fallback) {
  return String(value || fallback).trim().replace(/[^\p{L}\p{N}._-]+/gu, "-").replace(/^-+|-+$/g, "").toLowerCase() || fallback;
}

async function requestJson(url, options) {
  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "请求失败");
  return data;
}

function postJson(url, body) {
  return requestJson(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

function setButtonBusy(button, busy, label) {
  if (!button) return;
  if (!actionLabels[button.id]) actionLabels[button.id] = button.textContent;
  button.disabled = busy;
  button.classList.toggle("busy", busy);
  button.textContent = busy ? label : actionLabels[button.id];
}

async function withButtonState(buttonId, busyLabel, action, options = {}) {
  const button = $(buttonId);
  setButtonBusy(button, true, busyLabel);
  try {
    return await action();
  } finally {
    if (!options.keepBusy) setButtonBusy(button, false, busyLabel);
  }
}

function selectedExecutor() {
  return executors.find((executor) => executor.id === $("executorSelect").value);
}

function executorIsReady(executor) {
  return Boolean(executor && (executor.ready ?? (executor.available && executor.authenticated !== false)));
}

function unlockedWizardStep() {
  if (lastBuildResult?.runDir) return 4;
  if ($("materialSelect").value) return 2;
  return 1;
}

function renderWizard() {
  const unlockedStep = unlockedWizardStep();
  if (currentStep > unlockedStep) currentStep = unlockedStep;
  document.querySelectorAll("[data-step-panel]").forEach((panel) => {
    const active = Number(panel.dataset.stepPanel) === currentStep;
    panel.hidden = !active;
    panel.classList.toggle("active", active);
  });
  document.querySelectorAll("[data-wizard-step]").forEach((button) => {
    const step = Number(button.dataset.wizardStep);
    const completed = step === 1 ? unlockedStep > 1 : step === 2 ? Boolean(lastBuildResult?.runDir) : step === 3 ? aiCompleted : step === 4 ? validationPassed : false;
    button.disabled = step > unlockedStep;
    button.classList.toggle("active", step === currentStep);
    button.classList.toggle("complete", completed);
    if (step === currentStep) button.setAttribute("aria-current", "step");
    else button.removeAttribute("aria-current");
  });
  $("materialNextBtn").disabled = !$("materialSelect").value || isMaterialBuilding;
  $("reviewNextBtn").disabled = !lastBuildResult?.runDir || isExecuting;
}

function goToWizardStep(step, focus = true) {
  const target = Number(step);
  if (!Number.isInteger(target) || target < 1 || target > unlockedWizardStep()) return;
  currentStep = target;
  renderWizard();
  if (focus) document.querySelector(`[data-step-panel="${target}"]`)?.focus({ preventScroll: true });
}

function updateActionAvailability() {
  const hasRun = Boolean(lastBuildResult?.runDir);
  $("materialBtn").disabled = isMaterialBuilding || isBuilding || isExecuting;
  $("buildBtn").disabled = isBuilding || isMaterialBuilding || isExecuting || !$("materialSelect").value;
  $("executeBtn").disabled = isExecuting || !hasRun || !executorIsReady(selectedExecutor());
  $("cancelExecutionBtn").disabled = !isExecuting || !(currentExecutionId || currentExecutionTaskId);
  $("validateAssetsBtn").disabled = isBuilding || isExecuting || !hasRun;
  $("exportBtn").disabled = isBuilding || isExecuting || isExporting || !validationPassed;
  $("openRunBtn").disabled = !hasRun;
  renderWizard();
}

function updateResultSummary() {
  const result = lastBuildResult || {};
  if (!lastBuildResult) {
    $("resultSummary").innerHTML = '<div class="empty-summary">生成业务域骨架后显示关键路径</div>';
    return;
  }
  const items = [
    ["产品或业务中心", result.productName], ["业务域", result.domainName],
    ["关联服务", result.repositories?.map((repo) => repo.name).join("、") || "无"],
    ["中心原料", result.materialDir], ["草稿目录", result.draftsDir],
  ];
  $("resultSummary").innerHTML = items.map(([label, value]) => `<div><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`).join("");
}

function updateTargetPreview() {
  const v = values();
  $("targetTitle").textContent = `${v.productName || "未填写产品中心"} / ${v.domainName || "未填写业务域"}`;
  $("targetPath").textContent = `code-knowledge/${slugifyClient(v.productName, "未填写产品中心")}/${slugifyClient(v.domainName, "未填写业务域")}/`;
}

function setValidationStatus(kind, message) {
  $("validationStatus").className = `validation-status ${kind}`;
  $("validationStatus").textContent = message;
}

function normalizeExecutor(raw) {
  const id = raw.id || raw.name || raw.command;
  return { ...raw, id, label: raw.label || raw.displayName || (id === "codex" ? "Codex" : id === "claude" ? "Claude" : id) };
}

function renderExecutors() {
  const readyExecutors = executors.filter(executorIsReady);
  $("executorSelect").innerHTML = executors.length
    ? executors.map((executor) => `<option value="${escapeHtml(executor.id)}" ${executorIsReady(executor) ? "" : "disabled"}>${escapeHtml(executor.label)} · ${executorIsReady(executor) ? executor.version || "已就绪" : "不可用"}</option>`).join("")
    : '<option value="">未检测到本地执行器</option>';
  if (readyExecutors.length) $("executorSelect").value = readyExecutors[0].id;
  $("executorReadiness").innerHTML = executors.length
    ? executors.map((executor) => `<span class="executor-chip ${executorIsReady(executor) ? "ready" : "unavailable"}">${escapeHtml(executor.label)} · ${executorIsReady(executor) ? "就绪" : "不可用"}</span>`).join("")
    : '<span class="executor-chip unavailable">未检测到 Codex 或 Claude</span>';
  $("executorStatus").textContent = readyExecutors.length ? "执行结果仍需校验和人工确认。" : "未检测到可用执行器，可在运行目录中人工处理任务。";
  updateActionAvailability();
}

async function refreshExecutors() {
  try {
    const data = await requestJson("/api/executors");
    executors = (Array.isArray(data) ? data : data.executors || []).map(normalizeExecutor).filter((executor) => executor.id);
  } catch (error) {
    executors = [];
    log(`执行器检测失败，可继续手动执行：${error.message}`, "stderr");
  }
  renderExecutors();
}

async function boot() {
  const health = await requestJson("/api/health");
  workspaceDir = health.workspaceDir;
  await Promise.all([refreshMaterials(), refreshExecutors()]);
  updateResultSummary();
  updateTargetPreview();
  updateActionAvailability();
}

async function refreshMaterials(preferredDir = "") {
  const data = await requestJson("/api/materials");
  materials = data.materials || [];
  const select = $("materialSelect");
  const current = preferredDir || select.value;
  select.innerHTML = '<option value="">请先生成或选择一份中心原料</option>' + materials.map((material) => {
    const createdAt = material.createdAt ? new Date(material.createdAt).toLocaleString() : "未知时间";
    return `<option value="${escapeHtml(material.materialDir)}">${escapeHtml(`${material.productName} · ${createdAt} · ${material.repositories.length} 个仓库`)}</option>`;
  }).join("");
  if (current && materials.some((material) => material.materialDir === current)) select.value = current;
  syncSelectedMaterial();
}

function syncSelectedMaterial() {
  const selected = materials.find((material) => material.materialDir === $("materialSelect").value);
  if (!selected) {
    $("productName").readOnly = false;
    $("materialStatus").textContent = "代码版本变化后再生成新原料。";
    $("materialStatus").className = "";
    updateActionAvailability();
    return;
  }
  $("productName").value = selected.productName;
  $("productName").readOnly = true;
  $("materialStatus").textContent = `已选择 ${selected.repositories.length} 个仓库的原料，生成于 ${new Date(selected.createdAt).toLocaleString()}`;
  $("materialStatus").className = "ok";
  updateTargetPreview();
  updateActionAvailability();
}

async function pickDirectory(fieldId, prompt, mode) {
  const data = await postJson("/api/choose-directory", { defaultPath: mode === "append" ? undefined : $(fieldId).value.trim() || undefined, prompt });
  if (mode === "append") {
    const paths = $(fieldId).value.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
    if (!paths.includes(data.path)) paths.push(data.path);
    $(fieldId).value = paths.join("\n");
  } else $(fieldId).value = data.path;
  await validateField(fieldId);
}

async function validateField(fieldId) {
  const value = $(fieldId).value.trim();
  const status = $(`${fieldId}Status`);
  if (!status || !value) return;
  if (fieldId === "repoDirs") {
    status.textContent = "检查中...";
    const paths = value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
    const infos = await Promise.all(paths.map((repoPath) => postJson("/api/path-info", { path: repoPath })));
    const invalid = infos.filter((info) => !info.exists || !info.directory);
    status.textContent = invalid.length ? `${invalid.length} 个仓库目录无效` : `已确认 ${infos.length} 个仓库目录`;
    status.className = invalid.length ? "warn" : "ok";
    return;
  }
  status.textContent = "检查中...";
  status.className = "checking";
  const info = await postJson("/api/path-info", { path: value });
  status.textContent = `${info.exists ? "已确认存在" : "不存在，将在需要时创建"}：${info.path || value}`;
  status.className = info.exists ? "ok" : "warn";
}

async function validatePaths() {
  for (const fieldId of ["repoDirs", "rawDocsDir"]) {
    if (!$(fieldId).value.trim()) continue;
    await validateField(fieldId);
    log(`${fieldId}: 已检查`);
  }
}

async function createMaterial() {
  const v = values();
  if (!v.productName) throw new Error("请填写产品或业务中心名称");
  if (!v.repoDirs.length && !v.rawDocsDir) throw new Error("请至少添加一个代码仓库或补充资料目录");
  isMaterialBuilding = true;
  updateActionAvailability();
  taskBadge.textContent = "正在生成中心原料";
  taskBadge.className = "badge running";
  const result = await postJson("/api/materials", v);
  log(`原料任务已提交：${result.taskId}`);
}

async function build() {
  const v = values();
  if (!v.materialDir) throw new Error("请先生成或选择中心原料");
  if (!v.domainName) throw new Error("请填写业务域名");
  isBuilding = true;
  aiCompleted = false;
  validationPassed = false;
  setValidationStatus("idle", "骨架更新后需要重新校验");
  updateActionAvailability();
  taskBadge.textContent = "正在生成骨架";
  taskBadge.className = "badge running";
  const result = await postJson("/api/domains", v);
  log(`业务域骨架任务已提交：${result.taskId}`);
}

async function openPath(pathValue, fallbackMessage) {
  if (!pathValue) throw new Error(fallbackMessage);
  await postJson("/api/open-path", { path: pathValue });
  log(`已打开：${pathValue}`);
}

async function executeWithLocalAi() {
  const executor = selectedExecutor();
  if (!lastBuildResult?.runDir) throw new Error("请先生成业务域骨架");
  if (!executorIsReady(executor)) throw new Error("请选择已就绪的本地执行器");
  isExecuting = true;
  validationPassed = false;
  setValidationStatus("idle", "AI 执行后需要重新校验");
  taskBadge.textContent = `正在使用 ${executor.label}`;
  taskBadge.className = "badge running";
  updateActionAvailability();
  const result = await postJson("/api/executions", { runDir: lastBuildResult.runDir, executor: executor.id });
  currentExecutionTaskId = result.taskId || "";
  currentExecutionId = result.executionId || result.id || currentExecutionTaskId;
  log(`${executor.label} 执行任务已提交：${currentExecutionId || "等待任务编号"}`);
  updateActionAvailability();
}

async function cancelExecution() {
  const executionId = currentExecutionId || currentExecutionTaskId;
  if (!executionId) throw new Error("当前没有可取消的 AI 任务");
  await requestJson(`/api/executions/${encodeURIComponent(executionId)}`, { method: "DELETE" });
  log(`已请求取消 AI 任务：${executionId}`);
}

async function validateAssets() {
  if (!lastBuildResult?.runId) throw new Error("请先生成业务域骨架");
  setValidationStatus("checking", "正在校验产物...");
  const response = await fetch(`/api/runs/${encodeURIComponent(lastBuildResult.runId)}/validate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok && !result.validation) throw new Error(result.error || "校验请求失败");
  const validation = result.validation || result;
  const errors = validation.errors || [];
  const warnings = validation.warnings || [];
  validationPassed = validation.valid ?? errors.length === 0;
  const message = validationPassed ? `校验通过${warnings.length ? `，${warnings.length} 个警告` : ""}` : `校验未通过，${errors.length || result.errorCount || 1} 个错误`;
  setValidationStatus(validationPassed ? "passed" : "failed", message);
  log(message, validationPassed ? "info" : "stderr");
  [...errors, ...warnings].forEach((item) => log(typeof item === "string" ? item : item.message || JSON.stringify(item), errors.includes(item) ? "stderr" : "info"));
  updateActionAvailability();
}

async function exportAssets() {
  if (!lastBuildResult?.draftsDir) throw new Error("请先生成业务域骨架");
  if (!validationPassed) throw new Error("请先完成产物校验");
  isExporting = true;
  updateActionAvailability();
  taskBadge.textContent = "正在导出";
  taskBadge.className = "badge running";
  const result = await postJson(`/api/runs/${encodeURIComponent(lastBuildResult.runId)}/exports`, { outputRootDir: values().outputRootDir || undefined });
  log(`知识资产已导出：${result.exportDir || result.outputRootDir || "服务器默认目录"}`);
  if (result.skipped?.length) log(`已跳过：${result.skipped.join(", ")}`);
  taskBadge.textContent = "已导出";
  taskBadge.className = "badge done";
  isExporting = false;
  updateActionAvailability();
}

function finishExecution(payload, succeeded) {
  isExecuting = false;
  currentExecutionId = "";
  currentExecutionTaskId = "";
  aiCompleted = succeeded;
  setButtonBusy($("executeBtn"), false, "执行中...");
  const validation = payload.result?.validation;
  validationPassed = Boolean(succeeded && validation?.valid);
  if (validation) {
    const errors = validation.errors || [];
    setValidationStatus(validationPassed ? "passed" : "failed", validationPassed ? "AI 执行完成，自动校验通过" : `自动校验未通过，${errors.length || 1} 个错误`);
  }
  taskBadge.textContent = validationPassed ? "AI 整理及校验完成" : succeeded ? "AI 整理完成，等待校验" : payload.status === "cancelled" ? "AI 执行已取消" : "AI 执行失败";
  taskBadge.className = succeeded ? "badge done" : "badge failed";
  log(succeeded ? "AI 执行完成，请校验产物并人工确认后导出。" : payload.error || "AI 执行未完成", succeeded ? "info" : "stderr");
  updateActionAvailability();
  if (succeeded) goToWizardStep(4);
}

function connectEvents() {
  const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/events`);
  ws.onmessage = (event) => {
    const data = JSON.parse(event.data);
    if (data.event === "log") log(data.payload.message, data.payload.level);
    if (data.event !== "task") return;
    const payload = data.payload;
    const eventExecutionId = payload.executionId || payload.taskId;
    const activeExecutionId = currentExecutionId || currentExecutionTaskId;
    if (payload.taskType === "execution" && activeExecutionId && eventExecutionId !== activeExecutionId) return;
    if (payload.status === "running") {
      taskBadge.textContent = `执行中：${payload.step}`;
      taskBadge.className = "badge running";
      return;
    }
    if (payload.taskType === "material" && payload.status === "done") {
      isMaterialBuilding = false;
      setButtonBusy($("materialBtn"), false, "生成中...");
      taskBadge.textContent = "中心原料已就绪";
      taskBadge.className = "badge done";
      refreshMaterials(payload.result.materialDir)
        .then(() => goToWizardStep(2))
        .catch((error) => log(error.message, "stderr"));
      log(`中心原料：${payload.result.materialDir}`);
      updateActionAvailability();
      return;
    }
    if (payload.taskType === "domain" && payload.status === "done") {
      isBuilding = false;
      setButtonBusy($("buildBtn"), false, "生成中...");
      lastBuildResult = payload.result;
      taskBadge.textContent = "骨架已生成，等待 AI 整理";
      taskBadge.className = "badge done";
      updateResultSummary();
      log(`运行目录：${payload.result.runDir}`);
      log(`草稿目录：${payload.result.draftsDir}`);
      updateActionAvailability();
      goToWizardStep(3);
      return;
    }
    if (payload.taskType === "execution" && payload.status === "done") return finishExecution(payload, true);
    if (payload.taskType === "execution" && ["failed", "cancelled"].includes(payload.status)) return finishExecution(payload, false);
    if (payload.status === "failed") {
      isBuilding = false;
      isMaterialBuilding = false;
      isExporting = false;
      setButtonBusy($("buildBtn"), false, "生成中...");
      setButtonBusy($("materialBtn"), false, "生成中...");
      taskBadge.textContent = "失败";
      taskBadge.className = "badge failed";
      log(payload.error, "stderr");
      updateActionAvailability();
    }
  };
}

function bind() {
  document.querySelectorAll("[data-wizard-step]").forEach((button) => button.addEventListener("click", () => goToWizardStep(button.dataset.wizardStep)));
  document.querySelectorAll("[data-wizard-back]").forEach((button) => button.addEventListener("click", () => goToWizardStep(currentStep - 1)));
  $("materialNextBtn").addEventListener("click", () => goToWizardStep(2));
  $("reviewNextBtn").addEventListener("click", () => goToWizardStep(4));
  document.querySelectorAll("[data-pick]").forEach((button) => button.addEventListener("click", () => pickDirectory(button.dataset.pick, button.dataset.prompt, button.dataset.pickMode).catch((error) => log(error.message, "stderr"))));
  $("validateBtn").addEventListener("click", () => withButtonState("validateBtn", "检查中...", validatePaths).catch((error) => log(error.message, "stderr")));
  $("buildBtn").addEventListener("click", () => withButtonState("buildBtn", "生成中...", build, { keepBusy: true }).catch((error) => { isBuilding = false; setButtonBusy($("buildBtn"), false, "生成中..."); updateActionAvailability(); log(error.message, "stderr"); }));
  $("materialBtn").addEventListener("click", () => withButtonState("materialBtn", "生成中...", createMaterial, { keepBusy: true }).catch((error) => { isMaterialBuilding = false; setButtonBusy($("materialBtn"), false, "生成中..."); updateActionAvailability(); log(error.message, "stderr"); }));
  $("materialSelect").addEventListener("change", syncSelectedMaterial);
  $("executorSelect").addEventListener("change", updateActionAvailability);
  $("executeBtn").addEventListener("click", () => withButtonState("executeBtn", "执行中...", executeWithLocalAi, { keepBusy: true }).catch((error) => { isExecuting = false; currentExecutionId = ""; currentExecutionTaskId = ""; setButtonBusy($("executeBtn"), false, "执行中..."); updateActionAvailability(); log(error.message, "stderr"); }));
  $("cancelExecutionBtn").addEventListener("click", () => withButtonState("cancelExecutionBtn", "取消中...", cancelExecution).catch((error) => log(error.message, "stderr")));
  $("validateAssetsBtn").addEventListener("click", () => withButtonState("validateAssetsBtn", "校验中...", validateAssets).catch((error) => { validationPassed = false; setValidationStatus("failed", "校验失败"); updateActionAvailability(); log(error.message, "stderr"); }));
  $("exportBtn").addEventListener("click", () => withButtonState("exportBtn", "导出中...", exportAssets).catch((error) => { isExporting = false; updateActionAvailability(); taskBadge.textContent = "导出失败"; taskBadge.className = "badge failed"; log(error.message, "stderr"); }));
  $("openRunBtn").addEventListener("click", () => withButtonState("openRunBtn", "打开中...", () => openPath(lastBuildResult?.runDir, "请先生成业务域骨架")).catch((error) => log(error.message, "stderr")));
  $("openWorkspaceBtn").addEventListener("click", () => withButtonState("openWorkspaceBtn", "打开中...", () => openPath(workspaceDir, "工作区未就绪")).catch((error) => log(error.message, "stderr")));
  $("clearLogBtn").addEventListener("click", () => { logs.textContent = ""; });
  ["productName", "domainName", "domainScope"].forEach((fieldId) => $(fieldId).addEventListener("input", updateTargetPreview));
}

boot().catch((error) => log(error.message, "stderr"));
connectEvents();
bind();
