import express from "express";
import { WebSocketServer } from "ws";
import open from "open";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/events" });
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workspaceDir = path.join(rootDir, "workspace");
const projectContextTemplateDir = path.join(rootDir, "templates", "project-context");
const defaultPort = Number(process.env.KB_PORT || 3187);
const runRootDir = path.join(workspaceDir, "runs");
const isMainModule = Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
const cliMode = isMainModule && process.argv[2] === "build";

app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.join(rootDir, "public")));

const clients = new Set();
wss.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(`端口 ${defaultPort} 已被占用。服务可能已经在运行： http://127.0.0.1:${defaultPort}`);
    process.exit(1);
  }
  throw error;
});
wss.on("connection", (ws) => {
  clients.add(ws);
  ws.on("close", () => clients.delete(ws));
});

function emit(event, payload) {
  if (cliMode && event === "log") {
    const prefix = payload.level === "stderr" ? "[err]" : payload.level === "stdout" ? "[out]" : "[info]";
    process.stdout.write(`${prefix} ${payload.message}${payload.message.endsWith("\n") ? "" : "\n"}`);
  }
  if (cliMode && event === "task") {
    if (payload.status === "running") console.log(`[task] ${payload.step}`);
    if (payload.status === "failed") console.error(`[task] failed: ${payload.error}`);
  }
  const message = JSON.stringify({ event, payload, ts: new Date().toISOString() });
  for (const ws of clients) {
    if (ws.readyState === ws.OPEN) ws.send(message);
  }
}

function slugify(value) {
  return String(value || "domain")
    .trim()
    .replace(/[^\p{L}\p{N}._-]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase() || "domain";
}

function assertInsideUserSpace(targetPath) {
  const resolved = path.resolve(targetPath);
  const allowedRoots = [os.homedir(), "/Users", "/Volumes", "/tmp", "/private/tmp"];
  if (!allowedRoots.some((root) => resolved === root || resolved.startsWith(root + path.sep))) {
    throw new Error(`路径不在允许范围内：${resolved}`);
  }
  return resolved;
}

async function pathInfo(inputPath) {
  if (!inputPath) return { exists: false };
  const resolved = assertInsideUserSpace(inputPath);
  try {
    const stat = await fs.stat(resolved);
    return { path: resolved, exists: true, directory: stat.isDirectory(), file: stat.isFile() };
  } catch {
    return { path: resolved, exists: false };
  }
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    emit("log", { level: "info", message: `$ ${command} ${args.join(" ")}` });
    const child = spawn(command, args, {
      cwd: options.cwd || rootDir,
      env: { ...process.env, ...options.env },
      shell: false,
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      output += text;
      emit("log", { level: "stdout", message: text });
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      output += text;
      emit("log", { level: "stderr", message: text });
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(output);
      else reject(new Error(`${command} 退出码 ${code}`));
    });
  });
}

function runQuietCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd || rootDir,
      env: { ...process.env, ...options.env },
      shell: false,
    });
    let output = "";
    let errorOutput = "";
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      errorOutput += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(output.trim());
      else reject(new Error(errorOutput.trim() || `${command} 退出码 ${code}`));
    });
  });
}

async function commandExists(command, args = ["--version"]) {
  try {
    await runCommand(command, args);
    return true;
  } catch {
    return false;
  }
}

async function collectFiles(dir, extensions) {
  const result = [];
  async function walk(current) {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (extensions.includes(path.extname(entry.name).toLowerCase())) result.push(full);
    }
  }
  await walk(dir);
  return result;
}

function normalizeRepoPaths(payload) {
  const rawPaths = Array.isArray(payload.repoDirs)
    ? payload.repoDirs
    : String(payload.repoDirs || "").split(/\r?\n/);
  if (payload.repoDir) rawPaths.push(payload.repoDir);
  return [...new Set(rawPaths.map((value) => String(value || "").trim()).filter(Boolean))];
}

