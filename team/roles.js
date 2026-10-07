/**
 * dsh-linghun-assembler 认知循环角色（team/roles.js）
 *
 * 做自己的子智能体形态：每个角色 = 独立 LLM 调用 + 角色 prompt + 结构化输出，
 * 复用 DSH 会话 llmClient（不持有 API key，provider/model 从会话请求头取）。
 *
 * 角色：
 * - 判官 Judge：判定本轮记忆需求等级（light/medium/deep）与策略意图（summarization/
 *   knowledge_update/conflict/timeline/general）。默认走代码启发式（零 LLM 成本），
 *   team.judge.llm=true 时升级为 LLM 判官（输出结构化 JSON）。
 * - 史官 Archivist：deep 模式把时序素材（warm 遗忘梯度 + episodic 归档 + journal 流水）
 *   组织成「来龙去脉」叙事块，保日期保版本。
 * - 辩手 Advocate：deep 模式可选，扫描候选条目中的互相矛盾/与问题冲突，输出冲突标注块。
 * - 编辑 Editor：每轮收口，把素材（检索命中 + 时序 + 矛盾）组装成「有用素材包」，
 *   比旧版多携带循环上下文（上次判定、反馈统计）——组装决策更贴近记忆使用情况。
 */
import { buildSystemPrompt } from "../assemble.js";

const PLUGIN = "linghun-assembler";
const PURPOSE = "compaction";

// ---- 判官：代码启发式（默认，零 LLM）----

const DEEP_MARKERS = [
  "来龙去脉", "来龙", "沿革", "上次怎么", "上次是", "之前怎么", "之前是", "之前说过",
  "矛盾", "不一致", "冲突", "回顾全部", "从头", "历史", "演变", "对比一下", "对比",
];
const CONFLICT_MARKERS = ["矛盾", "不一致", "冲突", "对不上", "说法不一"];
const TIMELINE_MARKERS = ["来龙去脉", "来龙", "沿革", "演变", "历史", "从头", "回顾全部", "之前怎么", "上次怎么"];

/**
 * 判官（启发式）：按问题模式判需求等级与策略意图。
 * @param {string} question 用户问题
 * @param {object} [cycle] 循环状态（供后续接入反馈统计，当前未用）
 * @returns {{level:"light"|"medium"|"deep", strategy:string, query:string, reason:string}}
 */
export function judgeByHeuristics(question, cycle = null) {
  const q = String(question ?? "");
  if (!q.trim()) return { level: "light", strategy: "general", query: q, reason: "空问题，不捞取" };

  // deep：命中时间线/矛盾/历史回溯标记
  if (DEEP_MARKERS.some((m) => q.includes(m))) {
    if (CONFLICT_MARKERS.some((m) => q.includes(m))) {
      return { level: "deep", strategy: "conflict", query: q, reason: "命中矛盾类标记，深捞并扫描冲突" };
    }
    if (TIMELINE_MARKERS.some((m) => q.includes(m))) {
      return { level: "deep", strategy: "timeline", query: q, reason: "命中时序类标记，深捞并组织来龙去脉" };
    }
    return { level: "deep", strategy: "general", query: q, reason: "命中深度回溯标记，深捞" };
  }

  // medium：综合总结 / 状态更新
  if (/总结|学到了什么|综合|回顾|学到了哪些|comprehensive summary|learned/i.test(q)) {
    return { level: "medium", strategy: "summarization", query: q, reason: "综合总结类问题，广覆盖检索" };
  }
  if (/最新|现在|目前|还剩|几天|多久|是否已经|已经.*了|当前|update/i.test(q)) {
    return { level: "medium", strategy: "knowledge_update", query: q, reason: "状态更新类问题，时间保底检索" };
  }

  // 事件顺序 / 偏好遵循 / 矛盾核实 / 时间计算：各走对应组装纪律
  if (/顺序|先后|sequence|顺序|先.*后|哪个先|什么顺序/i.test(q)) {
    return { level: "medium", strategy: "event_ordering", query: q, reason: "事件顺序类问题，按时间排序纪律" };
  }
  if (/偏好|倾向|喜欢|preference|更愿意|规则|纪律|风格|版本.*绑定/i.test(q)) {
    return { level: "medium", strategy: "preference_following", query: q, reason: "偏好遵循类问题，保留偏好原话" };
  }
  if (/矛盾|冲突|对不上|不一致|核实|contradiction/i.test(q)) {
    return { level: "deep", strategy: "contradiction_resolution", query: q, reason: "矛盾核实类问题，冲突并列纪律" };
  }
  if (/多少天|间隔|时长|相差|时间差|temporal|多久前/i.test(q)) {
    return { level: "medium", strategy: "temporal_reasoning", query: q, reason: "时间计算类问题，保留日期由主智能体计算" };
  }

  return { level: "light", strategy: "general", query: q, reason: "常规问题，轻量捞取" };
}

