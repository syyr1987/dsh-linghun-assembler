/**
 * 暖态记忆解析：与 linghun-plugin memory.js 的 warm.md 格式对齐。
 *
 * 条目格式：
 *   ## <stamp> [<kind>] <confidence>
 *   <正文>
 *   <!-- last_access: <ts> -->
 * confidence 缺省视为 medium；wrong=已翻转事实（注入排除）。
 */
export function parseWarm(text) {
  const blocks = String(text ?? "")
    .split(/\n(?=## )/)
    .map((b) => b.trim())
    .filter(Boolean);
  return blocks.map((block) => {
    const m = block.match(/<!-- last_access: ([^>]+) -->/);
    const cm = block.match(/^## .*?\[[a-z_]+\]\s+(high|medium|low|wrong)\s*$/m);
    return { block, lastAccess: m ? m[1].trim() : null, confidence: cm ? cm[1] : "medium" };
  });
}

/** 渲染条目为纯内容（剥 last_access），wrong 默认排除；keepLow 加低置信声明。 */
export function renderWarmEntries(entries, opts = {}) {
  return entries
    .filter((e) => opts.includeWrong === true || e.confidence !== "wrong")
    .map((e) => {
      const body = e.block.replace(/\n?<!-- last_access: [^>]+ -->/, "");
      const tag =
        opts.keepLow === false || e.confidence !== "low"
          ? ""
          : "【低置信·需验证】 ";
      return `${tag}${body}`;
    })
    .join("\n\n---\n\n");
}
