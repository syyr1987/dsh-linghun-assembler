/**
 * 暖态记忆解析：与 linghun-plugin memory.js 的 warm.md 格式对齐。
 *
 * 条目格式：
 *   ## <stamp> [<kind>] <confidence>
 *   <正文>
 *   <!-- last_access: <ts> -->
 * confidence 缺省视为 medium；wrong=已翻转事实（注入排除）。
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, extname, basename, relative } from "node:path";

/** 工作区/领域目录扫描配置：跳过的目录名。 */
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "coverage", ".next"]);
/** 单个工作区文件读取上限（字节，超长截断头部，防 LLM 输入爆炸）。 */
const WS_FILE_MAX_BYTES = 8000;
/** 明显超大文件跳过阈值（字节）：超过即不读，防大文件拖垮扫描。 */
const WS_FILE_SKIP_BYTES = 512 * 1024;
/** 工作区文件总数上限（防超大领域库拖垮检索）。 */
const WS_FILE_MAX_COUNT = 60;

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

/**
 * 自定义工作区/领域库接入：递归扫描用户指定目录下的 .md 文件，
 * 作为 warm 之外的额外候选源参与检索（候选未命中判定也覆盖领域库）。
 * 返回 [{ file, text }]；文件过大截断、目录黑名单跳过、总数设上限防爆。
 */
export function loadWorkspaceDocs(dirs) {
  const out = [];
  const seen = new Set();
  const walk = (dir) => {
    if (out.length >= WS_FILE_MAX_COUNT) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // 目录不存在/无权限：静默跳过，不阻断主流程
    }
    for (const ent of entries) {
      if (out.length >= WS_FILE_MAX_COUNT) return;
      if (SKIP_DIRS.has(ent.name)) continue;
      const p = join(dir, ent.name);
      if (ent.isDirectory()) {
        walk(p);
      } else if (ent.isFile() && extname(ent.name).toLowerCase() === ".md") {
        let st;
        try {
          st = statSync(p);
        } catch {
          continue;
        }
        if (st.size > WS_FILE_SKIP_BYTES) continue; // 明显超大文件跳过
        let text;
        try {
          text = readFileSync(p, "utf8");
        } catch {
          continue; // 二进制/编码异常：跳过
        }
        if (text.length > WS_FILE_MAX_BYTES) text = text.slice(0, WS_FILE_MAX_BYTES) + "\n…[截断]";
        if (!text.trim()) continue;
        const key = p;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ file: p, text });
      }
    }
  };
  for (const d of dirs || []) {
    if (d && typeof d === "string" && d.trim()) walk(d.trim());
  }
  return out;
}