async function inspectRepository(repoDir) {
  const resolved = assertInsideUserSpace(repoDir);
  const info = await pathInfo(resolved);
  if (!info.exists || !info.directory) throw new Error(`代码仓库目录不存在：${resolved}`);
  let commit = "UNVERIFIED";
  try {
    commit = await runQuietCommand("git", ["rev-parse", "HEAD"], { cwd: resolved });
  } catch {
    emit("log", { level: "info", message: `未读取到 Git commit，按 UNVERIFIED 记录：${resolved}` });
  }
  return { name: path.basename(resolved), path: resolved, commit };
}

function buildPrompt({ productName, domainName, domainScope, convertedDocsDir, repositories, repoManifestPath, draftsDir, domainSlug }) {
  const scopeText = domainScope || "未填写。请严格围绕本次业务域名称整理，遇到相邻业务域只记录依赖关系，不展开成主知识。";
  const repoLines = repositories.map((repo) => `- ${repo.name}（commit: ${repo.commit}）：${repo.contextPath}`).join("\n") || "- 未提供代码仓库";
  return `你是资深产品经理、业务分析师、架构师和测试专家。请基于下面材料，为「${productName}」的业务域「${domainName}」生成可长期维护、供产品/开发/测试共同使用的存量代码知识库。

材料目录：
- 非代码资料转换结果：${convertedDocsDir}
- 多仓库清单：${repoManifestPath}
${repoLines}

输出目录：
- ${draftsDir}

最终发布位置会是：
- code-knowledge/<product>/<domain>/
- 本次产品或业务中心：${productName}
- 本次业务域：${domainName}
- 本次业务域边界：${scopeText}

默认产物采用“本体约束 ontology + 业务语义 domains + 代码事实 graph + 业务代码桥接 mappings”的四层结构：

1. domains/${domainSlug}/overview.md
   - 业务域做什么、解决什么问题、主要角色、模块关系

2. domains/${domainSlug}/flows.md
   - 核心流程，包含入口、前置条件、核心步骤、状态变化、失败/回滚场景

3. domains/${domainSlug}/pitfalls.md
   - 历史问题、已知风险、复杂调用链、SQL/事务/兼容风险

4. domains/${domainSlug}/glossary.yaml
   - 术语表

5. domains/${domainSlug}/concepts.yaml
   - 核心业务概念；type 必须使用 ontology/concept-types.yaml 定义的 11 类之一
   - domain_entity：有业务身份和生命周期的核心对象
   - relation_entity：可独立维护的对象间业务关系
   - state_entity：业务对象当前可判断、可迁移的状态
   - process_entity：由多个步骤组成的业务过程
   - process_state：异步流程、任务或审批的阶段状态
   - value_object：没有独立身份、由属性值定义的概念
   - business_identifier：稳定识别业务对象的编码或组合键
   - business_rule：被多个能力共享的规则性概念
   - async_artifact：消息、事件、任务记录或中转数据
   - config_entity：影响业务行为的开关、阈值、字典或配置
   - external_system：业务语义层依赖或同步的外部平台

6. domains/${domainSlug}/capabilities.yaml
   - 业务能力，每个能力至少关联概念、规则或代码入口

7. domains/${domainSlug}/rules.yaml
   - 业务规则，必须区分 VERIFIED / UNVERIFIED，重要结论标注来源

8. graph/curated/${domainSlug}.graph.yaml
   - 代码事实层，节点仅限 Service / Controller / ServiceClass / Repository / Mapper / Table / Entity / Convertor / Enum / FeignClient / MQTopic / Consumer / Job / Util / ExternalSystem / BusinessDomain
   - 边仅限 invokes / calls / feign_calls / reads / writes / references / converts / publishes / consumes / syncs_to / maps / belongs_to / triggers

9. mappings/${domainSlug}.mapping.yaml
   - 桥接层，把 capability/rule 映射到 Controller / Service / Mapper / Table / MQ / 外部系统

要求：
- 使用中文。
- 不要大段复制源码。
- 不要虚构业务规则，无法确认的标注“需确认”。
- 区分“代码事实”和“业务推断”。
- 先识别业务语义，再选择最具体的 concept type；不要用 BusinessDomain、Java 类名或代码节点类型代替业务概念类型。
- 每个 concept 必须包含 id、name、type、desc、related、status；related 只引用当前域已定义概念，跨域引用必须明确登记来源。
- 同一业务概念不要仅因分布在多个服务而重复创建；服务归属进入 graph，业务到代码的联系进入 mappings。
- 严格围绕本次业务域边界整理；相邻业务域只作为依赖、上下游或排除项说明。
- 重要结论后标注来源，例如：来源：ClassName#method 或 Mapper.xml#selectXxx。
- graph 中带 path 的节点必须是真实文件路径；不确定时不要写入事实层，改写入 UNVERIFIED 或 pitfalls。
- path 格式统一为 <仓库名>/<仓库内相对路径>，跨服务同名节点以仓库名消歧。
- meta.verified_commits 必须逐仓写入上面的 commit；commit 为 UNVERIFIED 时不得声称已验证。
- 每条规则写 status、checked_scope、impl（节点、path、行号）；推断不得标为 VERIFIED。
- MQ 的 publishes/consumes 应成对核查；外部系统使用 EXT: 前缀，MQ 使用 MQ: 前缀。
- mappings 必须让业务问题能一跳定位到代码节点。
- 每个 capability 至少映射一个代码节点，每条 high 规则必须有 rule_mapping。
- 先定边界，再沿入口调用、跨服务 Feign、MQ、数据表、外部系统四条主线抽取，最后检查遗漏闭环。
- 面向产品写清业务口径，面向开发写清调用与数据事实，面向测试写清规则、状态迁移、异常和回归点。`;
}

