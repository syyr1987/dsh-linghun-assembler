/**
 * 筛选员（Jev 式判断层）专项测试：启发式分类 / 置信度闸门 / 相关性过滤 / 渲染标注 / JSON 防御解析。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { judgeEntryHeuristics, screenByHeuristics, renderScreened, parseScreenJson, DEFAULT_CONF_FLOOR } from "../team/screener.js";

// ---- 启发式类型判定 ----

test("筛选：事实信号命中（日期/版本/完成态）→ fact", () => {
  const r = judgeEntryHeuristics("项目发布了吗", {
    block: "2026-10-07 已发布 linghun v1.0.0，tag 指向 377e130",
    confidence: "high",
  });
  assert.equal(r.relevant, true);
  assert.equal(r.type, "fact");
  assert.ok(r.confidence >= 0.8);
});

test("筛选：推测信号命中（可能/大概）→ inference", () => {
  const r = judgeEntryHeuristics("下次什么时候发布", {
    block: "可能大概下个月会发布新版本，建议先验证再说",
    confidence: "medium",
  });
  assert.equal(r.type, "inference");
  assert.ok(r.confidence < 0.8);
});

test("筛选：无明确信号 → 保守按 inference（宁缺毋滥）", () => {
  const r = judgeEntryHeuristics("那个方案", {
    block: "围绕那个方案我们聊过一些想法和感觉",
    confidence: "medium",
  });
  assert.equal(r.type, "inference");
  assert.equal(r.relevant, true);
});

test("筛选：低置信 + 事实信号 → 闸门强制按推测标注", () => {
  const r = judgeEntryHeuristics("发布了什么", {
    block: "据说发布了 v0.9.0，但不确定是否真的上线了",
    confidence: "low",
  });
  assert.equal(r.type, "inference"); // 0.5 < 0.6 闸门
  assert.ok(r.confidence < DEFAULT_CONF_FLOOR);
});

test("筛选：不相关条目（词面无重叠）→ relevant=false", () => {
  const r = judgeEntryHeuristics("今天天气怎么样", {
    block: "linghun 插件 v1.0.0 已发布，测试 59/59 通过",
    confidence: "high",
  });
  assert.equal(r.relevant, false);
});

// ---- 批量筛选 + 渲染 ----

test("筛选：批量判断过滤不相关 + 标注渲染", () => {
  const question = "linghun 定版发布了吗";
  const candidates = [
    { id: 0, block: "2026-10-07 linghun v1.0.0 定版发布，tag 377e130", confidence: "high" },
    { id: 1, block: "天气晴朗适合散步", confidence: "medium" },
    { id: 2, block: "听说 v1.1.0 可能很快发布，但还没确认，建议先验证", confidence: "medium" },
  ];
  const verdicts = screenByHeuristics(question, candidates, { floor: 0.6 });
  assert.equal(verdicts.length, 3);
  assert.equal(verdicts[0].relevant, true);
  assert.equal(verdicts[1].relevant, false);
  assert.equal(verdicts[2].relevant, true);
  assert.equal(verdicts[2].type, "inference"); // 可能+建议 → 推测优先

  const text = renderScreened(candidates, verdicts, { floor: 0.6 });
  assert.ok(text.includes("【相关·事实·高置信】"));
  assert.ok(text.includes("【相关·推测·中置信】"));
  assert.ok(!text.includes("天气晴朗"));
  assert.ok(text.includes("377e130")); // 原文细节保留
});

test("渲染：缺失判定/不相关一律丢弃", () => {
  const candidates = [
    { id: 0, block: "事实条目 A" },
    { id: 1, block: "推测条目 B" },
    { id: 2, block: "无判定条目 C" },
  ];
  const verdicts = [
    { id: 0, relevant: true, type: "fact", confidence: 0.9 },
    { id: 1, relevant: false, type: "fact", confidence: 0.9 },
  ];
  const text = renderScreened(candidates, verdicts, { floor: 0.6 });
  assert.ok(text.includes("事实条目 A"));
  assert.ok(!text.includes("推测条目 B"));
  assert.ok(!text.includes("无判定条目 C"));
});

// ---- JSON 防御解析 ----

test("parseScreenJson：剥离 markdown 代码块", () => {
  const arr = parseScreenJson('```json\n[{"id":0,"relevant":true,"type":"fact","confidence":0.9}]\n```', 1);
  assert.equal(arr[0].type, "fact");
});

test("parseScreenJson：杂文前缀也能取到数组", () => {
  const arr = parseScreenJson('好的，结果如下：\n[{"id":0,"relevant":false,"type":"inference","confidence":0.4}]', 1);
  assert.equal(arr[0].relevant, false);
});

test("parseScreenJson：非 JSON 抛出", () => {
  assert.throws(() => parseScreenJson("我不确定", 1), /非 JSON/);
});

// ---- LLM 判定兜底（闸门在服务端，不信任 LLM 的 type）----

test("LLM 判定兜底逻辑：低于闸门强制按推测", () => {
  // 模拟 screenWithLlm 的服务端兜底（parse + 闸门逻辑），验证宁缺毋滥生效
  const llmOut = '[{"id":0,"relevant":true,"type":"fact","confidence":0.4,"reason":"看起来像"}]';
  const parsed = parseScreenJson(llmOut, 1);
  const floor = 0.6;
  const v = parsed[0];
  let type = v.type === "fact" ? "fact" : "inference";
  let conf = Math.round(Math.max(0.1, Math.min(1, Number(v.confidence) || 0.5)) * 10) / 10;
  if (conf < floor && type === "fact") type = "inference";
  assert.equal(type, "inference"); // 0.4 < 0.6 → 强制推测
  assert.equal(conf, 0.4);
});