/** 判官系统提示（LLM 版）。 */
export function judgeSystemPrompt() {
  return (
    "你是记忆需求的判官：判断本轮对话对记忆库的捞取需求。\n" +
    "输入：用户问题 + 最近循环状态。\n" +
    "输出：严格 JSON，字段：\n" +
    '- "level": "light"|"medium"|"deep"——light=常规问题轻量捞取；medium=需要按策略检索；deep=需要时序回溯/矛盾扫描/历史对照；\n' +
    '- "strategy": "summarization"|"knowledge_update"|"conflict"|"timeline"|"general"|"event_ordering"|"preference_following"|"contradiction_resolution"|"temporal_reasoning"；\n' +
    '- "query": 可选的拆解检索查询（一般等于原问题，含多个子问题时可给出更利于检索的查询文本）；\n' +
    '- "reason": 一句话理由。\n' +
    "不要输出 JSON 以外的任何文本。"
  );
}

// ---- LLM 角色调用公共件 ----

/** 一次角色 LLM 调用（与 assembleWithLlm 同通道模式）。 */
export async function callRoleLlm(llmClient, modelInfo, { system, user, temperature = 0.2, maxTokens = 900 }) {
  if (!llmClient) throw new Error("llmClient 不可用（未注入 llm 依赖）");
  let text = "";
  for await (const chunk of llmClient.stream({
    provider: modelInfo.provider,
    model: modelInfo.model,
    system,
    messages: [
      {
        id: `linghun-assembler-role-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        role: "user",
        content: [{ type: "text", text: user }],
        source: { kind: "plugin", plugin: PLUGIN },
      },
    ],
    temperature,
    maxTokens,
    purpose: PURPOSE,
  })) {
    if (chunk.type === "text-delta") text += chunk.text;
  }
  const out = text.trim();
  if (!out) throw new Error("角色 LLM 返回空文本");
  return out;
}

/** 从 LLM 输出中提取 JSON（防御：剥离代码块/前后杂文）。 */
export function extractJson(text) {
  const t = String(text ?? "");
  const m = t.match(/```(?:json)?\s*([\s\S]*?)```/) ?? t.match(/\{[\s\S]*\}/);
  const raw = m ? m[1] ?? m[0] : t;
  try {
    return JSON.parse(raw.trim());
  } catch {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(raw.slice(start, end + 1));
      } catch {
        /* fallthrough */
      }
    }
    throw new Error("判官输出非 JSON: " + t.slice(0, 120));
  }
}

// ---- 判官：LLM 版（可选）----

export async function judgeWithLlm(llmClient, modelInfo, question, cycle, opts = {}) {
  const user =
    `用户问题：${question}\n\n` +
    `最近循环状态：\n${JSON.stringify({
      turnCount: cycle?.turnCount ?? 0,
      lastJudge: cycle?.lastJudge ?? null,
      feedback: cycle?.feedback ?? null,
    }, null, 2)}`;
  const out = await callRoleLlm(llmClient, modelInfo, {
    system: judgeSystemPrompt(),
    user,
    temperature: 0,
    maxTokens: opts.maxTokens ?? 400,
  });
  const j = extractJson(out);
  const level = ["light", "medium", "deep"].includes(j.level) ? j.level : "medium";
  const strategy = ["summarization", "knowledge_update", "conflict", "timeline", "general", "event_ordering", "preference_following", "contradiction_resolution", "temporal_reasoning"].includes(j.strategy)
    ? j.strategy
    : "general";
  return {
    level,
    strategy,
    query: String(j.query ?? question ?? ""),
    reason: String(j.reason ?? "").slice(0, 200),
    by: "llm",
  };
}

// ---- 史官：时序组织（deep 模式）----

/** 史官系统提示：以主智能体认知架构为基础，输入侧 HHH 解耦，突出史官功能。 */
export function archivistSystemPrompt() {
  return (
    "你是主智能体（认知主体）的记忆提取侧子智能体，运行在主智能体的认知架构内。\n" +
    "- 主智能体是收口者：大模型供直觉，主智能体做评估、筛选、收口；你负责输入侧的时序素材组织，不替主智能体做最终判断与回答。\n" +
    "- 边界纪律（继承主智能体）：实事求是，先查证再下结论；不确定就标注不确定，不编造；具体日期、版本号、数字、库名原样保留，不得概括省略（输入侧素材给足，与主智能体输出侧 HHH 解耦）。\n" +
    "\n" +
    "你的功能（史官角色）：把时序素材组织成「来龙去脉」叙事块，供主智能体快速把握脉络。\n" +
    "要求：\n" +
    "1. 按时间顺序组织（先发生的在前）；素材含日期/时刻时按时间排序；\n" +
    "2. 具体日期、版本号、数字、库名必须原样保留，不得概括或省略；\n" +
    "3. 按阶段/主题分组（如「立项 → 实现 → 修复 → 发布」），每阶段一句话总结 + 关键细节；\n" +
    "4. 若不同时间点存在口径变化（改了结论/换了方案），用「⚠️ 口径变化：」标注；\n" +
    "5. 输出以「脉络：」开头，紧凑，不超过 600 字。\n" +
    "只输出叙事块本身，不要解释。"
  );
}

export async function archivistWithLlm(llmClient, modelInfo, question, timelineText, opts = {}) {
  const user = `用户问题：${question}\n\n时序素材：\n\n${String(timelineText ?? "").slice(0, 12000)}`;
  return callRoleLlm(llmClient, modelInfo, {
    system: archivistSystemPrompt(),
    user,
    temperature: opts.temperature ?? 0.2,
    maxTokens: opts.maxTokens ?? 900,
  });
}

// ---- 辩手：矛盾扫描（deep 模式可选）----

export function advocateSystemPrompt() {
  return (
    "你是记忆辩手：在候选记忆条目中扫描互相矛盾、或与用户当前说法冲突的内容。\n" +
    "要求：\n" +
    "1. 逐条核对候选条目之间、以及与用户问题的口径（日期/版本/数字/结论）；\n" +
    "2. 发现矛盾时，输出「⚠️ 冲突：」开头的一块，列出两个（或多个）口径原文要点，不自己判断谁对；\n" +
    "3. 无矛盾时只输出「无冲突」三个字；\n" +
    "4. 不要改写原文细节。"
  );
}

export async function advocateWithLlm(llmClient, modelInfo, question, hitText, opts = {}) {
  const user = `用户问题：${question}\n\n候选记忆条目：\n\n${String(hitText ?? "").slice(0, 12000)}`;
  return callRoleLlm(llmClient, modelInfo, {
    system: advocateSystemPrompt(),
    user,
    temperature: 0,
    maxTokens: opts.maxTokens ?? 500,
  });
}

// ---- 编辑：素材包收口（每轮）----

/** 编辑系统提示：旧版组装要求 + 循环上下文段。 */
export function editorSystemPrompt(category, cycleContext) {
  let p = buildSystemPrompt(category);
  if (cycleContext) {
    p +=
      "\n\n循环上下文（供你判断素材侧重，不写入素材本身）：\n" +
      `- 上次判定：${JSON.stringify(cycleContext.lastJudge ?? null)}\n` +
      `- 反馈统计：${JSON.stringify(cycleContext.feedback ?? null)}`;
  }
  return p;
}

export async function editorWithLlm(llmClient, modelInfo, category, question, hitText, cycleContext, opts = {}) {
  const user = `用户问题：${question}\n\n候选记忆条目：\n\n${hitText}`;
  return callRoleLlm(llmClient, modelInfo, {
    system: editorSystemPrompt(category, cycleContext),
    user,
    temperature: opts.temperature ?? 0.2,
    maxTokens: opts.maxTokens ?? 1200,
  });
}