async function writeDraftTemplates(draftsDir, domainName, domainSlug, verifiedCommits = {}) {
  await fs.mkdir(draftsDir, { recursive: true });
  const domainDir = path.join(draftsDir, "domains", domainSlug);
  await fs.cp(path.join(projectContextTemplateDir, "ontology"), path.join(draftsDir, "ontology"), {
    recursive: true,
    force: false,
    errorOnExist: false,
  });
  await fs.cp(path.join(projectContextTemplateDir, "rules"), path.join(draftsDir, "rules"), {
    recursive: true,
    force: false,
    errorOnExist: false,
  });
  await fs.mkdir(path.join(draftsDir, "graph", "curated"), { recursive: true });
  await fs.mkdir(path.join(draftsDir, "mappings"), { recursive: true });
  await fs.mkdir(domainDir, { recursive: true });

  const markdownFiles = {
    [path.join(domainDir, "overview.md")]: `# ${domainName} - 业务域概览\n\n## 业务边界\n\n## 主要角色\n\n## 模块关系\n\n## 代码事实\n\n## 业务推断\n\n## 需确认\n`,
    [path.join(domainDir, "flows.md")]: `# ${domainName} - 核心流程\n\n## 流程清单\n\n## 代码事实\n\n## 业务推断\n\n## 需确认\n`,
    [path.join(domainDir, "pitfalls.md")]: `# ${domainName} - 风险和历史坑\n\n## 高风险代码\n\n## SQL / 事务风险\n\n## 历史兼容逻辑\n\n## 需确认\n`,
  };
  for (const [file, content] of Object.entries(markdownFiles)) {
    if (!fsSync.existsSync(file)) await fs.writeFile(file, content);
  }

  const yamlFiles = {
    [path.join(domainDir, "glossary.yaml")]: `terms:\n  - term: ${domainName}\n    meaning: 需补充\n    status: UNVERIFIED\n`,
    [path.join(domainDir, "concepts.yaml")]: `concepts:\n  - id: CONCEPT:${domainSlug}\n    name: ${domainName}\n    type: domain_entity\n    desc: 需补充\n    related: []\n    status: UNVERIFIED\n`,
    [path.join(domainDir, "capabilities.yaml")]: `capabilities:\n  - id: CAP:${domainSlug}:main\n    name: 核心能力\n    desc: 需补充\n    concepts:\n      - CONCEPT:${domainSlug}\n    rules: []\n    status: UNVERIFIED\n`,
    [path.join(domainDir, "rules.yaml")]: `rules:\n  - id: RULE:${domainSlug}:main\n    name: 核心业务规则\n    subject: ${domainName}\n    severity: medium\n    desc: 需补充\n    status: UNVERIFIED\n    checked_scope: 待 AI 深读代码和人工确认\n`,
    [path.join(draftsDir, "graph", "curated", `${domainSlug}.graph.yaml`)]: `meta:\n  domain: ${domainSlug}\n  generated_at: ${new Date().toISOString()}\n  verified_commits: ${JSON.stringify(verifiedCommits)}\nnodes:\n  - id: DOMAIN:${domainSlug}\n    type: BusinessDomain\n    name: ${domainName}\n    desc: ${domainName} 业务域，待补充代码事实节点\nedges: []\n`,
    [path.join(draftsDir, "mappings", `${domainSlug}.mapping.yaml`)]: `domain: ${domainSlug}\ncapability_mappings: []\nrule_mappings: []\nentry_points: []\n`,
  };
  for (const [file, content] of Object.entries(yamlFiles)) {
    if (!fsSync.existsSync(file)) await fs.writeFile(file, content);
  }
}

