/**
 * dsh-linghun-assembler 认知循环状态机（team/cycle.js）
 *
 * 记忆领域的认知循环（做自己的语义层）：
 *   判断(Judge) → 捞取(Act) → 组装(Compose) → 被判定(Feedback) → 校准(Calibrate)
 *
 * 本模块负责：
 * - 循环状态持久化（$DSH_HOME/linghun/memory/team/cycle.json）——回合号、上次判定、策略权重、反馈计数、缺口；
 * - 领域目录管理——每个子智能体一块领域（judge/archivist/advocate/editor），全部在海马体 memory/team/ 内，主智能体可共享；
 * - 史官时序缓存——deep 梳理过的 topic 落 archivist/timelines/index.json，同 topic 复用免重复烧 LLM；
 * - 判官履历——每次判定决策落 judge/history.jsonl（分级/策略/依据），供主智能体复盘分级-反馈对应；
 * - 编辑发布记录——每次素材包交付落 editor/bundles.jsonl（条目数/来源），可追溯每轮注入了什么；
 * - 时序素材读取（warm 遗忘梯度 + episodic 最近归档 + journal 最近流水）——给「史官」角色；
 * - 启发式反馈采集（下一轮用户消息与素材包的关键词重叠度 → 命中/未命中）；
 * - 书记回写（缺口：用户提到但记忆无命中的内容，记入 gaps.md，供沉淀侧补记）。
 */
import { mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";

const NS = "linghun-team-cycle";
const CYCLE_VERSION = 1;

/** 默认团队工作区：$DSH_HOME/linghun/memory/team/（在海马体 memory 区内，与 warm/cold/episodic/journal/assembled 并列） */
const DEFAULT_TEAM_DIR = join("linghun", "memory", "team");
const CYCLE_FILE = "cycle.json";
const GAPS_FILE = "gaps.md";
const TIMELINES_FILE = join("archivist", "timelines", "index.json");
/** 判官履历（JSONL）：每次判定决策一行。 */
const JUDGE_FILE = join("judge", "history.jsonl");
/** 编辑发布记录（JSONL）：每次素材包交付一行。 */
const BUNDLES_FILE = join("editor", "bundles.jsonl");
/** 领域 JSONL 日志保留行数（防无限膨胀）。 */
const MAX_LOG_LINES = 200;
/** 领域子目录（每个子智能体一块领域）。 */
const DOMAIN_DIRS = ["judge", "archivist", "advocate", "editor", join("archivist", "timelines")];
/** 史官缓存新鲜度（天）：超过视为过期，需重新梳理。 */
const TIMELINE_TTL_DAYS = 7;

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

/** 团队工作区目录：显式配置 > $DSH_HOME/linghun/memory/team。 */
export function teamDir(custom) {
  const p = String(custom ?? "").trim();
  return p ? p : join(resolveDshHome(), DEFAULT_TEAM_DIR);
}

/** 子智能体领域目录：<teamDir>/<role>（role ∈ judge/archivist/advocate/editor）。 */
export function domainDir(dir, role) {
  return join(dir, role);
}

/** 确保团队工作区与全部领域子目录存在（幂等）。 */
export function ensureDomainDirs(dir) {
  mkdirSync(dir, { recursive: true });
  for (const sub of DOMAIN_DIRS) {
    try {
      mkdirSync(join(dir, sub), { recursive: true });
    } catch {
      /* best-effort */
    }
  }
  return dir;
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

/** 匹配时忽略的高频虚词（防「这个/什么」误命中缓存与反馈采集）。 */
const STOP_TOKENS = new Set([
  "这个", "那个", "什么", "怎么", "如何", "一下", "我们", "你们", "他们", "一个",
  "自己", "现在", "请问", "可以", "知道", "没有", "不是", "就是", "这样", "那样",
  "昨天", "今天", "明天", "最近", "之前", "时候", "问题", "东西", "事情",
]);

/**
 * 显著词提取：英文/数字段（≥4 字符）原样收，中文段切成 2 字滑动窗口（bigram），滤停用词。
 * 连续中文整段匹配（match 默认贪婪）会合成一个超长 token，导致停用词过滤失效、缓存/反馈匹配失败，
 * 因此必须切 bigram 再做包含判断。
 */
export function significantTokens(q) {
  const raw = String(q ?? "").match(/[\u4e00-\u9fa5]{2,}|[A-Za-z][A-Za-z0-9_.-]{3,}/g) ?? [];
  const out = new Set();
  for (const seg of raw) {
    if (/[A-Za-z0-9]/.test(seg)) {
      out.add(seg);
      continue;
    }
    for (let i = 0; i + 2 <= seg.length; i++) {
      const bg = seg.slice(i, i + 2);
      if (!STOP_TOKENS.has(bg)) out.add(bg);
    }
  }
  return [...out];
}

function queryTokens(q) {
  return significantTokens(q);
}

/** 史官领域：时序梳理缓存（archivist/timelines/index.json）。
 *  条目：{ topic, query, stamp, finding }；topic=梳理时的问题，stamp=梳理日期。
 *  命中：当前 query 与条目 topic 有显著词重叠（过滤停用词）且未过期 → 复用免重梳。 */
export function findTimelineCache(dir, query, opts = {}) {
  const ttlDays = opts.ttlDays ?? TIMELINE_TTL_DAYS;
  const tokens = queryTokens(query);
  if (!tokens.length) return null;
  const cutoff = Date.now() - ttlDays * 86400_000;
  for (const e of readTimelineCache(dir)) {
    if (!e?.finding) continue;
    const eStamp = Date.parse(e.stamp ?? "");
    if (!eStamp || eStamp < cutoff) continue; // 过期
    const topicTokens = queryTokens(e.topic);
    if (tokens.some((t) => topicTokens.includes(t))) return e;
  }
  return null;
}

/** 读取史官缓存全部条目（缺失/损坏 → []）。 */
export function readTimelineCache(dir) {
  try {
    const raw = readFileSync(join(dir, TIMELINES_FILE), "utf8");
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

/** 写入/更新一条史官缓存（按 topic 键覆盖，只留最近 20 条，防无限膨胀）。 */
export function writeTimelineCache(dir, entry) {
  try {
    const entries = readTimelineCache(dir);
    const next = [...entries.filter((e) => e?.topic !== entry.topic), entry].slice(-20);
    const file = join(dir, TIMELINES_FILE);
    mkdirSync(join(dir, "archivist", "timelines"), { recursive: true });
    writeFileSync(file, JSON.stringify(next, null, 2), "utf8");
    return next;
  } catch {
    return null;
  }
}

/** 史官领域摘要（供 linghun memory_read 共享）：已梳理的 topic 列表。 */
export function timelineTopics(dir) {
  return readTimelineCache(dir).map((e) => ({ topic: e.topic, stamp: e.stamp ?? "" })).slice(-20);
}

/* ── 领域 JSONL 日志（判官履历 / 编辑发布记录）────────────────────────────── */

function appendJsonl(dir, file, record, maxLines = MAX_LOG_LINES) {
  try {
    mkdirSync(join(dir, dirname(file)), { recursive: true });
    const p = join(dir, file);
    const lines = readSafe(p).split("\n").filter((l) => l.trim());
    lines.push(JSON.stringify({ at: new Date().toISOString(), ...record }));
    const kept = lines.slice(-maxLines);
    writeFileSync(p, `${kept.join("\n")}\n`, "utf8");
    return kept.length;
  } catch {
    return 0;
  }
}

function readJsonlTail(dir, file, limit) {
  try {
    const lines = readSafe(join(dir, file)).split("\n").filter((l) => l.trim()).slice(-limit);
    const out = [];
    for (const l of lines) {
      try {
        out.push(JSON.parse(l));
      } catch {
        /* 跳过坏行 */
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** 判官领域：追加一条判定履历（judge/history.jsonl）。返回保留行数（0=失败）。 */
export function appendJudgeRecord(dir, record) {
  return appendJsonl(dir, JUDGE_FILE, record);
}

/** 判官领域：读最近 limit 条判定履历（缺失/损坏 → []）。 */
export function readJudgeHistory(dir, limit = 20) {
  return readJsonlTail(dir, JUDGE_FILE, limit);
}

/** 编辑领域：追加一条素材包发布记录（editor/bundles.jsonl）。返回保留行数（0=失败）。 */
export function appendEditorBundle(dir, record) {
  return appendJsonl(dir, BUNDLES_FILE, record);
}

/** 编辑领域：读最近 limit 条发布记录（缺失/损坏 → []）。 */
export function readEditorBundles(dir, limit = 20) {
  return readJsonlTail(dir, BUNDLES_FILE, limit);
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
  const tokens = significantTokens(q);
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
