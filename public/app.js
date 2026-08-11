const $ = (id) => document.getElementById(id);
const logs = $("logs");
const taskBadge = $("taskBadge");
let lastBuildResult = null;
let workspaceDir = "";
let isBuilding = false;
let isPublishing = false;

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
    knowledgeRagDocsDir: $("knowledgeRagDocsDir").value.trim(),
  };
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function slugifyClient(value, fallback) {
  return String(value || fallback)
    .trim()
    .replace(/[^\p{L}\p{N}._-]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase() || fallback;
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "请求失败");
  return data;
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

function updateActionAvailability() {
  $("buildBtn").disabled = isBuilding;
  $("publishBtn").disabled = isBuilding || isPublishing || !lastBuildResult;
  $("loadPromptBtn").disabled = isBuilding || !lastBuildResult;
  $("copyPromptBtn").disabled = !$("promptPreview").value;
  $("openRunBtn").disabled = !lastBuildResult;
}

function updateResultSummary() {
  const r = lastBuildResult || {};
  const items = [
    ["产品或业务中心", r.productName || "生成后显示"],
    ["业务域", r.domainName || "生成后显示"],
    ["关联服务", r.repositories?.map((repo) => repo.name).join("、") || "生成后显示"],
    ["业务域边界", r.domainScope || "未填写"],
    ["运行目录", r.runDir || "生成后显示"],
    ["草稿目录", r.draftsDir || "生成后显示"],
    ["AI 提示词", r.promptPath || "生成后显示"],
    ["多仓库清单", r.repoManifestPath || "生成后显示"],
    ["转换资料", r.convertedDocsDir || "生成后显示"],
    ["建议发布目录", r.publishDir || "生成后显示"],
  ];
  $("resultSummary").innerHTML = items
    .map(([label, value]) => `<div><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`)
    .join("");
}

function updateTargetPreview() {
  const v = values();
  const productLabel = v.productName || "未填写产品中心";
  const domainLabel = v.domainName || "未填写业务域";
  const productSlug = slugifyClient(v.productName, "未填写产品中心");
  const domainSlug = slugifyClient(v.domainName, "未填写业务域");
  $("targetTitle").textContent = `${productLabel} / ${domainLabel}`;
  $("targetPath").textContent = `code-knowledge/${productSlug}/${domainSlug}/`;
}

async function boot() {
  const health = await fetch("/api/health").then((r) => r.json());
  workspaceDir = health.workspaceDir;
  updateResultSummary();
  updateTargetPreview();
  updateActionAvailability();
}

async function pickDirectory(fieldId, prompt, mode) {
  const currentPath = mode === "append" ? "" : $(fieldId).value.trim();
  const data = await postJson("/api/choose-directory", {
    defaultPath: currentPath || undefined,
    prompt,
  });
  if (mode === "append") {
    const paths = $(fieldId).value.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
    if (!paths.includes(data.path)) paths.push(data.path);
    $(fieldId).value = paths.join("\n");
  } else {
    $(fieldId).value = data.path;
  }
  await validateField(fieldId);
}

async function validateField(fieldId) {
  const value = $(fieldId).value.trim();
  const status = $(`${fieldId}Status`);
  if (!status || !value) return;
  if (fieldId === "repoDirs") {
    const paths = value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
    status.textContent = "检查中...";
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
  for (const fieldId of ["knowledgeRagDocsDir", "repoDirs", "rawDocsDir"]) {
    const value = $(fieldId).value.trim();
    if (!value) continue;
    await validateField(fieldId);
    log(`${fieldId}: 已检查 ${value}`);
  }
}

async function build() {
  const v = values();
  if (!v.knowledgeRagDocsDir) throw new Error("请选择 knowledge-rag 文档目录");
  if (!v.productName) throw new Error("请填写产品或业务中心名称");
  if (!v.domainName) throw new Error("请填写业务域名");
  if (!v.repoDirs.length && !v.rawDocsDir) throw new Error("请至少添加一个代码仓库或补充资料目录");
  isBuilding = true;
  updateActionAvailability();
  taskBadge.textContent = "执行中";
  taskBadge.className = "badge running";
  const result = await postJson("/api/build", v);
  log(`任务已提交：${result.taskId}`);
}

async function loadPrompt() {
  const promptPath = lastBuildResult?.promptPath;
  if (!promptPath) throw new Error("请先生成原料");
  const data = await postJson("/api/read-file", { path: promptPath });
  $("promptPreview").value = data.content;
  $("promptStatus").textContent = data.path;
  log(`已读取提示词：${data.path}`);
  updateActionAvailability();
}

async function copyPrompt() {
  const text = $("promptPreview").value;
  if (!text) throw new Error("请先读取提示词");
  await navigator.clipboard.writeText(text);
  log("AI 提示词已复制到剪贴板");
}

async function openPath(pathValue, fallbackMessage) {
  if (!pathValue) throw new Error(fallbackMessage);
  await postJson("/api/open-path", { path: pathValue });
  log(`已打开：${pathValue}`);
}

async function publish() {
  if (!lastBuildResult?.draftsDir || !lastBuildResult?.publishDir) throw new Error("请先生成原料");
  isPublishing = true;
  updateActionAvailability();
  taskBadge.textContent = "发布中";
  taskBadge.className = "badge running";
  const result = await postJson("/api/publish", {
    draftsDir: lastBuildResult.draftsDir,
    publishDir: lastBuildResult.publishDir,
  });
  log(`发布完成：${result.publishDir}`);
  if (result.skipped?.length) log(`已跳过：${result.skipped.join(", ")}`);
  taskBadge.textContent = "已发布";
  taskBadge.className = "badge done";
  isPublishing = false;
  updateActionAvailability();
}

function connectEvents() {
  const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/events`);
  ws.onmessage = (event) => {
    const data = JSON.parse(event.data);
    if (data.event === "log") log(data.payload.message, data.payload.level);
    if (data.event === "task") {
      const payload = data.payload;
      if (payload.status === "running") {
        taskBadge.textContent = `执行中：${payload.step}`;
        taskBadge.className = "badge running";
      }
      if (payload.status === "done") {
        isBuilding = false;
        setButtonBusy($("buildBtn"), false, "生成中...");
        lastBuildResult = payload.result;
        taskBadge.textContent = "等待 AI 整理";
        taskBadge.className = "badge done";
        updateResultSummary();
        log(`运行目录：${payload.result.runDir}`);
        log(`草稿目录：${payload.result.draftsDir}`);
        log(`AI 提示词：${payload.result.promptPath}`);
        loadPrompt().catch((error) => log(error.message, "stderr"));
        updateActionAvailability();
      }
      if (payload.status === "failed") {
        isBuilding = false;
        isPublishing = false;
        setButtonBusy($("buildBtn"), false, "生成中...");
        setButtonBusy($("publishBtn"), false, "发布中...");
        taskBadge.textContent = "失败";
        taskBadge.className = "badge failed";
        log(payload.error, "stderr");
        updateActionAvailability();
      }
    }
  };
}

function bind() {
  document.querySelectorAll("[data-pick]").forEach((button) => {
    button.addEventListener("click", () => {
      pickDirectory(button.dataset.pick, button.dataset.prompt, button.dataset.pickMode).catch((error) => log(error.message, "stderr"));
    });
  });
  $("validateBtn").addEventListener("click", () => {
    withButtonState("validateBtn", "检查中...", validatePaths).catch((error) => log(error.message, "stderr"));
  });
  $("buildBtn").addEventListener("click", () => {
    withButtonState("buildBtn", "生成中...", build, { keepBusy: true }).catch((error) => {
      isBuilding = false;
      setButtonBusy($("buildBtn"), false, "生成中...");
      updateActionAvailability();
      log(error.message, "stderr");
    });
  });
  $("loadPromptBtn").addEventListener("click", () => {
    withButtonState("loadPromptBtn", "读取中...", loadPrompt).catch((error) => log(error.message, "stderr"));
  });
  $("copyPromptBtn").addEventListener("click", () => {
    withButtonState("copyPromptBtn", "复制中...", copyPrompt).catch((error) => log(error.message, "stderr"));
  });
  $("openRunBtn").addEventListener("click", () => {
    withButtonState("openRunBtn", "打开中...", () => openPath(lastBuildResult?.runDir, "请先生成原料")).catch((error) => log(error.message, "stderr"));
  });
  $("openWorkspaceBtn").addEventListener("click", () => {
    withButtonState("openWorkspaceBtn", "打开中...", () => openPath(workspaceDir, "工作区未就绪")).catch((error) => log(error.message, "stderr"));
  });
  $("publishBtn").addEventListener("click", () => {
    withButtonState("publishBtn", "发布中...", publish).catch((error) => {
      isPublishing = false;
      updateActionAvailability();
      taskBadge.textContent = "发布失败";
      taskBadge.className = "badge failed";
      log(error.message, "stderr");
    });
  });
  $("clearLogBtn").addEventListener("click", () => {
    logs.textContent = "";
  });
  ["productName", "domainName", "domainScope"].forEach((fieldId) => {
    $(fieldId).addEventListener("input", updateTargetPreview);
  });
}

boot().catch((error) => log(error.message, "stderr"));
connectEvents();
bind();