async function convertDocs(rawDocsDir, convertedDocsDir) {
  await fs.mkdir(convertedDocsDir, { recursive: true });
  const files = await collectFiles(rawDocsDir, [".docx", ".doc", ".pdf", ".xlsx", ".xls", ".pptx", ".ppt", ".html", ".htm"]);
  if (files.length === 0) {
    emit("log", { level: "info", message: "未发现需要 MarkItDown 转换的非代码资料。" });
    return;
  }
  const hasMarkitdown = await commandExists("markitdown", ["--version"]);
  if (!hasMarkitdown) throw new Error("未找到 markitdown 命令，请先安装：pip install markitdown");
  for (const file of files) {
    const relative = path.relative(rawDocsDir, file);
    const out = path.join(convertedDocsDir, relative.replace(path.extname(relative), ".md"));
    await fs.mkdir(path.dirname(out), { recursive: true });
    const markdown = await runCommand("markitdown", [file]);
    await fs.writeFile(out, markdown);
    emit("log", { level: "info", message: `已转换：${file} -> ${out}` });
  }
}

async function runRepomix(repoDir, outputPath) {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await runCommand("npx", ["-y", "repomix", repoDir, "--output", outputPath], { cwd: repoDir });
}

async function copyDir(source, target) {
  await fs.mkdir(target, { recursive: true });
  await fs.cp(source, target, { recursive: true, force: true });
}

async function publishKnowledgeAssets(draftsDir, publishDir) {
  await fs.mkdir(publishDir, { recursive: true });
  const assetDirs = ["ontology", "domains", "graph", "mappings", "rules"];
  const copied = [];
  for (const dirName of assetDirs) {
    const source = path.join(draftsDir, dirName);
    if (!fsSync.existsSync(source)) continue;
    const target = path.join(publishDir, dirName);
    await fs.cp(source, target, { recursive: true, force: true });
    copied.push(dirName);
  }
  return {
    copied,
    skipped: ["AI_PROMPT.md"],
  };
}

