/**
 * dsh-linghun-assembler — 本体与知识注入（BEAM 第二轮验证机制回灌）。
 *
 * BEAM 双管齐下 v4 验证有效的两个机制：
 *   1. 记忆本体主题索引优先：ontology.md（warm 按主题桶 LLM 聚合）→ TAG_ALIAS 主题命中
 *      则主题节点优先，BM25 兜底——比纯 BM25 的分散命中更稳（隔离 60 → 本体 70 → v4 85/90）；
 *   2. 知识本体注入：对话外稳定技术知识（版本/索引参数/成本公式）→ K_ALIAS 实体命中
 *      则注入知识节点——救「对话外知识」类题（知识本体救对话外知识是 v4 最终结论之一）。
 *
 * 本模块负责：
 *   - 解析 ontology.md / knowledge.md 为节点
 *   - 别名命中（TAG_ALIAS / K_ALIAS）
 *   - 渲染注入块
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, extname, basename } from "node:path";

/** 解析本体/知识 md 为主题节点数组（## 起行；可选 <!-- theme: x --> / <!-- kind: x --> 标注）。
 *  返回 [{ theme, body, stamp, kind }]。 */
export function parseNodes(text) {
  const blocks = String(text ?? "")
    .split(/\n(?=## )/)
    .map((b) => b.trim())
    .filter(Boolean);
  return blocks.map((block) => {
    const firstLine = block.split("\n")[0] ?? "";
    const theme = firstLine.replace(/^##\s+/, "").trim();
    const body = block.replace(/^##\s+.*\n/, "").trim();
    const tm = body.match(/\b(20\d{2}-\d{2}-\d{2})\b/);
    const km = block.match(/<!-- kind: ([^>]+) -->/);
    return { theme, body, stamp: tm ? tm[1] : null, kind: km ? km[1].trim() : "topic" };
  });
}

/** 渲染节点（剥元数据），用于注入。 */
export function renderNodes(nodes) {
  return nodes
    .map((n) => (n.body ? `## ${n.theme}\n${n.body}` : ""))
    .filter(Boolean)
    .join("\n\n");
}

/** 别名命中：query 命中别名 → 返回对应主题节点（同主题去重，保本体顺序）。
 *  @param aliases { [alias]: theme }
 */
export function hitByAlias(query, nodes, aliases = {}) {
  const q = String(query ?? "").toLowerCase();
  if (!q || !nodes?.length || !aliases) return [];
  const hits = [];
  const seen = new Set();
  for (const [alias, theme] of Object.entries(aliases)) {
    if (q.includes(String(alias).toLowerCase())) {
      const node = nodes.find((n) => n.theme === theme);
      if (node && !seen.has(node.theme)) {
        seen.add(node.theme);
        hits.push(node);
      }
    }
  }
  return hits;
}

/** 读取记忆本体投影（默认 $DSH_HOME/linghun/memory/ontology.md，可配路径）。读不到返回空数组。 */
export function loadOntology(file) {
  if (!file) return [];
  try {
    const text = readFileSync(file, "utf8");
    return parseNodes(text);
  } catch {
    return [];
  }
}

/** 知识本体：默认 $DSH_HOME/linghun/memory/knowledge.md（对话外稳定技术知识，手工/脚本维护）。
 *  也可指向用户领域库中的知识文件。 */
export function loadKnowledge(file) {
  if (!file) return [];
  try {
    const text = readFileSync(file, "utf8");
    return parseNodes(text);
  } catch {
    return [];
  }
}

/** 规则本体（BEAM 三本体方案·规则本体）：默认 $DSH_HOME/linghun/memory/rules.md
 *  （总结经验/长期规则，memory_rules 工具沉淀）。R_ALIAS 规则别名命中 → 注入规则节点。 */
export function loadRules(file) {
  if (!file) return [];
  try {
    const text = readFileSync(file, "utf8");
    return parseNodes(text);
  } catch {
    return [];
  }
}

/** 扫描工作区/领域目录中的知识候选（.md 文件，排除明显超大），供知识别名命中兜底。
 *  复用 warm.js 的扫描纪律（黑名单/上限/截断）。 */
export function loadKnowledgeDirs(dirs) {
  const SKIP = new Set(["node_modules", ".git", "dist", "build", "coverage", ".next"]);
  const MAX_COUNT = 20;
  const SKIP_BYTES = 512 * 1024;
  const MAX_BYTES = 8000;
  const out = [];
  const seen = new Set();
  const walk = (dir) => {
    if (out.length >= MAX_COUNT) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (out.length >= MAX_COUNT) return;
      if (SKIP.has(ent.name)) continue;
      const p = join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.isFile() && extname(ent.name).toLowerCase() === ".md") {
        try {
          const st = statSync(p);
          if (st.size > SKIP_BYTES) continue;
          let text = readFileSync(p, "utf8");
          if (text.length > MAX_BYTES) text = text.slice(0, MAX_BYTES) + "\n…[截断]";
          if (!text.trim() || seen.has(p)) continue;
          seen.add(p);
          out.push({ file: p, name: basename(p, ".md"), text });
        } catch {
          /* 跳过 */
        }
      }
    }
  };
  for (const d of dirs || []) if (d && typeof d === "string" && d.trim()) walk(d.trim());
  return out;
}

export default { parseNodes, renderNodes, hitByAlias, loadOntology, loadKnowledge, loadRules, loadKnowledgeDirs };
