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
import { parse as parseYaml } from "yaml";
import {
  cancelExecution,
  detectExecutors,
  getExecution,
  listExecutions,
  startExecution,
} from "./executors.js";

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/events" });
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workspaceDir = path.join(rootDir, "workspace");
const projectContextTemplateDir = path.join(rootDir, "templates", "project-context");
const defaultPort = Number(process.env.KB_PORT || 3187);
const runRootDir = path.join(workspaceDir, "runs");
const materialRootDir = path.join(workspaceDir, "materials");
const knowledgeRootDir = path.join(workspaceDir, "knowledge");
const isMainModule = Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
const cliCommand = isMainModule ? process.argv[2] : "";
const cliMode = ["build", "material", "domain", "executors", "execute", "validate", "export"].includes(cliCommand);

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

通用导出目录结构：
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
- 采用“范围优先、证据扩展”的分析策略：先从业务域入口（Controller/API/Event/Job）、入口调用到 Service/Domain Service，再追踪 Feign/MQ、Repository/Mapper、Table/Entity 和外部系统；只有当调用链或规则需要时，才补读配置、SQL、转换器、枚举和测试。
- 分两阶段执行：阶段一只定向定位入口、事件、Job 及其直接调用，先产出候选文件清单；阶段二仅沿候选链路递归读取，最多扩展到跨服务边界、读写表、异常/事务和相关测试。
- 不要从头到尾逐字阅读所有仓库原料，也不要为了补充背景扫描与本业务域无调用关系的模块；优先使用多仓库清单和定向搜索定位文件，再读取命中的上下文。
- 每条主流程至少闭环到“入口→核心服务→数据读写/跨服务调用→状态或结果→异常/回滚”；完成主链路后执行一次遗漏检查，确认未漏掉 Feign、MQ、定时任务、事务和测试证据。
- 相邻模块只读取用于确认边界或依赖的最小上下文；无法证明与本域相关时，记录为排除项或需确认，不扩展为主知识。
- 每个主流程至少保留 1 个入口、1 条完整调用链、1 项数据或外部交互、1 项异常/回滚和 1 条测试证据；没有测试证据时标记 UNVERIFIED，不得静默跳过。无调用证据的模块列入排除项，范围外依赖最多保留 1 跳摘要。
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

async function exportKnowledgeAssets(draftsDir, exportDir) {
  await fs.mkdir(exportDir, { recursive: true });
  const assetDirs = ["ontology", "domains", "graph", "mappings", "rules"];
  const copied = [];
  for (const dirName of assetDirs) {
    const source = path.join(draftsDir, dirName);
    if (!fsSync.existsSync(source)) continue;
    const target = path.join(exportDir, dirName);
    await fs.cp(source, target, { recursive: true, force: true });
    copied.push(dirName);
  }
  return {
    copied,
    skipped: ["AI_PROMPT.md"],
  };
}

function assertRunDir(targetPath) {
  const resolved = assertInsideUserSpace(targetPath);
  const root = path.resolve(runRootDir);
  if (resolved === root || !resolved.startsWith(root + path.sep)) {
    throw new Error(`运行目录必须位于工作区 runs 下：${resolved}`);
  }
  return resolved;
}

async function readRun(runDir) {
  const resolved = assertRunDir(runDir);
  const manifestPath = path.join(resolved, "run.json");
  try {
    const run = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    const draftsDir = path.resolve(String(run.draftsDir || ""));
    if (!run.runId || !run.productSlug || !run.domainSlug || !run.draftsDir) throw new Error("字段不完整");
    if (draftsDir !== path.join(resolved, "drafts")) throw new Error("草稿目录不属于当前任务");
    return { ...run, draftsDir, runDir: resolved, manifestPath };
  } catch {
    throw new Error(`无效的业务域任务，缺少或无法读取 run.json：${resolved}`);
  }
}

async function updateRun(runDir, changes, eventType) {
  const run = await readRun(runDir);
  const now = new Date().toISOString();
  const updated = {
    ...run,
    ...changes,
    updatedAt: now,
    lifecycle: [
      ...(Array.isArray(run.lifecycle) ? run.lifecycle : []),
      ...(eventType ? [{ type: eventType, at: now }] : []),
    ],
  };
  delete updated.runDir;
  delete updated.manifestPath;
  const manifestPath = path.join(runDir, "run.json");
  await fs.writeFile(manifestPath, JSON.stringify(updated, null, 2) + "\n");
  return { ...updated, runDir, manifestPath };
}

