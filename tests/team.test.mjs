/**
 * 认知循环团队专项测试：判官启发式 / 角色 LLM 工具件 / 循环状态机 / 时序素材 / 反馈采集。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { judgeByHeuristics, extractJson, editorSystemPrompt } from "../team/roles.js";
import { emptyCycle, teamDir, ensureDomainDirs, domainDir, findTimelineCache, writeTimelineCache, timelineTopics, readCycle, writeCycle, recordTurn, recordFeedback, recordGap, loadTimelineMaterial, matchFeedback } from "../team/cycle.js";

// ---- 判官启发式 ----

test("判官：deep 时序类（来龙去脉/历史/之前怎么）", () => {
  const r = judgeByHeuristics("这个项目的来龙去脉是什么？");
  assert.equal(r.level, "deep");
  assert.equal(r.strategy, "timeline");
  const r2 = judgeByHeuristics("回顾一下之前怎么定的方案");
  assert.equal(r2.level, "deep");
});

test("判官：deep 矛盾类（矛盾/不一致/冲突）", () => {
  const r = judgeByHeuristics("上次说的时间和这次对不上，有矛盾吗？");
  assert.equal(r.level, "deep");
  assert.equal(r.strategy, "conflict");
});

test("判官：medium 综合总结类", () => {
  const r = judgeByHeuristics("总结一下这个项目学到了什么");
  assert.equal(r.level, "medium");
  assert.equal(r.strategy, "summarization");
});

test("判官：medium 状态更新类", () => {
  const r = judgeByHeuristics("现在还剩几天？是否已经发布？");
  assert.equal(r.level, "medium");
  assert.equal(r.strategy, "knowledge_update");
});

test("判官：light 常规问题", () => {
  const r = judgeByHeuristics("你好，帮我查一下天气");
  assert.equal(r.level, "light");
  assert.equal(r.strategy, "general");
});

test("判官：空问题不捞取", () => {
  const r = judgeByHeuristics("");
  assert.equal(r.level, "light");
});

// ---- 角色工具件 ----

test("extractJson：代码块内 JSON 提取", () => {
  const out = extractJson('```json\n{"level":"deep","strategy":"timeline"}\n```');
  assert.equal(out.level, "deep");
  assert.equal(out.strategy, "timeline");
});

test("extractJson：裸 JSON 与杂文包裹", () => {
  assert.equal(extractJson('{"level":"light"}').level, "light");
  const wrapped = extractJson('好的，判定如下：\n{"level":"medium","strategy":"general","query":"q","reason":"r"}');
  assert.equal(wrapped.level, "medium");
});

test("编辑系统提示：带循环上下文追加段", () => {
  const base = editorSystemPrompt("general", null);
  const withCtx = editorSystemPrompt("general", { lastJudge: { level: "deep" }, feedback: { hits: 1, misses: 0 } });
  assert.ok(withCtx.includes("循环上下文"));
  assert.ok(withCtx.includes("deep"));
  assert.ok(base.includes("有用素材包"));
  assert.ok(!base.includes("循环上下文"));
});

// ---- 循环状态机 ----

function makeCycleDir() {
  return mkdtempSync(join(tmpdir(), "assembler-team-"));
}

test("cycle：空状态与读写往返", () => {
  const dir = makeCycleDir();
  const c0 = emptyCycle();
  assert.equal(c0.turnCount, 0);
  writeCycle(dir, c0);
  const c1 = readCycle(dir);
  assert.equal(c1.turnCount, 0);
  assert.ok(c1.createdAt);
  assert.ok(c1.updatedAt);
});

test("cycle：recordTurn 统计 level 与 strategy", () => {
  let c = emptyCycle();
  c = recordTurn(c, { level: "deep", strategy: "timeline" });
  c = recordTurn(c, { level: "light", strategy: "general" });
  c = recordTurn(c, { level: "deep", strategy: "conflict" });
  assert.equal(c.turnCount, 3);
  assert.equal(c.judgeStats.deep, 2);
  assert.equal(c.judgeStats.light, 1);
  assert.equal(c.judgeStats.strategy.timeline, 1);
  assert.equal(c.judgeStats.strategy.conflict, 1);
  assert.equal(c.judgeStats.strategy.general, 1);
});

test("cycle：recordFeedback 计数与最近记录", () => {
  let c = emptyCycle();
  c = recordFeedback(c, { hit: true, query: "问题A" });
  c = recordFeedback(c, { hit: false, query: "问题B" });
  assert.equal(c.feedback.hits, 1);
  assert.equal(c.feedback.misses, 1);
  assert.equal(c.feedback.recent.length, 2);
  assert.equal(c.feedback.recent[1].hit, false);
});

test("cycle：recordGap 追加缺口", () => {
  let c = emptyCycle();
  c = recordGap(c, { query: "用户提到的冷门事实" });
  c = recordGap(c, { query: "另一个缺口" });
  assert.equal(c.gaps.length, 2);
  assert.equal(c.gaps[0].query, "用户提到的冷门事实");
});

test("cycle：损坏文件回落空状态", () => {
  const dir = makeCycleDir();
  writeFileSync(join(dir, "cycle.json"), "{broken", "utf8");
  const c = readCycle(dir);
  assert.equal(c.turnCount, 0);
});

// ---- 时序素材 ----

test("loadTimelineMaterial：warm 按最近访问优先 + episodic/journal 读取", () => {
  const home = makeCycleDir();
  mkdirSync(join(home, "linghun", "memory", "episodic"), { recursive: true });
  mkdirSync(join(home, "linghun", "journal"), { recursive: true });
  writeFileSync(
    join(home, "linghun", "memory", "warm.md"),
    [
      "## 2026-09-27 [fact] high\n\n旧条目（最后访问）\n<!-- last_access: 2026-09-27 -->",
      "## 2026-09-29 [fact] high\n\n新条目（最近访问）\n<!-- last_access: 2026-09-29 -->",
    ].join("\n\n") + "\n",
    "utf8",
  );
  writeFileSync(join(home, "linghun", "memory", "episodic", "2026-09-28.md"), "## 09:00\n\n归档内容\n", "utf8");
  writeFileSync(join(home, "linghun", "journal", "2026-09-29.md"), "原始流水行\n", "utf8");

  const tl = loadTimelineMaterial(home, { topRecent: 2, journalDays: 1 });
  assert.ok(tl.includes("新条目（最近访问）"));
  assert.ok(tl.indexOf("新条目（最近访问）") < tl.indexOf("旧条目（最后访问）"));
  assert.ok(tl.includes("归档内容"));
  assert.ok(tl.includes("原始流水行"));
});

test("loadTimelineMaterial：无记忆时返回空", () => {
  const home = makeCycleDir();
  assert.equal(loadTimelineMaterial(home), "");
});

// ---- 反馈采集 ----

test("matchFeedback：命中（查询词出现在素材中）", () => {
  const asm = "sprint 1 截止 2026-03-29，transaction module 已交付。";
  assert.equal(matchFeedback("transaction module 什么时候交付？", asm).hit, true);
  assert.ok(matchFeedback("transaction module 什么时候交付？", asm).overlap >= 0.25);
});

test("matchFeedback：未命中（查询词与素材无关）", () => {
  const asm = "用户偏好短句直接的回答。";
  assert.equal(matchFeedback("帮我写一首诗", asm).hit, false);
});

test("matchFeedback：空输入安全", () => {
  assert.equal(matchFeedback("", "素材").hit, false);
  assert.equal(matchFeedback("问题", "").hit, false);
});

// ---- 团队工作区路径 ----

test("teamDir：默认 $DSH_HOME/linghun/memory/team（海马体内），显式配置优先", () => {
  const explicit = teamDir("/tmp/custom-team");
  assert.equal(explicit, "/tmp/custom-team");
  const def = teamDir("");
  assert.ok(def.endsWith(join("linghun", "memory", "team")), `默认应落到海马体 memory/team，实际: ${def}`);
});

// ---- 领域目录 ----

test("domain：ensureDomainDirs 建全角色领域子目录", () => {
  const dir = makeCycleDir();
  ensureDomainDirs(dir);
  assert.ok(existsSync(join(dir, "judge")));
  assert.ok(existsSync(join(dir, "archivist", "timelines")));
  assert.ok(existsSync(join(dir, "advocate")));
  assert.ok(existsSync(join(dir, "editor")));
});

// ---- 史官时序缓存 ----

test("史官缓存：写入→读取→topic 列表", () => {
  const dir = makeCycleDir();
  const today = new Date().toISOString().slice(0, 10);
  writeTimelineCache(dir, { topic: "这个项目的来龙去脉是什么？", query: "这个项目的来龙去脉是什么？", stamp: today, finding: "从 2026-03 启动。" });
  const topics = timelineTopics(dir);
  assert.equal(topics.length, 1);
  assert.equal(topics[0].stamp, today);
});

test("史官缓存：相同主题命中（显著词重叠 + 新鲜）", () => {
  const dir = makeCycleDir();
  const today = new Date().toISOString().slice(0, 10);
  writeTimelineCache(dir, { topic: "这个项目的来龙去脉是什么？", query: "这个项目的来龙去脉是什么？", stamp: today, finding: "从 2026-03 启动。" });
  const hit = findTimelineCache(dir, "项目来龙去脉再说一遍");
  assert.ok(hit, "相似主题应命中缓存");
  assert.ok(hit.finding.includes("2026-03"));
});

test("史官缓存：过期条目不命中", () => {
  const dir = makeCycleDir();
  const old = new Date(Date.now() - 10 * 86400_000).toISOString().slice(0, 10);
  writeTimelineCache(dir, { topic: "项目的来龙去脉", query: "项目的来龙去脉", stamp: old, finding: "旧梳理。" });
  assert.equal(findTimelineCache(dir, "项目来龙去脉"), null, "10 天前梳理应过期");
});

test("史官缓存：无关主题不命中 + 停用词不误命中", () => {
  const dir = makeCycleDir();
  writeTimelineCache(dir, { topic: "项目来龙去脉", query: "项目来龙去脉", stamp: new Date().toISOString().slice(0, 10), finding: "脉络。" });
  assert.equal(findTimelineCache(dir, "帮我写一首诗"), null, "无关主题不命中");
  assert.equal(findTimelineCache(dir, "这个什么"), null, "纯停用词不命中");
});
