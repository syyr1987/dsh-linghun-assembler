/**
 * dsh-linghun-assembler 认知循环状态机（team/cycle.js）
 *
 * 记忆领域的认知循环（做自己的语义层）：
 *   判断(Judge) → 捞取(Act) → 组装(Compose) → 被判定(Feedback) → 校准(Calibrate)
 *
 * 本模块负责：
 * - 循环状态持久化（$DSH_HOME/linghun/team/cycle.json）——回合号、上次判定、策略权重、反馈计数、缺口；
 * - 时序素材读取（warm 遗忘梯度 + episodic 最近归档 + journal 最近流水）——给「史官」角色；
 * - 启发式反馈采集（下一轮用户消息与素材包的关键词重叠度 → 命中/未命中）；
 * - 书记回写（缺口：用户提到但记忆无命中的内容，记入 gaps.md，供沉淀侧补记）。
 */
import { mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";

const NS = "linghun-team-cycle";
const CYCLE_VERSION = 1;

/** 默认团队工作区：$DSH_HOME/linghun/team/ */
const DEFAULT_TEAM_DIR = join("linghun", "team");
const CYCLE_FILE = "cycle.json";
const GAPS_FILE = "gaps.md";

/** 空循环状态。 */
export function emptyCycle() {
  return {
    version: CYCLE_VERSION,
    turnCount: 0,
    lastJudge: null,
    judgeStats: { light: 0, medium: 0, deep: 0, strategy: {} },
    feedback: { hits: 0, misses: 0, lastAt: null, recent: [] },
    gaps: [],
    createdAt: null,
    updatedAt: null,
  };
}

/** 团队工作区目录：显式配置 > $DSH_HOME/linghun/team。 */
export function teamDir(custom) {
  const p = String(custom ?? "").trim();
  return p ? p : join(resolveDshHome(), DEFAULT_TEAM_DIR);
}

/** 读取循环状态；不存在或损坏时返回空状态（best-effort，不抛错）。 */
export function readCycle(dir) {
  try {
    const raw = readFileSync(join(dir, CYCLE_FILE), "utf8");
    const data = JSON.parse(raw);
    if (!data || typeof data !== "object") return emptyCycle();
    return { ...emptyCycle(), ...data };
  } catch {
    return emptyCycle();
  }
}

/** 写循环状态（原子：先写临时文件再 rename，避免并发半写）。 */
export function writeCycle(dir, cycle) {
  mkdirSync(dir, { recursive: true });
  const target = join(dir, CYCLE_FILE);
  const tmp = `${target}.${process.pid}.tmp`;
  const now = new Date().toISOString();
  const data = { ...cycle, updatedAt: now, createdAt: cycle.createdAt ?? now };
  writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  try {
    writeFileSync(target, JSON.stringify(data, null, 2), "utf8");
  } finally {
    try {
      rmSync(tmp, { force: true }); // 清理临时文件（best-effort）
    } catch {
      /* 忽略清理失败 */
    }
  }
  return data;
}

/** 记录一轮判定（判断+捞取+组装完成后的校准侧统计）。 */
export function recordTurn(cycle, judge) {
  const next = {
    ...cycle,
    turnCount: (cycle.turnCount ?? 0) + 1,
    lastJudge: judge ?? null,
    judgeStats: {
      light: (cycle.judgeStats?.light ?? 0) + (judge?.level === "light" ? 1 : 0),
      medium: (cycle.judgeStats?.medium ?? 0) + (judge?.level === "medium" ? 1 : 0),
      deep: (cycle.judgeStats?.deep ?? 0) + (judge?.level === "deep" ? 1 : 0),
      strategy: {
        ...(cycle.judgeStats?.strategy ?? {}),
        [(judge?.strategy ?? "general")]: ((cycle.judgeStats?.strategy ?? {})[judge?.strategy ?? "general"] ?? 0) + 1,
      },
    },
  };
  return next;
}

/** 记录一条反馈（被判定→校准：命中/未命中）。 */
export function recordFeedback(cycle, { hit, query, at }) {
  const recent = (cycle.feedback?.recent ?? []).slice(-19);
  recent.push({ hit: !!hit, query: String(query ?? "").slice(0, 80), at: at ?? new Date().toISOString() });
  return {
    ...cycle,
    feedback: {
      hits: (cycle.feedback?.hits ?? 0) + (hit ? 1 : 0),
      misses: (cycle.feedback?.misses ?? 0) + (hit ? 0 : 1),
      lastAt: at ?? new Date().toISOString(),
      recent,
    },
  };
}

/** 记录一个记忆缺口（用户提到但记忆无命中，供沉淀侧补记）。 */
export function recordGap(cycle, { query, hitText, at }) {
  const gap = { query: String(query ?? "").slice(0, 120), note: "", at: at ?? new Date().toISOString() };
  const gaps = [...(cycle.gaps ?? []), gap].slice(-49);
  return { ...cycle, gaps };
}

/** 追加缺口到 gaps.md（书记落盘，供 linghun 沉淀流程参考）。 */
export function appendGapFile(dir, gap) {
  try {
    mkdirSync(dir, { recursive: true });
    const line = `- ${gap.at} 提到「${gap.query}」，记忆无命中\n`;
    writeFileSync(join(dir, GAPS_FILE), line, { flag: "a", encoding: "utf8" });
  } catch {
    /* best-effort */
  }
}

/**
 * 时序素材读取（史官角色的输入源）：
 * - warm 条目按 lastAccess 降序（遗忘梯度）取前 topRecent；
 * - episodic 最近文件尾部（历史归档）；
 * - journal 最近 N 天文件的尾部（原始流水，deep 模式才读）。
 * 全部 best-effort：任一源缺失不影响其他源。
 */
export function loadTimelineMaterial(dshHome, opts = {}) {
  const { topRecent = 8, episodicTail = 6000, journalDays = 3, journalTail = 4000 } = opts;
  const memoryDir = join(dshHome, "linghun", "memory");
  const warmText = readSafe(join(memoryDir, "warm.md"));
  const parts = [];

  // 1) warm 遗忘梯度：按 lastAccess 降序（有 lastAccess 的优先，无的最后）
  if (warmText.trim()) {
    const blocks = warmText.split(/\n(?=## )/).map((b) => b.trim()).filter(Boolean);
    const withTs = blocks
      .map((b) => ({ b, ts: (b.match(/<!-- last_access: ([^>]+) -->/) ?? [])[1] ?? "" }))
      .sort((x, y) => (x.ts < y.ts ? 1 : x.ts > y.ts ? -1 : 0));
    const recent = withTs.slice(0, topRecent).map((x) => x.b.replace(/\n?<!-- last_access: [^>]+ -->/, ""));
    if (recent.length) parts.push(`## warm 近期（按最近访问）\n\n${recent.join("\n\n---\n\n")}`);
  }

  // 2) episodic 最近归档文件尾部
  const episodicDir = join(memoryDir, "episodic");
  const lastEp = lastFileTail(episodicDir, episodicTail);
  if (lastEp) parts.push(`## episodic 最近归档\n\n${lastEp}`);

  // 3) journal 最近 N 天流水尾部
  if (journalDays > 0) {
    const journalDir = join(dshHome, "linghun", "journal");
    const files = listSortedDesc(journalDir).slice(0, journalDays);
    for (const f of files) {
      const tail = readSafe(join(journalDir, f)).slice(-journalTail);
      if (tail.trim()) parts.push(`## journal ${f}（流水尾）\n\n${tail}`);
    }
  }

  return parts.join("\n\n---\n\n");
}

/** 启发式反馈：下一轮用户消息与素材包的关键词重叠度 → 判定命中/未命中。 */
export function matchFeedback(query, asmText) {
  const q = String(query ?? "");
  const t = String(asmText ?? "");
  if (!q.trim() || !t.trim()) return { hit: false, overlap: 0 };
  // 取查询中的显著词（≥2 字符中文片段或 ≥4 字符词）
  const tokens = q.match(/[\u4e00-\u9fa5]{2,}|[A-Za-z][A-Za-z0-9_.-]{3,}/g) ?? [];
  if (!tokens.length) return { hit: false, overlap: 0 };
  let hits = 0;
  for (const tok of tokens) {
    if (t.includes(tok)) hits++;
  }
  const overlap = hits / tokens.length;
  // 至少命中一个显著词且重叠度 >= 0.25 视为素材被使用（命中）
  return { hit: hits > 0 && overlap >= 0.25, overlap };
}

function readSafe(p) {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return "";
  }
}

function listSortedDesc(dir) {
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith(".md") || f.endsWith(".jsonl"))
      .sort((a, b) => (a < b ? 1 : -1));
  } catch {
    return [];
  }
}

function lastFileTail(dir, maxBytes) {
  const files = listSortedDesc(dir);
  if (!files.length) return "";
  return readSafe(join(dir, files[0])).slice(-maxBytes);
}

export { NS };