async function buildKnowledgeBase(payload, taskId = crypto.randomUUID()) {
  emit("task", { taskId, status: "running", step: "prepare" });
  const productName = String(payload.productName || payload.serviceName || "").trim();
  if (!productName) throw new Error("请填写产品或业务中心名称");
  const domainName = String(payload.domainName || "").trim();
  if (!domainName) throw new Error("请填写业务域名称");
  const domainScope = String(payload.domainScope || "").trim();
  const productSlug = slugify(payload.productSlug || payload.serviceSlug || productName);
  const domainSlug = slugify(payload.domainSlug || domainName);
  const repoPaths = normalizeRepoPaths(payload);
  const rawDocsDir = payload.rawDocsDir ? assertInsideUserSpace(payload.rawDocsDir) : "";
  if (!payload.knowledgeRagDocsDir) throw new Error("请选择 knowledge-rag 文档目录");
  const knowledgeRagDocsDir = assertInsideUserSpace(payload.knowledgeRagDocsDir);
  if (repoPaths.length === 0 && !rawDocsDir) throw new Error("请至少添加一个代码仓库或补充资料目录");

  const repositories = [];
  for (const repoPath of repoPaths) repositories.push(await inspectRepository(repoPath));
  const duplicateNames = repositories.filter((repo, index) => repositories.findIndex((item) => item.name === repo.name) !== index);
  if (duplicateNames.length) throw new Error(`仓库目录名重复，无法生成稳定服务标识：${[...new Set(duplicateNames.map((repo) => repo.name))].join(", ")}`);

  const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${productSlug}-${domainSlug}`;
  const runDir = path.join(runRootDir, runId);
  const convertedDocsDir = path.join(runDir, "converted-docs");
  const repomixDir = path.join(runDir, "repomix");
  const repoManifestPath = path.join(repomixDir, "README.md");
  const draftsDir = path.join(runDir, "drafts");
  const publishDir = path.join(knowledgeRagDocsDir, "code-knowledge", productSlug, domainSlug);

  await fs.mkdir(runDir, { recursive: true });

  if (rawDocsDir) {
    emit("task", { taskId, status: "running", step: "convert-docs" });
    await convertDocs(rawDocsDir, convertedDocsDir);
  } else {
    await fs.mkdir(convertedDocsDir, { recursive: true });
  }

  await fs.mkdir(repomixDir, { recursive: true });
  for (const repo of repositories) {
    emit("task", { taskId, status: "running", step: `repomix:${repo.name}` });
    repo.contextPath = path.join(repomixDir, `${slugify(repo.name)}.md`);
    await runRepomix(repo.path, repo.contextPath);
  }
  await fs.writeFile(
    repoManifestPath,
    `# ${productName} / ${domainName} 多仓库代码上下文\n\n${repositories.map((repo) => `- ${repo.name}\n  - 路径：${repo.path}\n  - commit：${repo.commit}\n  - 上下文：${repo.contextPath}`).join("\n") || "未提供代码仓库。"}\n`,
  );

  emit("task", { taskId, status: "running", step: "drafts" });
  const verifiedCommits = Object.fromEntries(repositories.map((repo) => [repo.name, repo.commit]));
  await writeDraftTemplates(draftsDir, domainName, domainSlug, verifiedCommits);
  const promptPath = path.join(draftsDir, "AI_PROMPT.md");
  await fs.writeFile(promptPath, buildPrompt({ productName, domainName, domainScope, convertedDocsDir, repositories, repoManifestPath, draftsDir, domainSlug }));
  await fs.writeFile(
    path.join(runDir, "README.md"),
    `# ${productName} / ${domainName} 知识库构建任务\n\n- 产品或业务中心：${productName}\n- 业务域：${domainName}\n- 业务域边界：${domainScope || "未填写"}\n- 关联服务：${repositories.map((repo) => repo.name).join("、") || "无"}\n- 运行目录：${runDir}\n- 转换资料：${convertedDocsDir}\n- 多仓库清单：${repoManifestPath}\n- 草稿目录：${draftsDir}\n- AI 提示词：${promptPath}\n- 发布目录：${publishDir}\n\n下一步：复制 AI_PROMPT.md 给 AI 执行，人工校准 drafts 后发布入库，并通过 knowledge-rag MCP 调用 reindex_documents(force=true)。\n`,
  );

  return {
    taskId,
    productName,
    productSlug,
    domainName,
    domainSlug,
    domainScope,
    runDir,
    convertedDocsDir,
    repoManifestPath,
    repositories,
    draftsDir,
    promptPath,
    publishDir,
    knowledgeRagDocsDir,
  };
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, workspaceDir, runRootDir });
});

