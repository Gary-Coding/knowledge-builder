import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildPrompt,
  createDomainFromMaterial,
  exportKnowledgeAssets,
  exportRun,
  normalizeRepoPaths,
  parseCliBuildArgs,
  validateKnowledgeAssets,
  writeDraftTemplates,
} from "../server/index.js";

test("normalizeRepoPaths 支持数组、换行文本和旧 repoDir 参数", () => {
  assert.deepEqual(normalizeRepoPaths({ repoDirs: [" /a ", "/b", "/a"] }), ["/a", "/b"]);
  assert.deepEqual(normalizeRepoPaths({ repoDirs: "/a\n\n/b", repoDir: "/legacy" }), ["/a", "/b", "/legacy"]);
});

test("CLI 参数解析拒绝未知选项", () => {
  assert.throws(() => parseCliBuildArgs(["--removed-option", "/tmp/value"]), /未知参数/);
});

test("writeDraftTemplates 生成完整本体与质量规则", async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-builder-test-"));
  t.after(() => fs.rm(tempDir, { recursive: true, force: true }));

  await writeDraftTemplates(tempDir, "示例业务域", "sample-domain", { "service-core": "abc123" });

  const nodeTypes = await fs.readFile(path.join(tempDir, "ontology", "node-types.yaml"), "utf8");
  const relationTypes = await fs.readFile(path.join(tempDir, "ontology", "relation-types.yaml"), "utf8");
  const conceptTypes = await fs.readFile(path.join(tempDir, "ontology", "concept-types.yaml"), "utf8");
  const concepts = await fs.readFile(path.join(tempDir, "domains", "sample-domain", "concepts.yaml"), "utf8");
  const graph = await fs.readFile(path.join(tempDir, "graph", "curated", "sample-domain.graph.yaml"), "utf8");
  const validation = await fs.readFile(path.join(tempDir, "rules", "validation-rules.yaml"), "utf8");
  assert.match(nodeTypes, /Repository/);
  assert.match(nodeTypes, /BusinessDomain/);
  assert.match(nodeTypes, /required:/);
  assert.match(relationTypes, /rel: invokes/);
  assert.match(relationTypes, /from: \[ExternalSystem\]/);
  assert.match(relationTypes, /to: \[Controller\]/);
  assert.match(conceptTypes, /type: domain_entity/);
  assert.match(conceptTypes, /type: async_artifact/);
  assert.match(concepts, /type: domain_entity/);
  assert.match(concepts, /related: \[\]/);
  assert.match(graph, /"service-core":"abc123"/);
  assert.match(validation, /every_high_rule_has_code_mapping/);
});

test("buildPrompt 将多个服务和可信 commit 写入生成约束", () => {
  const prompt = buildPrompt({
    productName: "示例中心",
    domainName: "示例业务域",
    domainScope: "示例业务边界",
    convertedDocsDir: "/tmp/docs",
    repoManifestPath: "/tmp/repomix/README.md",
    draftsDir: "/tmp/drafts",
    domainSlug: "sample-domain",
    repositories: [
      { name: "service-core", commit: "abc", contextPath: "/tmp/service-core.md" },
      { name: "service-api", commit: "def", contextPath: "/tmp/service-api.md" },
    ],
  });
  assert.match(prompt, /service-core（commit: abc）/);
  assert.match(prompt, /service-api（commit: def）/);
  assert.match(prompt, /产品\/开发\/测试/);
  assert.match(prompt, /每个 capability 至少映射一个代码节点/);
  assert.match(prompt, /domain_entity/);
  assert.match(prompt, /async_artifact/);
  assert.match(prompt, /不要用 BusinessDomain、Java 类名或代码节点类型代替业务概念类型/);
  assert.match(prompt, /invokes \/ calls/);
  assert.match(prompt, /范围优先、证据扩展/);
  assert.match(prompt, /入口→核心服务→数据读写\/跨服务调用→状态或结果→异常\/回滚/);
  assert.match(prompt, /不要从头到尾逐字阅读所有仓库原料/);
  assert.match(prompt, /两阶段执行/);
  assert.match(prompt, /候选文件清单/);
  assert.match(prompt, /最多扩展到跨服务边界/);
  assert.match(prompt, /无调用证据的模块列入排除项/);
  assert.match(prompt, /1 条测试证据/);
});

