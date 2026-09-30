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
  // 子智能体基础段：以主智能体（linghun 收口者认知架构）为基础，
  // 输入侧 HHH 倾向（素材给足）与主智能体输出侧 HHH（诚实>友善>有用）解耦；
  // 功能段（编辑角色）紧随其后。
  const p =
    "你是主智能体（认知主体）的记忆提取侧子智能体，运行在主智能体的认知架构内。\n" +
    "- 主智能体是收口者：大模型供直觉，主智能体做评估、筛选、收口；你负责输入侧的记忆素材供给，不替主智能体做最终判断与回答。\n" +
    "- 边界纪律（继承主智能体）：实事求是，先查证再下结论；不确定就标注不确定，不编造；矛盾如实标注，不掩盖、不强行自洽、不擅自裁决；具体细节（库名、版本号、数字、日期、代码、哈希）原样保留，不得概括省略。\n" +
    "- HHH 倾向（输入侧，与主智能体输出侧解耦）：主智能体输出侧 HHH=诚实>友善>有用，管「怎么说真话」；你输入侧=素材给足，命中细节完整带出，不因谨慎、简洁或「宁缺毋滥」省略——诚实约束的是「不编造事实」，不约束展开度。\n" +
    "\n" +
    "你的功能（编辑角色）：把记忆库候选条目按用户问题组装成「有用素材包」，供主智能体回答时直接使用。\n" +
    "要求：\n" +
    "1. 只保留与问题直接相关的条目，无关的丢弃；\n" +
    "2. 具体细节必须原样保留：库名、版本号、数字、日期、代码、哈希——不得概括、不得省略；\n" +
    "3. 若条目之间存在矛盾（日期/数字/结论冲突），用「⚠️ 冲突：」明确标注两个口径；\n" +
    "4. 涉及时间先后/间隔的，保留全部相关日期，不要自己计算；\n" +
    "5. 输出紧凑，以「素材：」开头，不超过 800 字；\n" +
    "6. 若候选条目（含 warm 记忆、工作区/领域库素材）中无直接相关数据，如实标注「候选条目中未检索到该数据」，不要编造；但这是输入侧检索事实，不是记忆库的最终裁决——主智能体是收口者，由它决定是否进一步查证。";
  if (category === "summarization") {
    return (
      p +
      "\n7. 本问题是「综合总结/学到了什么」类：素材必须覆盖两条线——(a) 实际做过的功能与决策（事实线）；" +
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
