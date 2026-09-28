/**
 * 组装调用：把候选条目 + 用户问题交给 LLM，产出「有用素材包」。
 *
 * 摘要双轨 prompt（v4 实证修复）：summarization 类必须覆盖「事实线 + 建议线」，
 * 否则组装 LLM 压缩时会裁掉 rubric 要的建议要点（模块化/验证/配置/健壮性）。
 *
 * LLM 通道复用 DSH 会话 llmClient（与 linghun 收尾评估同一模式），
 * 不持有自己的 API key——provider/model 从 request/header 事件取。
 */

export function buildSystemPrompt(category) {
  const p =
    "你是记忆提取助手，负责把记忆库候选条目按用户问题组装成「有用素材包」，供回答者直接使用。\n" +
    "要求：\n" +
    "1. 只保留与问题直接相关的条目，无关的丢弃；\n" +
    "2. 具体细节必须原样保留：库名、版本号、数字、日期、代码、哈希——不得概括、不得省略；\n" +
    "3. 若条目之间存在矛盾（日期/数字/结论冲突），用「⚠️ 冲突：」明确标注两个口径；\n" +
    "4. 涉及时间先后/间隔的，保留全部相关日期，不要自己计算；\n" +
    "5. 输出紧凑，以「素材：」开头，不超过 800 字。";
  if (category === "summarization") {
    return (
      p +
      "\n6. 本问题是「综合总结/学到了什么」类：素材必须覆盖两条线——(a) 实际做过的功能与决策（事实线）；" +
      "(b) 助手给出的建议、改进方向、模块化/验证/配置/健壮性建议（建议线）。两条线都要保留，不要只留事实线。"
    );
  }
  return p;
}

export function buildUserPrompt(question, hitText) {
  return `用户问题：${question}\n\n候选记忆条目：\n\n${hitText}`;
}

/**
 * 调会话 LLM 组装素材包。
 * @param {object} llmClient DSH 会话 llm（ctx.inject(["llm"]) 拿到）
 * @param {{provider:string, model:string}} modelInfo 从 request/header 记录
 * @param {string} category 题型（knowledge_update/summarization/其他）
 * @param {string} question 用户问题（组装 query）
 * @param {string} hitText 命中条目文本
 * @param {{temperature?:number, maxTokens?:number}} opts
 * @returns {Promise<string>} 组装文本（失败抛错由调用方降级）
 */
export async function assembleWithLlm(llmClient, modelInfo, category, question, hitText, opts = {}) {
  if (!llmClient) throw new Error("llmClient 不可用（未注入 llm 依赖）");
  let text = "";
  for await (const chunk of llmClient.stream({
    provider: modelInfo.provider,
    model: modelInfo.model,
    system: buildSystemPrompt(category),
    messages: [
      {
        id: `linghun-assembler-${Date.now()}`,
        role: "user",
        content: [{ type: "text", text: buildUserPrompt(question, hitText) }],
        source: { kind: "plugin", plugin: "linghun-assembler" },
      },
    ],
    temperature: opts.temperature ?? 0.2,
    maxTokens: opts.maxTokens ?? 1200,
    purpose: "compaction",
  })) {
    if (chunk.type === "text-delta") text += chunk.text;
  }
  const out = text.trim();
  if (!out) throw new Error("LLM 返回空组装");
  return out;
}