app.post("/api/path-info", async (req, res) => {
  try {
    res.json(await pathInfo(req.body.path));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get("/api/suggestions", (_req, res) => {
  res.json({
    suggestions: [
      path.join(os.homedir(), "Documents", "work"),
      path.join(os.homedir(), "Documents", "personal"),
      path.join(os.homedir(), "Documents", "work", "knowledge-rag", "documents"),
    ],
  });
});

app.post("/api/choose-directory", async (req, res) => {
  try {
    if (process.platform !== "darwin") {
      throw new Error("当前目录选择器仅支持 macOS；可直接粘贴绝对路径。");
    }
    const defaultLocation = req.body?.defaultPath ? assertInsideUserSpace(req.body.defaultPath) : os.homedir();
    const prompt = String(req.body?.prompt || "选择目录").replaceAll('"', '\\"');
    const script = `POSIX path of (choose folder with prompt "${prompt}" default location POSIX file "${defaultLocation}")`;
    const selectedPath = await runQuietCommand("osascript", ["-e", script]);
    res.json({ path: selectedPath });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/read-file", async (req, res) => {
  try {
    const filePath = assertInsideUserSpace(req.body.path);
    const content = await fs.readFile(filePath, "utf8");
    res.json({ path: filePath, content });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/open-path", async (req, res) => {
  try {
    const targetPath = assertInsideUserSpace(req.body.path);
    await open(targetPath);
    res.json({ ok: true, path: targetPath });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/build", async (req, res) => {
  const taskId = crypto.randomUUID();
  res.json({ taskId });
  queueMicrotask(async () => {
    try {
      const result = await buildKnowledgeBase(req.body || {}, taskId);
      emit("task", {
        taskId,
        status: "done",
        step: "done",
        result,
      });
    } catch (error) {
      emit("task", { taskId, status: "failed", error: error.message });
    }
  });
});

app.post("/api/publish", async (req, res) => {
  try {
    const draftsDir = assertInsideUserSpace(req.body.draftsDir);
    const publishDir = req.body.publishDir
      ? assertInsideUserSpace(req.body.publishDir)
      : path.join(
          assertInsideUserSpace(req.body.knowledgeRagDocsDir),
          "code-knowledge",
          slugify(req.body.productSlug || req.body.productName || req.body.serviceSlug || req.body.serviceName),
          slugify(req.body.domainSlug || req.body.domainName),
        );
    const result = await publishKnowledgeAssets(draftsDir, publishDir);
    res.json({ ok: true, publishDir, ...result });
    emit("log", { level: "info", message: `已发布知识资产：${result.copied.join(", ")} -> ${publishDir}` });
    emit("log", { level: "info", message: `已跳过非知识库文件：${result.skipped.join(", ")}` });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

function parseCliBuildArgs(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--domain") {
      result.domainName = next;
      i += 1;
    } else if (arg === "--scope") {
      result.domainScope = next;
      i += 1;
    } else if (arg === "--product" || arg === "--service") {
      result.productName = next;
      i += 1;
    } else if (arg === "--repo") {
      result.repoDirs ||= [];
      result.repoDirs.push(next);
      i += 1;
    } else if (arg === "--docs") {
      result.rawDocsDir = next;
      i += 1;
    } else if (arg === "--knowledge-rag-docs") {
      result.knowledgeRagDocsDir = next;
      i += 1;
    }
  }
  return result;
}

if (!isMainModule) {
  // Imported by tests or other local tooling.
} else if (cliMode) {
  const payload = parseCliBuildArgs(process.argv.slice(3));
  buildKnowledgeBase(payload)
    .then((result) => {
      console.log("\n构建原料已完成：");
      console.log(`运行目录：${result.runDir}`);
      if (result.domainScope) console.log(`业务域边界：${result.domainScope}`);
      console.log(`草稿目录：${result.draftsDir}`);
      console.log(`AI 提示词：${result.promptPath}`);
      console.log(`多仓库清单：${result.repoManifestPath}`);
      console.log(`转换资料：${result.convertedDocsDir}`);
      console.log(`建议发布目录：${result.publishDir}`);
    })
    .catch((error) => {
      console.error(error.message);
      process.exit(1);
    });
} else {
  server.on("error", (error) => {
    if (error.code === "EADDRINUSE") {
      console.error(`端口 ${defaultPort} 已被占用。服务可能已经在运行： http://127.0.0.1:${defaultPort}`);
      process.exit(1);
    }
    throw error;
  });

  server.listen(defaultPort, async () => {
    const url = `http://127.0.0.1:${defaultPort}`;
    console.log(`Knowledge Builder 已启动：${url}`);
    if (!process.argv.includes("--no-open")) await open(url);
  });
}

export { buildKnowledgeBase, buildPrompt, normalizeRepoPaths, publishKnowledgeAssets, slugify, writeDraftTemplates };
