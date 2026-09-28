import { test } from "node:test";
import assert from "node:assert/strict";
import { parseWarm, renderWarmEntries } from "../warm.js";
import { BM25, STRATEGY, retrievalParams, tokenize } from "../bm25.js";
import { buildSystemPrompt } from "../assemble.js";
import { Config, collectLastUserQuery, guessCategory } from "../index.js";

// ── warm 解析 ─────────────────────────────────────────────────────────
const WARM = [
  "## 2026-09-27 10:00 [fact] high\n\nsprint 1 截止 2026-03-29。\n<!-- last_access: 2026-09-27 10:00 -->",
  "## 2026-09-28 09:00 [fact]\n\n用户偏好短句。\n<!-- last_access: 2026-09-28 09:00 -->",
  "## 2026-09-28 11:00 [decision] low\n\n可能迁移到 Render，未验证。\n<!-- last_access: 2026-09-28 11:00 -->",
  "## 2026-09-28 12:00 [fact] wrong\n\nsprint 1 截止 2026-11-15。\n<!-- last_access: 2026-09-28 12:00 -->",
].join("\n\n") + "\n";

test("warm: parseWarm 解析 confidence（wrong，缺省 medium）", () => {
  const entries = parseWarm(WARM);
  assert.equal(entries.length, 4);
  assert.deepEqual(entries.map((e) => e.confidence), ["high", "medium", "low", "wrong"]);
});

test("warm: renderWarmEntries 默认排除 wrong、低置信加声明", () => {
  const out = renderWarmEntries(parseWarm(WARM));
  assert.ok(out.includes("sprint 1 截止 2026-03-29"));
  assert.ok(out.includes("【低置信·需验证】"));
  assert.ok(!out.includes("2026-11-15"), "wrong 条目不渲染");
});

// ── BM25 + 题型分流 ───────────────────────────────────────────────────
const DOCS = [
  "sprint 1 截止 2026-03-29 完成 transaction module 的数据库迁移和 API 重构，共提交 165 个 commit 用时 250ms",
  "用户偏好短句、直接，不喜欢冗长解释。",
  "可能迁移到 Render 部署，尚未验证。",
  "OpenWeather API key 已配置，天气应用支持城市搜索。",
  "sprint 1 截止 2026-11-15（被翻转的旧值）。",
];

test("bm25: top 命中最相关条目", () => {
  const bm25 = new BM25(DOCS);
  const idxs = bm25.top("sprint 1 截止日期", 3, 0);
  const top = idxs.slice(0, 3);
  assert.ok(top.includes(0), "含 sprint 截止条目");
  assert.ok(top.includes(4), "含被翻转的旧值条目（检索层不判断正确性）");
});

test("bm25: 时间保底强制并入最近条目（防长文档惩罚漏最新事实）", () => {
  const bm25 = new BM25(DOCS);
  const idxs = bm25.top("165 commits transaction module", 3, 0);
  assert.ok(idxs.includes(0), "长文档最新事实应被 BM25 命中");
  const withRecent = bm25.top("没有任何命中词的无意义查询 zzzqqq", 3, 2);
  assert.deepEqual([...withRecent].sort((a, b) => a - b), [3, 4], "零命中时时间保底兜底最近两条");
});

test("bm25: retrievalParams 题型分流", () => {
  assert.deepEqual(retrievalParams("knowledge_update"), { k: 12, recentSafe: 6 });
  assert.deepEqual(retrievalParams("summarization"), { k: 24, recentSafe: 0 });
  assert.deepEqual(retrievalParams("temporal_reasoning"), { k: 12, recentSafe: 0 });
  assert.deepEqual(STRATEGY.knowledge_update, { k: 12, recentSafe: 6 });
});

test("bm25: tokenize 去掉停用词与单字符", () => {
  const t = tokenize("How many days until OpenWeather API key");
  assert.ok(t.includes("openweather"));
  assert.ok(!t.includes("the"), "停用词 the 应被过滤");
  assert.ok(!t.includes("for"), "停用词 for 应被过滤");
  assert.ok(t.every((x) => x.length > 1));
});

// ── 组装 prompt（摘要双轨）────────────────────────────────────────────
test("assemble: 摘要双轨 prompt 覆盖建议线", () => {
  const p = buildSystemPrompt("summarization");
  assert.ok(p.includes("事实线"));
  assert.ok(p.includes("建议线"));
  assert.ok(p.includes("模块化"));
});

test("assemble: 普通题型不含摘要双轨第 6 条", () => {
  const p = buildSystemPrompt("knowledge_update");
  assert.ok(!p.includes("建议线"));
  assert.ok(p.includes("原样保留"));
});

// ── 插件入口 ──────────────────────────────────────────────────────────
test("index: 默认配置可解析", () => {
  const parsed = Config(undefined);
  assert.equal(parsed.enabled, true);
  assert.equal(parsed.warm.path, "");
  assert.equal(parsed.output.injectPath, "");
  assert.ok(parsed.output.label.includes("提取子智能体"));
  assert.equal(parsed.debounceMs, 5000);
});

test("index: guessCategory 启发式分流", () => {
  assert.equal(guessCategory("请总结一下我学到了什么"), "summarization");
  assert.equal(guessCategory("现在最新状态是什么"), "knowledge_update");
  assert.equal(guessCategory("帮我看看这个功能怎么设计"), "general");
});

test("index: collectLastUserQuery 跳过运行时上下文注入", () => {
  const session = {
    log: [
      { type: "user/message", data: { source: { kind: "runtime-context" }, content: [{ type: "text", text: "系统注入" }] } },
      { type: "user/message", data: { content: [{ type: "text", text: "真实用户问题：怎么修？" }] } },
      { type: "assistant/message", data: { message: { content: [{ type: "text", text: "助手回答" }] } } },
    ],
  };
  assert.equal(collectLastUserQuery(session), "真实用户问题：怎么修？");
});
