/**
 * dsh-linghun-assembler 筛选员（team/screener.js）
 *
 * Jev 式结构化判断层：把「哪些候选相关、是事实还是推测、置信度多少」从编辑 LLM
 * 的直觉层拿出来，做成独立判断层——判断独立、结构化输出、置信度做闸门。
 *
 * 两层实现：
 * - screenByHeuristics：代码启发式（默认，零 LLM 成本）。相关性=词面重叠，
 *   类型=结构信号（日期/版本号/数字/代码→fact；推测词→inference），
 *   置信度=条目自带 confidence + 信号修正，低置信强制按推测标注（宁缺毋滥）。
 * - screenWithLlm：可选 LLM 结构化判断（Jev 三题型：Noul 相关 / Choice 类型 /
 *   Score 置信度，输出 JSON），置信度闸门仍在服务端兜底，不信任 LLM 的 type 判断。
 *
 * 输出：screenCandidates → [{ id, relevant, type, confidence, reason }]，
 *       renderScreened → 带【相关·事实/推测·置信度】标注的素材文本（过滤不相关）。
 */

// ---- 类型信号 ----

/** 事实信号：明确时间锚点 / 版本号 / 数字+单位 / 代码哈希 / 完成态动词。 */
const FACT_RE = [
  /\d{4}[-/]\d{1,2}(?:[-/]\d{1,2})?/, // 2026-10-07 / 2026/10
  /\d{4}\s*年\s*\d{1,2}\s*月/,       // 2026年10月
  /v?\d+\.\d+(?:\.\d+)?/,             // v1.0.0 / 0.4.2 / 3.1
  /\d+(?:\.\d+)?\s*(?:元|万|亿|条|个|页|MB|GB|KB|ms|s|%|pp|人|天|周|月|年)/, // 数字+单位
  /[0-9a-f]{7,40}/,                   // commit hash / 哈希
  /(?:已|完成|发布|定版|上线|修复|合并|提交|推出|决定|确认)/, // 完成态动词
  /(?:`[^`]+`|\.js|\.mjs|\.md|\.json)/, // 代码/文件名
];

/** 推测信号：不确定词 / 未来态 / 建议倾向。 */
const INFER_RE = [
  /(?:可能|大概|推测|估计|或许|应该|也许|感觉|似乎|说不定|恐怕)/,
  /(?:建议|推荐|倾向|拟|计划|准备|将要|将|打算|考虑)/,
  /(?:如果|假设|若|一旦).*(?:则|就|会|可以)/, // 条件句多为建议/推演
  /(?:不确定|待确认|待验证|未验证|未确认|存疑)/,
  /(?:低置信|需验证|需核实)/,
];

/** 置信度基础值：条目自带 confidence 映射。 */
const CONF_BASE = { high: 0.9, medium: 0.7, low: 0.5, wrong: 0.3 };

/** 默认置信度闸门：低于该值强制按推测标注（宁缺毋滥，防推测当事实）。 */
export const DEFAULT_CONF_FLOOR = 0.6;

/**
 * 单条候选的启发式判断。
 * @param {string} question 用户问题（用于相关性词面判断）
 * @param {{block:string, confidence?:string}} entry 候选条目
 * @param {{floor?:number}} opts
 * @returns {{relevant:boolean, type:"fact"|"inference", confidence:number, reason:string}}
 */
export function judgeEntryHeuristics(question, entry, opts = {}) {
  const floor = opts.floor ?? DEFAULT_CONF_FLOOR;
  const block = String(entry?.block ?? "");
  const q = String(question ?? "");
  const reasons = [];

  // 相关性：query 字符 2-gram 与正文命中（中文 query 无空格，词面 token 拆不出；
  // 2-gram 子串重叠能抓住「发布/定版/版本」这类实义组合）。命中 ≥1 即相关——
  // 筛选层只滤「完全无词面重叠」的噪声，检索精度交给 BM25，不在此收紧误杀相关素材。
  const qClean = q.toLowerCase().replace(/[\s,，。！？!?;；:：'"（）()《》、\-_/【】]+/g, "");
  const bigrams = [];
  for (let i = 0; i < qClean.length - 1; i++) bigrams.push(qClean.slice(i, i + 2));
  const body = block.toLowerCase();
  const hits = bigrams.filter((bg) => body.includes(bg)).length;
  const relevant = hits >= 1;
  if (relevant) reasons.push(`2-gram重叠${hits}/${bigrams.length}`);

  // 类型：推测词优先（可能/大概/建议直接标记不确定，即使带「发布」等完成态动词也是推测）；
  // 无推测词且命中事实信号 → fact；都无 → 保守按 inference（宁缺毋滥）。
  const factHit = FACT_RE.some((re) => re.test(block));
  const inferHit = INFER_RE.some((re) => re.test(block));
  let type = "inference";
  if (inferHit) {
    reasons.push("命中推测信号（不确定/建议/未来态），推测词优先于事实词");
  } else if (factHit) {
    type = "fact";
    reasons.push("命中事实信号（日期/版本/数字/完成态），无推测词");
  } else {
    reasons.push("无明确事实信号，按推测保守标注");
  }

  // 置信度：条目自带 + 信号修正
  const base = CONF_BASE[entry?.confidence] ?? CONF_BASE.medium;
  let conf = base;
  if (factHit && inferHit) conf -= 0.1; // 混杂信号降置信
  if (!factHit && !inferHit) conf -= 0.15; // 无信号更不确定
  conf = Math.round(Math.max(0.1, Math.min(1, conf)) * 10) / 10;

  // 闸门：低于 floor → 强制推测（宁缺毋滥）
  if (conf < floor && type === "fact") {
    type = "inference";
    reasons.push(`置信度${conf.toFixed(1)}<闸门${floor.toFixed(1)}，强制按推测标注`);
  }

  return { relevant, type, confidence: conf, reason: reasons.join("；") };
}

/**
 * 启发式筛选（默认，零 LLM）：对候选逐条判断，返回结构化结果数组。
 * @param {string} question
 * @param {Array<{id?:string|number, block:string, confidence?:string}>} candidates
 * @param {{floor?:number, minOverlap?:number}} opts
 */
export function screenByHeuristics(question, candidates, opts = {}) {
  return (candidates ?? []).map((c, i) => {
    const j = judgeEntryHeuristics(question, c, opts);
    return {
      id: c.id ?? i,
      relevant: j.relevant,
      type: j.type,
      confidence: j.confidence,
      reason: j.reason,
      by: "code",
    };
  });
}

// ---- LLM 结构化判断（可选，Jev 三题型）----

/** 筛选员系统提示（LLM 版）：结构化 JSON，不生成杂文。 */
export function screenerSystemPrompt(floor = DEFAULT_CONF_FLOOR) {
  return (
    "你是记忆筛选员：对候选记忆条目做结构化判断，不写作文、不归纳、不改写。\n" +
    "输入：用户问题 + 候选条目列表。\n" +
    "输出：严格 JSON 数组，每条对应一个候选（按 id 对齐）：\n" +
    '[{"id": <候选id>, "relevant": true|false, "type": "fact"|"inference", "confidence": 0-1, "reason": "一句话理由"}]\n' +
    "判定口径：\n" +
    '- "relevant"：条目是否与用户问题直接相关（Noul 布尔判断）；不相关=丢弃候选。\n' +
    '- "type"："fact"=条目是已发生的明确事实（有时间/版本/数字/完成态支撑）；"inference"=推测/建议/不确定/未来态。\n' +
    '- "confidence"：0-1 标量（Score），代表你对上面 type 判定的把握；把握不足给低分。\n' +
    `- 服务端会执行置信度闸门：confidence < ${floor} 的条目一律按推测标注，你的 type 只作参考。\n` +
    "- 拿不准类型时（既有数字又像推测），type 给 inference、confidence 给低分——宁缺毋滥。\n" +
    "只输出 JSON 数组本身，不要解释、不要 markdown 代码块。"
  );
}

/**
 * LLM 结构化筛选（可选）：逐条分类 + 置信度；服务端闸门兜底。
 * @param {object} llmClient DSH 会话 llm
 * @param {{provider:string, model:string}} modelInfo
 * @param {string} question
 * @param {Array<{id?:string|number, block:string}>} candidates
 * @param {{floor?:number, maxTokens?:number, temperature?:number}} opts
 * @returns {Promise<Array<{id,relevant,type,confidence,reason,by:"llm"}>>}
 */
export async function screenWithLlm(llmClient, modelInfo, question, candidates, opts = {}) {
  if (!llmClient) throw new Error("llmClient 不可用（未注入 llm 依赖）");
  const floor = opts.floor ?? DEFAULT_CONF_FLOOR;
  const list = (candidates ?? []).map((c, i) => `[${i}] ${String(c.block ?? "").slice(0, 600)}`);
  const user = `用户问题：${question}\n\n候选条目（id 即方括号序号）：\n\n${list.join("\n\n")}`;

  let text = "";
  for await (const chunk of llmClient.stream({
    provider: modelInfo.provider,
    model: modelInfo.model,
    system: screenerSystemPrompt(floor),
    messages: [
      {
        id: `linghun-assembler-screener-${Date.now()}`,
        role: "user",
        content: [{ type: "text", text: user }],
        source: { kind: "plugin", plugin: "linghun-assembler" },
      },
    ],
    temperature: opts.temperature ?? 0,
    maxTokens: opts.maxTokens ?? 1200,
    purpose: "compaction",
  })) {
    if (chunk.type === "text-delta") text += chunk.text;
  }
  const arr = parseScreenJson(text, candidates?.length ?? 0);

  // 服务端兜底：类型合法性 + 置信度闸门（不信任 LLM 的 type 判断）
  return arr.map((r) => {
    const relevant = r.relevant === true;
    let type = r.type === "fact" ? "fact" : "inference";
    let conf = Math.round(Math.max(0.1, Math.min(1, Number(r.confidence) || 0.5)) * 10) / 10;
    if (conf < floor && type === "fact") {
      type = "inference";
      r.reason = (r.reason ? r.reason + "；" : "") + `置信度${conf.toFixed(1)}<闸门${floor.toFixed(1)}，强制按推测标注`;
    }
    return { id: r.id, relevant, type, confidence: conf, reason: String(r.reason ?? ""), by: "llm" };
  });
}

/** 解析筛选 LLM 输出（防御：剥离代码块/非数组前缀）。 */
export function parseScreenJson(text, expectedCount) {
  const t = String(text ?? "");
  const m = t.match(/```(?:json)?\s*([\s\S]*?)```/) ?? t.match(/\[[\s\S]*\]/);
  const raw = m ? m[1] ?? m[0] : t;
  let arr;
  try {
    arr = JSON.parse(raw.trim());
  } catch {
    const start = raw.indexOf("[");
    const end = raw.lastIndexOf("]");
    if (start >= 0 && end > start) {
      try {
        arr = JSON.parse(raw.slice(start, end + 1));
      } catch {
        throw new Error("筛选输出非 JSON 数组: " + t.slice(0, 160));
      }
    } else {
      throw new Error("筛选输出非 JSON 数组: " + t.slice(0, 160));
    }
  }
  if (!Array.isArray(arr)) throw new Error("筛选输出不是数组");
  return arr.slice(0, Math.max(expectedCount, 1));
}

// ---- 渲染 ----

/** 把分类结果渲染成带标注的素材文本：过滤不相关，相关条目按【相关·类型·置信度】标注。 */
export function renderScreened(candidates, verdicts, opts = {}) {
  const floor = opts.floor ?? DEFAULT_CONF_FLOOR;
  const byId = new Map((verdicts ?? []).map((v) => [String(v.id), v]));
  const out = [];
  (candidates ?? []).forEach((c, i) => {
    const v = byId.get(String(c.id ?? i));
    if (!v || v.relevant !== true) return; // 不相关/缺失 → 丢弃
    const confLabel = v.confidence >= 0.8 ? "高置信" : v.confidence >= floor ? "中置信" : "低置信";
    const tag = `【相关·${v.type === "fact" ? "事实" : "推测"}·${confLabel}】`;
    out.push(`${tag} ${String(c.block ?? "").trim()}`);
  });
  return out.join("\n\n---\n\n");
}
