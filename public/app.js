const $ = (id) => document.getElementById(id);
const logs = $("logs");
const taskBadge = $("taskBadge");
let lastBuildResult = null;
let materials = [];
let workspaceDir = "";
let isBuilding = false;
let isMaterialBuilding = false;
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
    materialDir: $("materialSelect").value,
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
  $("materialBtn").disabled = isMaterialBuilding || isBuilding;
  $("buildBtn").disabled = isBuilding || isMaterialBuilding || !$("materialSelect").value;
  $("publishBtn").disabled = isBuilding || isMaterialBuilding || isPublishing || !lastBuildResult;
  $("loadPromptBtn").disabled = isBuilding || !lastBuildResult;
  $("copyPromptBtn").disabled = !$("promptPreview").value;
  $("openRunBtn").disabled = !lastBuildResult;
}

function updateResultSummary() {
  const r = lastBuildResult || {};
  if (!lastBuildResult) {
    $("resultSummary").innerHTML = '<div class="empty-summary">生成业务域后显示关键路径</div>';
    return;
  }
  const items = [
    ["产品或业务中心", r.productName],
    ["业务域", r.domainName],
    ["关联服务", r.repositories?.map((repo) => repo.name).join("、") || "无"],
    ["使用中心原料", r.materialDir],
    ["AI 提示词", r.promptPath],
    ["建议发布目录", r.publishDir],
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
  await refreshMaterials();
  updateResultSummary();
  updateTargetPreview();
  updateActionAvailability();
}

async function refreshMaterials(preferredDir = "") {
  const data = await fetch("/api/materials").then((response) => response.json());
  materials = data.materials || [];
  const select = $("materialSelect");
  const current = preferredDir || select.value;
  select.innerHTML = '<option value="">请先生成或选择一份中心原料</option>' + materials
    .map((material) => {
      const createdAt = material.createdAt ? new Date(material.createdAt).toLocaleString() : "未知时间";
      const label = `${material.productName} · ${createdAt} · ${material.repositories.length} 个仓库`;
      return `<option value="${escapeHtml(material.materialDir)}">${escapeHtml(label)}</option>`;
    })
    .join("");
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
  if (!v.knowledgeRagDocsDir) throw new Error("请选择 knowledge-rag 文档目录");
  if (!v.materialDir) throw new Error("请先生成或选择中心原料");
  if (!v.domainName) throw new Error("请填写业务域名");
  isBuilding = true;
  updateActionAvailability();
  taskBadge.textContent = "执行中";
  taskBadge.className = "badge running";
  const result = await postJson("/api/domains", v);
  log(`业务域任务已提交：${result.taskId}`);
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
        if (payload.taskType === "material") {
          isMaterialBuilding = false;
          setButtonBusy($("materialBtn"), false, "生成中...");
          taskBadge.textContent = "中心原料已就绪";
          taskBadge.className = "badge done";
          refreshMaterials(payload.result.materialDir).catch((error) => log(error.message, "stderr"));
          log(`中心原料：${payload.result.materialDir}`);
          updateActionAvailability();
          return;
        }
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
        isMaterialBuilding = false;
        isPublishing = false;
        setButtonBusy($("buildBtn"), false, "生成中...");
        setButtonBusy($("materialBtn"), false, "生成中...");
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
  $("materialBtn").addEventListener("click", () => {
    withButtonState("materialBtn", "生成中...", createMaterial, { keepBusy: true }).catch((error) => {
      isMaterialBuilding = false;
      setButtonBusy($("materialBtn"), false, "生成中...");
      updateActionAvailability();
      log(error.message, "stderr");
    });
  });
  $("materialSelect").addEventListener("change", syncSelectedMaterial);
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