async function recoverInterruptedRuns() {
  let entries = [];
  try {
    entries = await fs.readdir(runRootDir, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return 0;
    throw error;
  }
  let recovered = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const runDir = path.join(runRootDir, entry.name);
    try {
      const run = await readRun(runDir);
      if (run.status !== "executing") continue;
      await updateRun(runDir, {
        status: "interrupted",
        activeExecution: null,
        lastExecution: {
          ...run.activeExecution,
          status: "interrupted",
          finishedAt: new Date().toISOString(),
        },
      }, "execution_interrupted");
      recovered += 1;
    } catch {
      // Ignore legacy or incomplete run directories.
    }
  }
  return recovered;
}

async function validateKnowledgeAssets(draftsDir) {
  const resolved = assertInsideUserSpace(draftsDir);
  const required = [
    "ontology/node-types.yaml",
    "ontology/relation-types.yaml",
    "ontology/concept-types.yaml",
    "rules/validation-rules.yaml",
  ];
  const errors = [];
  const warnings = [];
  const yamlDocuments = new Map();
  let domainSlugs = [];
  try {
    domainSlugs = (await fs.readdir(path.join(resolved, "domains"), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    errors.push("缺少 domains 目录");
  }
  if (domainSlugs.length === 0 && errors.length === 0) errors.push("domains 目录中没有业务域");
  for (const domainSlug of domainSlugs) {
    required.push(
      `domains/${domainSlug}/overview.md`,
      `domains/${domainSlug}/flows.md`,
      `domains/${domainSlug}/pitfalls.md`,
      `domains/${domainSlug}/glossary.yaml`,
      `domains/${domainSlug}/concepts.yaml`,
      `domains/${domainSlug}/capabilities.yaml`,
      `domains/${domainSlug}/rules.yaml`,
      `graph/curated/${domainSlug}.graph.yaml`,
      `mappings/${domainSlug}.mapping.yaml`,
    );
  }
  for (const relativePath of required) {
    try {
      const content = await fs.readFile(path.join(resolved, relativePath), "utf8");
      if (!content.trim()) errors.push(`文件为空：${relativePath}`);
      else {
        if (/需补充|待补充/.test(content)) errors.push(`仍包含待补充内容：${relativePath}`);
        if (/\.ya?ml$/i.test(relativePath)) {
          try {
            yamlDocuments.set(relativePath, parseYaml(content));
          } catch (error) {
            errors.push(`YAML 语法错误：${relativePath}（${error.message.split("\n")[0]}）`);
          }
        }
      }
    } catch {
      errors.push(`缺少文件：${relativePath}`);
    }
  }

  const nodeDefinitions = yamlDocuments.get("ontology/node-types.yaml")?.node_types || [];
  const relationDefinitions = yamlDocuments.get("ontology/relation-types.yaml")?.relation_types || [];
  const conceptDefinitions = yamlDocuments.get("ontology/concept-types.yaml")?.concept_types || [];
  const nodeTypes = new Map(nodeDefinitions.map((item) => [item.type, item]));
  const relationTypes = new Map(relationDefinitions.map((item) => [item.rel, item]));
  const conceptTypes = new Set(conceptDefinitions.map((item) => item.type));

  for (const domainSlug of domainSlugs) {
    const concepts = yamlDocuments.get(`domains/${domainSlug}/concepts.yaml`)?.concepts || [];
    const capabilities = yamlDocuments.get(`domains/${domainSlug}/capabilities.yaml`)?.capabilities || [];
    const businessRules = yamlDocuments.get(`domains/${domainSlug}/rules.yaml`)?.rules || [];
    const graph = yamlDocuments.get(`graph/curated/${domainSlug}.graph.yaml`) || {};
    const mapping = yamlDocuments.get(`mappings/${domainSlug}.mapping.yaml`) || {};
    const conceptIds = new Set(concepts.map((item) => item.id).filter(Boolean));
    const capabilityIds = new Set(capabilities.map((item) => item.id).filter(Boolean));
    const nodeById = new Map();

    for (const concept of concepts) {
      if (!concept.id || !concept.name || !concept.type || !concept.desc) errors.push(`业务概念缺少必填字段：${domainSlug}`);
      if (concept.type && !conceptTypes.has(concept.type)) errors.push(`未定义的业务概念类型：${concept.type}`);
      for (const relatedId of Array.isArray(concept.related) ? concept.related : []) {
        if (!conceptIds.has(relatedId) && !String(relatedId).includes(":")) warnings.push(`跨域概念引用未明确登记：${relatedId}`);
      }
    }
    for (const capability of capabilities) {
      const linkedConcepts = Array.isArray(capability.concepts) ? capability.concepts : [];
      if (linkedConcepts.length === 0) errors.push(`业务能力未关联概念：${capability.id || domainSlug}`);
      for (const conceptId of linkedConcepts) {
        if (!conceptIds.has(conceptId)) errors.push(`业务能力引用不存在的概念：${capability.id || domainSlug} -> ${conceptId}`);
      }
    }
    for (const node of Array.isArray(graph.nodes) ? graph.nodes : []) {
      if (!node.id || !node.type) {
        errors.push(`图谱节点缺少 id 或 type：${domainSlug}`);
        continue;
      }
      if (nodeById.has(node.id)) errors.push(`图谱节点 id 重复：${node.id}`);
      nodeById.set(node.id, node);
      const definition = nodeTypes.get(node.type);
      if (!definition) errors.push(`未定义的图谱节点类型：${node.type}`);
      for (const property of definition?.required || []) {
        if (node[property] === undefined || node[property] === null || node[property] === "") errors.push(`图谱节点缺少必填属性：${node.id}.${property}`);
      }
    }
    for (const edge of Array.isArray(graph.edges) ? graph.edges : []) {
      const definition = relationTypes.get(edge.rel);
      const fromNode = nodeById.get(edge.from);
      const toNode = nodeById.get(edge.to);
      if (!definition) errors.push(`未定义的图谱关系：${edge.rel || "<empty>"}`);
      if (!fromNode) errors.push(`图谱关系起点不存在：${edge.from || "<empty>"}`);
      if (!toNode) errors.push(`图谱关系终点不存在：${edge.to || "<empty>"}`);
      if (definition && fromNode && !definition.from?.includes(fromNode.type)) errors.push(`图谱关系起点类型不匹配：${edge.rel} ${fromNode.type}`);
      if (definition && toNode && !definition.to?.includes(toNode.type)) errors.push(`图谱关系终点类型不匹配：${edge.rel} ${toNode.type}`);
    }

    const capabilityMappings = Array.isArray(mapping.capability_mappings) ? mapping.capability_mappings : [];
    const ruleMappings = Array.isArray(mapping.rule_mappings) ? mapping.rule_mappings : [];
    const mappedCapabilities = new Set();
    for (const item of capabilityMappings) {
      const capabilityId = item.capability_id || item.capability || item.id;
      if (capabilityId) mappedCapabilities.add(capabilityId);
      if (capabilityId && !capabilityIds.has(capabilityId)) errors.push(`映射引用不存在的业务能力：${capabilityId}`);
      const graphNodes = item.graph_nodes || item.nodes || item.code_nodes || [];
      if (!Array.isArray(graphNodes) || graphNodes.length === 0) errors.push(`业务能力映射缺少代码节点：${capabilityId || domainSlug}`);
      for (const nodeId of Array.isArray(graphNodes) ? graphNodes : []) {
        if (!nodeById.has(nodeId)) errors.push(`业务能力映射引用不存在的图谱节点：${nodeId}`);
      }
    }
    for (const capabilityId of capabilityIds) {
      if (!mappedCapabilities.has(capabilityId)) errors.push(`业务能力缺少代码映射：${capabilityId}`);
    }
    const mappedRules = new Set(ruleMappings.map((item) => item.rule_id || item.rule || item.id).filter(Boolean));
    for (const rule of businessRules) {
      if (rule.severity === "high" && !mappedRules.has(rule.id)) errors.push(`高优先级规则缺少代码映射：${rule.id}`);
    }
    for (const item of ruleMappings) {
      for (const nodeId of item.graph_nodes || item.nodes || item.code_nodes || []) {
        if (!nodeById.has(nodeId)) errors.push(`规则映射引用不存在的图谱节点：${nodeId}`);
      }
    }
  }
  return {
    valid: errors.length === 0,
    checkedAt: new Date().toISOString(),
    draftsDir: resolved,
    domainSlugs,
    checkedFiles: required.length,
    errors,
    warnings,
  };
}

async function validateRun(runDir) {
  const run = await readRun(runDir);
  const validation = await validateKnowledgeAssets(run.draftsDir);
  const updated = await updateRun(run.runDir, {
    status: validation.valid ? "validated" : "validation_failed",
    validation,
  }, validation.valid ? "validated" : "validation_failed");
  return { run: updated, validation };
}

async function exportRun(runDir, outputRootDir) {
  const run = await readRun(runDir);
  const validation = await validateKnowledgeAssets(run.draftsDir);
  if (!validation.valid) throw new Error(`知识资产校验失败：${validation.errors.join("；")}`);
  const resolvedOutputRoot = assertInsideUserSpace(outputRootDir || run.outputRootDir || knowledgeRootDir);
  const exportDir = path.join(resolvedOutputRoot, "code-knowledge", run.productSlug, run.domainSlug);
  const result = await exportKnowledgeAssets(run.draftsDir, exportDir);
  const exportedAt = new Date().toISOString();
  const updated = await updateRun(run.runDir, {
    status: "exported",
    outputRootDir: resolvedOutputRoot,
    exportDir,
    validation,
    lastExport: { exportedAt, exportDir, copied: result.copied },
  }, "exported");
  return { run: updated, validation, outputRootDir: resolvedOutputRoot, exportDir, ...result };
}

function assertMaterialDir(targetPath) {
  const resolved = assertInsideUserSpace(targetPath);
  const materialRoot = path.resolve(materialRootDir);
  if (resolved !== materialRoot && !resolved.startsWith(materialRoot + path.sep)) {
    throw new Error(`原料目录必须位于工作区 materials 下：${resolved}`);
  }
  return resolved;
}

async function readMaterial(materialDir) {
  const resolved = assertMaterialDir(materialDir);
  const manifestPath = path.join(resolved, "material.json");
  let material;
  try {
    material = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  } catch {
    throw new Error(`无效的中心原料，缺少或无法读取 material.json：${resolved}`);
  }
  if (!material.productName || !material.productSlug || !Array.isArray(material.repositories)) {
    throw new Error(`中心原料清单字段不完整：${manifestPath}`);
  }
  const materialPaths = [
    material.convertedDocsDir,
    material.repoManifestPath,
    ...material.repositories.map((repo) => repo.contextPath),
  ];
  if (materialPaths.some((value) => {
    const resolvedPath = path.resolve(String(value || ""));
    return resolvedPath !== resolved && !resolvedPath.startsWith(resolved + path.sep);
  })) {
    throw new Error(`中心原料清单包含原料目录之外的上下文路径：${manifestPath}`);
  }
  return { ...material, materialDir: resolved, manifestPath };
}

async function listMaterials() {
  if (!fsSync.existsSync(materialRootDir)) return [];
  const productDirs = await fs.readdir(materialRootDir, { withFileTypes: true });
  const materials = [];
  for (const productEntry of productDirs) {
    if (!productEntry.isDirectory()) continue;
    const productDir = path.join(materialRootDir, productEntry.name);
    const entries = await fs.readdir(productDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        materials.push(await readMaterial(path.join(productDir, entry.name)));
      } catch {
        // Ignore incomplete material directories left by interrupted builds.
      }
    }
  }
  return materials.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

async function createCenterMaterial(payload, taskId = crypto.randomUUID()) {
  emit("task", { taskId, taskType: "material", status: "running", step: "prepare-material" });
  const productName = String(payload.productName || payload.serviceName || "").trim();
  if (!productName) throw new Error("请填写产品或业务中心名称");
  const productSlug = slugify(payload.productSlug || payload.serviceSlug || productName);
  const repoPaths = normalizeRepoPaths(payload);
  const rawDocsDir = payload.rawDocsDir ? assertInsideUserSpace(payload.rawDocsDir) : "";
  if (repoPaths.length === 0 && !rawDocsDir) throw new Error("请至少添加一个代码仓库或补充资料目录");

  const repositories = [];
  for (const repoPath of repoPaths) repositories.push(await inspectRepository(repoPath));
  const duplicateNames = repositories.filter((repo, index) => repositories.findIndex((item) => item.name === repo.name) !== index);
  if (duplicateNames.length) throw new Error(`仓库目录名重复，无法生成稳定服务标识：${[...new Set(duplicateNames.map((repo) => repo.name))].join(", ")}`);

  const createdAt = new Date().toISOString();
  const materialId = `${createdAt.replace(/[:.]/g, "-")}-${productSlug}`;
  const materialDir = path.join(materialRootDir, productSlug, materialId);
  const convertedDocsDir = path.join(materialDir, "converted-docs");
  const repomixDir = path.join(materialDir, "repomix");
  const repoManifestPath = path.join(repomixDir, "README.md");
  await fs.mkdir(materialDir, { recursive: true });

  if (rawDocsDir) {
    emit("task", { taskId, taskType: "material", status: "running", step: "convert-docs" });
    await convertDocs(rawDocsDir, convertedDocsDir);
  } else {
    await fs.mkdir(convertedDocsDir, { recursive: true });
  }

  await fs.mkdir(repomixDir, { recursive: true });
  for (const repo of repositories) {
    emit("task", { taskId, taskType: "material", status: "running", step: `repomix:${repo.name}` });
    repo.contextPath = path.join(repomixDir, `${slugify(repo.name)}.md`);
    await runRepomix(repo.path, repo.contextPath);
  }
  await fs.writeFile(
    repoManifestPath,
    `# ${productName} 多仓库代码原料\n\n${repositories.map((repo) => `- ${repo.name}\n  - 路径：${repo.path}\n  - commit：${repo.commit}\n  - 上下文：${repo.contextPath}`).join("\n") || "未提供代码仓库。"}\n`,
  );

  const material = {
    version: 1,
    materialId,
    productName,
    productSlug,
    createdAt,
    rawDocsDir,
    convertedDocsDir,
    repoManifestPath,
    repositories,
  };
  await fs.writeFile(path.join(materialDir, "material.json"), JSON.stringify(material, null, 2) + "\n");
  return { taskId, ...material, materialDir };
}

async function createDomainFromMaterial(payload, taskId = crypto.randomUUID()) {
  emit("task", { taskId, taskType: "domain", status: "running", step: "prepare-domain" });
  const material = await readMaterial(payload.materialDir);
  const productName = material.productName;
  const productSlug = material.productSlug;
  const domainName = String(payload.domainName || "").trim();
  if (!domainName) throw new Error("请填写业务域名称");
  const domainScope = String(payload.domainScope || "").trim();
  const domainSlug = slugify(payload.domainSlug || domainName);
  const configuredOutputRoot = payload.outputRootDir || knowledgeRootDir;
  const outputRootDir = assertInsideUserSpace(configuredOutputRoot);
  const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${productSlug}-${domainSlug}`;
  const runDir = path.join(runRootDir, runId);
  const draftsDir = path.join(runDir, "drafts");
  const exportDir = path.join(outputRootDir, "code-knowledge", productSlug, domainSlug);
  await fs.mkdir(runDir, { recursive: true });

  emit("task", { taskId, taskType: "domain", status: "running", step: "drafts" });
  const verifiedCommits = Object.fromEntries(material.repositories.map((repo) => [repo.name, repo.commit]));
  await writeDraftTemplates(draftsDir, domainName, domainSlug, verifiedCommits);
  const promptPath = path.join(draftsDir, "AI_PROMPT.md");
  await fs.writeFile(promptPath, buildPrompt({
    productName,
    domainName,
    domainScope,
    convertedDocsDir: material.convertedDocsDir,
    repositories: material.repositories,
    repoManifestPath: material.repoManifestPath,
    draftsDir,
    domainSlug,
  }));
  await fs.writeFile(
    path.join(runDir, "README.md"),
    `# ${productName} / ${domainName} 知识库构建任务\n\n- 产品或业务中心：${productName}\n- 业务域：${domainName}\n- 业务域边界：${domainScope || "未填写"}\n- 中心原料：${material.materialDir}\n- 原料生成时间：${material.createdAt}\n- 关联服务：${material.repositories.map((repo) => repo.name).join("、") || "无"}\n- 运行目录：${runDir}\n- 转换资料：${material.convertedDocsDir}\n- 多仓库清单：${material.repoManifestPath}\n- 草稿目录：${draftsDir}\n- AI 提示词：${promptPath}\n- 建议导出目录：${exportDir}\n\n下一步：使用 AI_PROMPT.md 补全知识资产，人工校准并通过校验后，导出到任意知识库、Git 仓库或文档系统。\n`,
  );

  const createdAt = new Date().toISOString();
  const runManifest = {
    version: 1,
    runId,
    taskId,
    status: "draft_ready",
    createdAt,
    updatedAt: createdAt,
    productName,
    productSlug,
    domainName,
    domainSlug,
    domainScope,
    materialDir: material.materialDir,
    materialId: material.materialId,
    draftsDir,
    promptPath,
    outputRootDir,
    exportDir,
    lifecycle: [{ type: "draft_ready", at: createdAt }],
  };
  await fs.writeFile(path.join(runDir, "run.json"), JSON.stringify(runManifest, null, 2) + "\n");

  return {
    taskId,
    productName,
    productSlug,
    domainName,
    domainSlug,
    domainScope,
    runDir,
    materialDir: material.materialDir,
    materialId: material.materialId,
    materialCreatedAt: material.createdAt,
    convertedDocsDir: material.convertedDocsDir,
    repoManifestPath: material.repoManifestPath,
    repositories: material.repositories,
    draftsDir,
    promptPath,
    exportDir,
    outputRootDir,
    runManifestPath: path.join(runDir, "run.json"),
  };
}

async function buildKnowledgeBase(payload, taskId = crypto.randomUUID()) {
  const material = payload.materialDir
    ? await readMaterial(payload.materialDir)
    : await createCenterMaterial(payload, taskId);
  return createDomainFromMaterial({ ...payload, materialDir: material.materialDir }, taskId);
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, workspaceDir, runRootDir, materialRootDir, knowledgeRootDir });
});

