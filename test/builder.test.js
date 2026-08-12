import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildPrompt,
  createDomainFromMaterial,
  normalizeRepoPaths,
  publishKnowledgeAssets,
  writeDraftTemplates,
} from "../server/index.js";

test("normalizeRepoPaths 支持数组、换行文本和旧 repoDir 参数", () => {
  assert.deepEqual(normalizeRepoPaths({ repoDirs: [" /a ", "/b", "/a"] }), ["/a", "/b"]);
  assert.deepEqual(normalizeRepoPaths({ repoDirs: "/a\n\n/b", repoDir: "/legacy" }), ["/a", "/b", "/legacy"]);
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
});

test("publishKnowledgeAssets 发布规则目录并跳过提示词", async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-builder-publish-"));
  t.after(() => fs.rm(tempRoot, { recursive: true, force: true }));
  const draftsDir = path.join(tempRoot, "drafts");
  const publishDir = path.join(tempRoot, "published");
  await writeDraftTemplates(draftsDir, "示例业务域", "sample-domain");
  await fs.writeFile(path.join(draftsDir, "AI_PROMPT.md"), "not knowledge");

  const result = await publishKnowledgeAssets(draftsDir, publishDir);
  assert.deepEqual(result.copied, ["ontology", "domains", "graph", "mappings", "rules"]);
  assert.deepEqual(result.skipped, ["AI_PROMPT.md"]);
  await assert.rejects(fs.access(path.join(publishDir, "AI_PROMPT.md")));
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
  const knowledgeRagDocsDir = await fs.mkdtemp("/tmp/knowledge-builder-rag-");
  t.after(() => fs.rm(materialDir, { recursive: true, force: true }));
  t.after(() => fs.rm(knowledgeRagDocsDir, { recursive: true, force: true }));

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
    knowledgeRagDocsDir,
  });
  const second = await createDomainFromMaterial({
    materialDir,
    domainName: "业务域二",
    domainSlug: "domain-two",
    knowledgeRagDocsDir,
  });

  assert.equal(first.materialDir, second.materialDir);
  assert.equal(first.repoManifestPath, second.repoManifestPath);
  assert.notEqual(first.runDir, second.runDir);
  assert.equal(await fs.readFile(contextPath, "utf8"), "shared source context");
  assert.match(await fs.readFile(first.promptPath, "utf8"), /业务域一/);
  assert.match(await fs.readFile(second.promptPath, "utf8"), /业务域二/);
  await assert.rejects(fs.access(path.join(first.runDir, "repomix")));
  await assert.rejects(fs.access(path.join(second.runDir, "repomix")));
});