test("exportKnowledgeAssets 导出规则目录并跳过提示词", async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-builder-publish-"));
  t.after(() => fs.rm(tempRoot, { recursive: true, force: true }));
  const draftsDir = path.join(tempRoot, "drafts");
  const exportDir = path.join(tempRoot, "exported");
  await writeDraftTemplates(draftsDir, "示例业务域", "sample-domain");
  await fs.writeFile(path.join(draftsDir, "AI_PROMPT.md"), "not knowledge");

  const result = await exportKnowledgeAssets(draftsDir, exportDir);
  assert.deepEqual(result.copied, ["ontology", "domains", "graph", "mappings", "rules"]);
  assert.deepEqual(result.skipped, ["AI_PROMPT.md"]);
  await assert.rejects(fs.access(path.join(exportDir, "AI_PROMPT.md")));
});

test("同一中心原料可以生成多个业务域且不复制代码上下文", async (t) => {
  const materialDir = path.join(
    process.cwd(),
    "workspace",
    "materials",
    "test-center",
    `test-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  const repomixDir = path.join(materialDir, "repomix");
  const convertedDocsDir = path.join(materialDir, "converted-docs");
  const contextPath = path.join(repomixDir, "service-core.md");
  const repoManifestPath = path.join(repomixDir, "README.md");
  const customOutputDir = await fs.mkdtemp("/tmp/knowledge-builder-output-");
  t.after(() => fs.rm(materialDir, { recursive: true, force: true }));
  t.after(() => fs.rm(customOutputDir, { recursive: true, force: true }));

  await fs.mkdir(repomixDir, { recursive: true });
  await fs.mkdir(convertedDocsDir, { recursive: true });
  await fs.writeFile(contextPath, "shared source context");
  await fs.writeFile(repoManifestPath, "# repositories\n");
  await fs.writeFile(path.join(materialDir, "material.json"), JSON.stringify({
    version: 1,
    materialId: "test-material",
    productName: "测试中心",
    productSlug: "test-center",
    createdAt: "2026-08-12T00:00:00.000Z",
    convertedDocsDir,
    repoManifestPath,
    repositories: [{ name: "service-core", path: "/tmp/service-core", commit: "abc", contextPath }],
  }));

  const first = await createDomainFromMaterial({
    materialDir,
    domainName: "业务域一",
    domainSlug: "domain-one",
  });
  const second = await createDomainFromMaterial({
    materialDir,
    domainName: "业务域二",
    domainSlug: "domain-two",
    outputRootDir: customOutputDir,
  });

  assert.equal(first.materialDir, second.materialDir);
  assert.equal(first.repoManifestPath, second.repoManifestPath);
  assert.notEqual(first.runDir, second.runDir);
  t.after(() => fs.rm(first.runDir, { recursive: true, force: true }));
  t.after(() => fs.rm(second.runDir, { recursive: true, force: true }));
  assert.equal(await fs.readFile(contextPath, "utf8"), "shared source context");
  assert.match(await fs.readFile(first.promptPath, "utf8"), /业务域一/);
  assert.match(await fs.readFile(second.promptPath, "utf8"), /业务域二/);
  await assert.rejects(fs.access(path.join(first.runDir, "repomix")));
  await assert.rejects(fs.access(path.join(second.runDir, "repomix")));
  assert.match(first.outputRootDir, /workspace\/knowledge$/);
  assert.equal(second.outputRootDir, customOutputDir);

  const manifest = JSON.parse(await fs.readFile(first.runManifestPath, "utf8"));
  assert.equal(manifest.status, "draft_ready");
  assert.equal(manifest.outputRootDir, first.outputRootDir);
  assert.equal(manifest.lifecycle[0].type, "draft_ready");
  const runReadme = await fs.readFile(path.join(first.runDir, "README.md"), "utf8");
  assert.match(runReadme, /导出到任意知识库/);
});

test("业务域任务可以校验并导出到通用目标目录", async (t) => {
  const materialDir = path.join(
    process.cwd(),
    "workspace",
    "materials",
    "export-center",
    `test-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  const repomixDir = path.join(materialDir, "repomix");
  const convertedDocsDir = path.join(materialDir, "converted-docs");
  const contextPath = path.join(repomixDir, "service-core.md");
  const repoManifestPath = path.join(repomixDir, "README.md");
  const outputRootDir = await fs.mkdtemp("/tmp/knowledge-builder-export-");
  t.after(() => fs.rm(materialDir, { recursive: true, force: true }));
  t.after(() => fs.rm(outputRootDir, { recursive: true, force: true }));

  await fs.mkdir(convertedDocsDir, { recursive: true });
  await fs.mkdir(repomixDir, { recursive: true });
  await fs.writeFile(contextPath, "shared source context");
  await fs.writeFile(repoManifestPath, "# repositories\n");
  await fs.writeFile(path.join(materialDir, "material.json"), JSON.stringify({
    version: 1,
    materialId: "export-material",
    productName: "导出中心",
    productSlug: "export-center",
    createdAt: "2026-08-12T00:00:00.000Z",
    convertedDocsDir,
    repoManifestPath,
    repositories: [{ name: "service-core", path: "/tmp/service-core", commit: "abc", contextPath }],
  }));

  const run = await createDomainFromMaterial({
    materialDir,
    domainName: "导出业务域",
    domainSlug: "export-domain",
  });
  t.after(() => fs.rm(run.runDir, { recursive: true, force: true }));

  const validation = await validateKnowledgeAssets(run.draftsDir);
  assert.equal(validation.valid, false);
  assert.equal(validation.domainSlugs[0], "export-domain");
  assert.ok(validation.errors.some((message) => message.includes("待补充")));

  const domainDir = path.join(run.draftsDir, "domains", "export-domain");
  await fs.writeFile(path.join(domainDir, "overview.md"), "# 导出业务域\n\n已核验的业务边界。\n");
  await fs.writeFile(path.join(domainDir, "flows.md"), "# 核心流程\n\n已核验的主流程。\n");
  await fs.writeFile(path.join(domainDir, "pitfalls.md"), "# 风险\n\n暂无已知风险。\n");
  await fs.writeFile(path.join(domainDir, "glossary.yaml"), "terms:\n  - term: 导出业务域\n    meaning: 已核验业务域\n    status: VERIFIED\n");
  await fs.writeFile(path.join(domainDir, "concepts.yaml"), "concepts:\n  - id: CONCEPT:export-domain\n    name: 导出业务域\n    type: domain_entity\n    desc: 已核验业务对象\n    related: []\n    status: VERIFIED\n");
  await fs.writeFile(path.join(domainDir, "capabilities.yaml"), "capabilities:\n  - id: CAP:export-domain:main\n    name: 核心能力\n    desc: 已核验能力\n    concepts: [CONCEPT:export-domain]\n    rules: []\n    status: VERIFIED\n");
  await fs.writeFile(path.join(domainDir, "rules.yaml"), "rules:\n  - id: RULE:export-domain:main\n    name: 核心规则\n    subject: 导出业务域\n    severity: medium\n    desc: 已核验规则\n    status: VERIFIED\n    checked_scope: service-core\n");
  await fs.writeFile(path.join(run.draftsDir, "graph", "curated", "export-domain.graph.yaml"), "meta:\n  domain: export-domain\n  verified_commits:\n    service-core: abc\nnodes:\n  - id: DOMAIN:export-domain\n    type: BusinessDomain\n    name: 导出业务域\n    desc: 已核验业务域\nedges: []\n");
  await fs.writeFile(path.join(run.draftsDir, "mappings", "export-domain.mapping.yaml"), "domain: export-domain\ncapability_mappings:\n  - capability_id: CAP:export-domain:main\n    graph_nodes: [DOMAIN:export-domain]\nrule_mappings: []\nentry_points: []\n");

  const completedValidation = await validateKnowledgeAssets(run.draftsDir);
  assert.equal(completedValidation.valid, true);

  const exported = await exportRun(run.runDir, outputRootDir);
  assert.equal(exported.exportDir, path.join(outputRootDir, "code-knowledge", "export-center", "export-domain"));
  assert.equal(exported.run.status, "exported");
  assert.equal(exported.run.lifecycle.at(-1).type, "exported");
  assert.equal(await fs.readFile(path.join(exported.exportDir, "domains", "export-domain", "overview.md"), "utf8"), await fs.readFile(path.join(run.draftsDir, "domains", "export-domain", "overview.md"), "utf8"));
  await assert.rejects(fs.access(path.join(exported.exportDir, "AI_PROMPT.md")));
});

test("知识资产校验拒绝非法 YAML 和未定义的本体类型", async (t) => {
  const draftsDir = await fs.mkdtemp("/tmp/knowledge-builder-validation-");
  t.after(() => fs.rm(draftsDir, { recursive: true, force: true }));
  await writeDraftTemplates(draftsDir, "校验业务域", "validation-domain");

  await fs.writeFile(
    path.join(draftsDir, "domains", "validation-domain", "concepts.yaml"),
    "concepts:\n  - id: broken\n    name: 非法概念\n    type: unknown_type\n    desc: 已填写\n    related: []\n",
  );
  await fs.writeFile(path.join(draftsDir, "mappings", "validation-domain.mapping.yaml"), "domain: [invalid\n");

  const validation = await validateKnowledgeAssets(draftsDir);
  assert.equal(validation.valid, false);
  assert.ok(validation.errors.some((message) => message.includes("YAML 语法错误")));
  assert.ok(validation.errors.some((message) => message.includes("未定义的业务概念类型")));
});
