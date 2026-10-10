import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  parseNodes,
  renderNodes,
  hitByAlias,
  loadOntology,
  loadKnowledge,
  loadKnowledgeDirs,
} from "../ontology.js";
import { Config } from "../index.js";

// ── 本体节点解析 ─────────────────────────────────────────────────────
const ONT = [
  "## BEAM 评测",
  "BEAM 1M 85.0/92.5、10M 90.0/92.5，加权双收敛 92.5（2026-10-07）。",
  "残点仅 summarization。",
  "",
  "## 记忆本体投影",
  "warm 按主题桶 LLM 聚合 → ontology.md；TAG_ALIAS 主题命中优先，BM25 兜底。",
].join("\n");

test("ontology: parseNodes 解析主题与正文", () => {
  const nodes = parseNodes(ONT);
  assert.equal(nodes.length, 2);
  assert.equal(nodes[0].theme, "BEAM 评测");
  assert.ok(nodes[0].body.includes("85.0/92.5"));
  assert.ok(nodes[1].body.includes("TAG_ALIAS"));
});

test("ontology: renderNodes 还原节点文本", () => {
  const nodes = parseNodes(ONT);
  const out = renderNodes(nodes);
  assert.ok(out.includes("## BEAM 评测"));
  assert.ok(out.includes("85.0/92.5"));
  assert.ok(out.includes("## 记忆本体投影"));
});

test("ontology: hitByAlias 别名命中优先（大小写不敏感）", () => {
  const nodes = parseNodes(ONT);
  const hit = hitByAlias("beam 第二轮 双收敛多少", nodes, { beam: "BEAM 评测" });
  assert.ok(hit.length > 0);
  assert.equal(hit[0].theme, "BEAM 评测");
});

test("ontology: hitByAlias 未命中返回空数组", () => {
  const nodes = parseNodes(ONT);
  const hit = hitByAlias("完全没有关系的问题", nodes, { beam: "BEAM 评测" });
  assert.equal(hit.length, 0);
});

test("ontology: loadOntology 读文件并解析", () => {
  const dir = mkdtempSync(join(tmpdir(), "ont-"));
  try {
    const p = join(dir, "ontology.md");
    writeFileSync(p, ONT, "utf8");
    const nodes = loadOntology(p);
    assert.equal(nodes.length, 2);
    assert.equal(nodes[0].theme, "BEAM 评测");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ontology: loadOntology 文件不存在返回空数组", () => {
  assert.deepEqual(loadOntology("/nonexistent/ontology.md"), []);
});

// ── 知识本体注入 ─────────────────────────────────────────────────────
const KNOW = [
  "## BM25",
  "BM25 是稀疏检索的经典算法，对短查询效果好；用于记忆检索兜底。",
  "",
  "## 题型纪律",
  "summarization：因果链 + 阶段 + 学到什么；event_ordering：时间排序。",
].join("\n");

test("knowledge: loadKnowledge 解析知识节点", () => {
  const dir = mkdtempSync(join(tmpdir(), "know-"));
  try {
    const p = join(dir, "knowledge.md");
    writeFileSync(p, KNOW, "utf8");
    const nodes = loadKnowledge(p);
    assert.equal(nodes.length, 2);
    assert.equal(nodes[0].theme, "BM25");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("knowledge: hitByAlias 注入技术实体知识", () => {
  const nodes = parseNodes(KNOW);
  const hit = hitByAlias("帮我解释 BM25 和题型纪律", nodes, { bm25: "BM25" });
  assert.ok(hit.length >= 1);
});

test("knowledge: loadKnowledgeDirs 领域目录兜底", () => {
  const dir = mkdtempSync(join(tmpdir(), "kd-"));
  try {
    mkdirSync(join(dir, "数学领域"));
    mkdirSync(join(dir, "沟通领域"));
    writeFileSync(join(dir, "数学领域", "本体_规则.md"), KNOW, "utf8");
    writeFileSync(join(dir, "沟通领域", "本体_规则.md"), ONT, "utf8");
    writeFileSync(join(dir, "SKIP.md"), "should be skipped: too small? no — included", "utf8");
    const docs = loadKnowledgeDirs([dir]);
    assert.ok(docs.length >= 2, `至少 2 个领域文档，实际 ${docs.length}`);
    assert.ok(docs.some((d) => d.file.includes("数学领域")), "扫描到数学领域文档");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── 配置兼容 ─────────────────────────────────────────────────────────
test("config: retrieval 段包含 ontology/knowledge，顶层含 rubric", () => {
  const cfg = Config({
    retrieval: {
      maxQueries: 3,
      ontology: { path: "x", aliases: { a: "A" } },
      knowledge: { path: "k", aliases: { b: "B" }, dirs: ["d1"] },
    },
    rubric: ["summarization"],
  });
  assert.ok(cfg.retrieval.ontology.path === "x");
  assert.ok(cfg.retrieval.knowledge.dirs.includes("d1"));
  assert.deepEqual(cfg.rubric, ["summarization"]);
});

test("config: 缺省时 ontology/knowledge/rubric 均有默认值", () => {
  const cfg = Config({});
  assert.ok(cfg.retrieval.ontology !== undefined);
  assert.ok(cfg.retrieval.knowledge !== undefined);
  assert.deepEqual(cfg.rubric, []);
});