app.get("/api/materials", async (_req, res) => {
  res.json({ materials: await listMaterials() });
});

app.get("/api/executors", async (_req, res) => {
  try {
    res.json({ executors: await detectExecutors({ cwd: rootDir }) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/executions", (_req, res) => {
  res.json({ executions: listExecutions() });
});

app.get("/api/executions/:executionId", (req, res) => {
  const execution = getExecution(req.params.executionId);
  if (!execution) return res.status(404).json({ error: "执行任务不存在" });
  return res.json({ execution });
});

app.get("/api/runs/:runId", async (req, res) => {
  try {
    res.json({ run: await readRun(path.join(runRootDir, req.params.runId)) });
  } catch (error) {
    res.status(404).json({ error: error.message });
  }
});

app.post("/api/executions", async (req, res) => {
  try {
    const { completion: _completion, ...execution } = await launchRunExecution(req.body || {});
    res.status(202).json(execution);
  } catch (error) {
    res.status(executionErrorStatus(error)).json({ error: error.message, code: error.code });
  }
});

app.delete("/api/executions/:executionId", (req, res) => {
  const cancelled = cancelExecution(req.params.executionId);
  if (!cancelled) return res.status(404).json({ error: "没有可取消的执行任务" });
  return res.json({ ok: true, executionId: req.params.executionId });
});

function startAsyncTask(req, res, taskType, action) {
  const taskId = crypto.randomUUID();
  res.json({ taskId });
  queueMicrotask(async () => {
    try {
      const result = await action(req.body || {}, taskId);
      emit("task", { taskId, taskType, status: "done", step: "done", result });
    } catch (error) {
      emit("task", { taskId, taskType, status: "failed", error: error.message });
    }
  });
}

function executionErrorStatus(error) {
  if (error?.code === "EXECUTION_BUSY") return 409;
  if (error?.code === "UNKNOWN_EXECUTOR" || error?.code === "PROMPT_REQUIRED") return 400;
  if (error?.code === "EXECUTOR_NOT_INSTALLED") return 422;
  return 400;
}

function sanitizeExecutionOutput(value) {
  return String(value || "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
}

const executionLogViews = new Map();

function summarizeExecutionOutput(executionId, stream, value) {
  const text = sanitizeExecutionOutput(value).trim();
  if (!text) return null;
  const state = executionLogViews.get(executionId) || { bytes: 0, lastAt: 0, announced: new Set(), texts: new Set() };
  state.bytes += Buffer.byteLength(text);
  const now = Date.now();
  let message = "";
  for (const line of text.split(/\r?\n/).filter(Boolean)) {
    try {
      const event = JSON.parse(line);
      const type = event.type || event.message?.type;
      const content = event.message?.content;
      const tool = Array.isArray(content) ? content.find((item) => item?.type === "tool_use") : null;
      if (tool?.name) {
        const input = tool.input || {};
        const target = input.file_path || input.path || input.pattern || input.command;
        const key = `tool:${tool.name}:${target || ""}`;
        if (!state.announced.has(key)) {
          state.announced.add(key);
          message = target ? `AI 调用 ${tool.name}：${String(target).slice(0, 160)}` : `AI 调用工具：${tool.name}`;
        }
      } else if (type === "assistant" || type === "text") {
        const textContent = Array.isArray(content)
          ? content.filter((item) => item?.type === "text").map((item) => item.text).join(" ")
          : typeof content === "string" ? content : event.text;
        const concise = String(textContent || "").replace(/\s+/g, " ").trim();
        if (concise && !state.texts.has(concise)) {
          state.texts.add(concise);
          message = `AI 工作摘要：${concise.slice(0, 220)}${concise.length > 220 ? "..." : ""}`;
        }
      } else if (type === "result" && !state.announced.has("result")) {
        state.announced.add("result");
        message = "AI 已返回整理结果，正在写入知识资产";
      }
    } catch {
      // Streaming chunks can contain partial JSON or plain progress text.
    }
  }
  if (!message && stream === "stderr") message = text.slice(0, 240);
  if (!message && now - state.lastAt >= 800) message = `AI 处理中，已接收约 ${Math.round(state.bytes / 1024)} KB 输出`;
  if (message) state.lastAt = now;
  executionLogViews.set(executionId, state);
  return message;
}

async function appendExecutionLog(runDir, event) {
  if (event.type !== "stdout" && event.type !== "stderr") return;
  const prefix = event.type === "stderr" ? "[err] " : "[out] ";
  await fs.appendFile(path.join(runDir, "execution.log"), `${prefix}${event.data}`);
}

async function launchRunExecution(payload) {
  if (!payload?.runDir) throw new Error("必须提供业务域运行目录");
  if (!payload?.executor) throw new Error("必须选择 Codex 或 Claude 执行器");
  const run = await readRun(payload.runDir);
  const executor = String(payload.executor || "").trim();
  const started = await startExecution({
    executor,
    runDir: run.runDir,
    runRootDir,
    promptPath: run.promptPath,
    onEvent(event) {
      appendExecutionLog(run.runDir, event).catch(() => {});
      if (event.type === "stdout" || event.type === "stderr") {
        const message = summarizeExecutionOutput(event.executionId, event.type, event.data);
        if (message) emit("log", {
          taskId: event.executionId,
          executionId: event.executionId,
          level: event.type === "stderr" ? "stderr" : "info",
          message,
        });
      }
      emit("execution", { ...event, runId: run.runId, executor });
    },
  });
  await updateRun(run.runDir, {
    status: "executing",
    activeExecution: {
      executionId: started.executionId,
      executor,
      startedAt: new Date().toISOString(),
    },
  }, "execution_started");

  started.completion.then(async (processResult) => {
    executionLogViews.delete(started.executionId);
    const validation = await validateKnowledgeAssets(run.draftsDir);
    const status = validation.valid ? "completed" : "validation_failed";
    const updated = await updateRun(run.runDir, {
      status,
      activeExecution: null,
      lastExecution: {
        executionId: started.executionId,
        executor,
        status: "completed",
        finishedAt: new Date().toISOString(),
        processResult,
      },
      validation,
    }, validation.valid ? "execution_completed" : "execution_validation_failed");
    emit("task", {
      taskId: started.executionId,
      executionId: started.executionId,
      taskType: "execution",
      status: validation.valid ? "done" : "failed",
      step: "validate",
      result: { run: updated, validation },
      error: validation.valid ? undefined : `知识资产校验失败：${validation.errors.join("；")}`,
    });
  }).catch(async (error) => {
    executionLogViews.delete(started.executionId);
    const cancelled = error?.code === "EXECUTION_CANCELLED";
    const updated = await updateRun(run.runDir, {
      status: cancelled ? "cancelled" : "failed",
      activeExecution: null,
      lastExecution: {
        executionId: started.executionId,
        executor,
        status: cancelled ? "cancelled" : "failed",
        errorCode: error?.code || "EXECUTION_FAILED",
        finishedAt: new Date().toISOString(),
      },
    }, cancelled ? "execution_cancelled" : "execution_failed").catch(() => null);
    emit("task", {
      taskId: started.executionId,
      executionId: started.executionId,
      taskType: "execution",
      status: cancelled ? "cancelled" : "failed",
      error: error.message,
      result: updated ? { run: updated } : undefined,
    });
  });
  return { executionId: started.executionId, executor, runId: run.runId, runDir: run.runDir, completion: started.completion };
}

app.post("/api/materials", (req, res) => startAsyncTask(req, res, "material", createCenterMaterial));
app.post("/api/domains", (req, res) => startAsyncTask(req, res, "domain", createDomainFromMaterial));

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
      knowledgeRootDir,
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
  startAsyncTask(req, res, "domain", buildKnowledgeBase);
});

app.post("/api/runs/:runId/validate", async (req, res) => {
  try {
    const result = await validateRun(path.join(runRootDir, req.params.runId));
    res.status(result.validation.valid ? 200 : 422).json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/runs/:runId/exports", async (req, res) => {
  try {
    const result = await exportRun(path.join(runRootDir, req.params.runId), req.body?.outputRootDir);
    res.json({ ok: true, ...result });
    emit("log", { level: "info", message: `已导出知识资产：${result.copied.join(", ")} -> ${result.exportDir}` });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/validate", async (req, res) => {
  try {
    if (!req.body?.runDir) throw new Error("必须提供业务域运行目录");
    const result = await validateRun(req.body.runDir);
    res.status(result.validation.valid ? 200 : 422).json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/export", async (req, res) => {
  try {
    if (!req.body?.runDir) throw new Error("必须提供业务域运行目录");
    const result = await exportRun(req.body.runDir, req.body.outputRootDir || req.body.outputDir);
    res.json({ ok: true, ...result });
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
    } else if (arg === "--output" || arg === "--output-dir") {
      result.outputRootDir = next;
      i += 1;
    } else if (arg === "--run") {
      result.runDir = next;
      i += 1;
    } else if (arg === "--executor") {
      result.executor = next;
      i += 1;
    } else if (arg === "--material") {
      result.materialDir = next;
      i += 1;
    } else {
      throw new Error(`未知参数：${arg}`);
    }
  }
  return result;
}

if (!isMainModule) {
  // Imported by tests or other local tooling.
} else if (cliMode) {
  const payload = parseCliBuildArgs(process.argv.slice(3));
  const action = cliCommand === "executors"
    ? () => detectExecutors({ cwd: rootDir })
    : cliCommand === "execute"
      ? () => launchRunExecution(payload)
      : cliCommand === "validate"
    ? () => validateRun(payload.runDir)
    : cliCommand === "export"
      ? () => exportRun(payload.runDir, payload.outputRootDir)
      : cliCommand === "material"
        ? createCenterMaterial
        : cliCommand === "domain"
          ? createDomainFromMaterial
          : buildKnowledgeBase;
  action(payload)
    .then(async (result) => {
      if (cliCommand === "executors") {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      if (cliCommand === "execute") {
        console.log(`AI 执行任务已启动：${result.executionId}`);
        await result.completion;
        console.log("AI 执行已完成，请运行 kb validate 校验产物。 ");
        return;
      }
      if (cliCommand === "validate") {
        console.log(JSON.stringify(result.validation, null, 2));
        if (!result.validation.valid) process.exitCode = 1;
        return;
      }
      if (cliCommand === "export") {
        console.log(`知识资产已导出：${result.exportDir}`);
        return;
      }
      if (cliCommand === "material") {
        console.log("\n中心原料已生成：");
        console.log(`原料目录：${result.materialDir}`);
        console.log(`多仓库清单：${result.repoManifestPath}`);
        console.log(`转换资料：${result.convertedDocsDir}`);
        return;
      }
      console.log("\n业务域任务已生成：");
      console.log(`使用原料：${result.materialDir}`);
      console.log(`运行目录：${result.runDir}`);
      if (result.domainScope) console.log(`业务域边界：${result.domainScope}`);
      console.log(`草稿目录：${result.draftsDir}`);
      console.log(`AI 提示词：${result.promptPath}`);
      console.log(`建议导出目录：${result.exportDir}`);
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
    const recoveredRuns = await recoverInterruptedRuns();
    console.log(`Knowledge Builder 已启动：${url}`);
    if (recoveredRuns) console.log(`已将 ${recoveredRuns} 个中断的 AI 任务标记为 interrupted。`);
    if (!process.argv.includes("--no-open")) await open(url);
  });
}

export {
  assertRunDir,
  buildKnowledgeBase,
  buildPrompt,
  createCenterMaterial,
  createDomainFromMaterial,
  exportKnowledgeAssets,
  exportRun,
  listMaterials,
  normalizeRepoPaths,
  parseCliBuildArgs,
  readMaterial,
  readRun,
  slugify,
  updateRun,
  validateKnowledgeAssets,
  validateRun,
  writeDraftTemplates,
};
