/**
 * dsh-linghun-assembler：灵魂（dsh-linghun）的「提取侧子智能体」组装层插件。
 *
 * 职责：在每次用户消息开始（turn/start）时，从 warm 记忆库按当前问题做
 * BM25 检索（题型分流策略），调会话 LLM 组装「有用素材包」，写入
 * linghun 的注入通道（memory.assembler.injectPath / LINGHUN_MEMORY_OVERRIDE）。
 *
 * 与 dsh-linghun 以插件组合形式使用：本插件负责「提取+组装」，
 * linghun 只保留注入通道（零 LLM 调用、零改动面）。
 *
 * 时序说明：turn/start 事件触发组装，写文件为 best-effort——本轮渲染若
 * 赶不上，下一轮必然用上（linghun 侧渲染按 mtime 缓存重新读取）。
 * LLM 失败时默认保留上次素材包（fallbackKeepLast），不阻断对话。
 */
import { mkdirSync, writeFileSync, readFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, basename } from "node:path";
import z from "@deepseek-ai/schemastery";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import { parseWarm, renderWarmEntries, loadWorkspaceDocs } from "./warm.js";
import { BM25 } from "./bm25.js";
import {
  judgeByHeuristics,
  judgeWithLlm,
  archivistWithLlm,
  advocateWithLlm,
  editorWithLlm,
} from "./team/roles.js";
import {
  teamDir,
  ensureDomainDirs,
  findTimelineCache,
  writeTimelineCache,
  readCycle,
  writeCycle,
  recordTurn,
  recordFeedback,
  recordGap,
  appendGapFile,
  appendJudgeRecord,
  appendEditorBundle,
  loadTimelineMaterial,
  matchFeedback,
} from "./team/cycle.js";

const name = "linghun-assembler";
const inject = ["llm"];
const NS = "linghun-assembler";

/** 运行时探针（排障用）：追加 JSONL 到系统临时目录（跨平台，Windows 上不再落到盘根 /tmp）。 */
const PROBE_FILE = join(tmpdir(), "asm-probe.jsonl");
let PROBE_ENABLED = true;
function probe(tag, extra) {
  if (!PROBE_ENABLED) return;
  try {
    appendFileSync(PROBE_FILE, JSON.stringify({ at: new Date().toISOString(), tag, ...extra }) + "\n", "utf8");
  } catch {
    /* best-effort */
  }
}

/** 运行时探针（排障用）：追加 JSONL 到 /tmp，不影响任何业务路径。 */
const DEFAULT_WARM = join("linghun", "memory", "warm.md");
/** 素材包默认输出路径：与 linghun 侧 memory.assembler.injectPath 的默认约定同值（零配置联动）。 */
const DEFAULT_ASM = join("linghun", "memory", "assembled.md");

const Config = z.object({
  enabled: z.boolean().default(true),
  /** 运行时探针开关（写 /tmp/asm-probe.jsonl）；稳定期默认关，排障时开 true。 */
  debug: z.boolean().default(false),
  /** warm 记忆库路径；留空用 $DSH_HOME/linghun/memory/warm.md。 */
  warm: z.object({
    path: z.string().default(""),
  }).default({}),
  retrieval: z.object({
    /** 未命中题型分流策略时的默认 top-k。 */
    topK: z.number().default(12),
    /** 题型分流开关：knowledge_update 时间保底 / summarization 广覆盖。 */
    strategy: z.boolean().default(true),
    /** 检索模式：auto=按 warm 体量自适应（小体量直通，大体量 BM25）；always=强制检索；never=强制直通。 */
    mode: z.union(["auto", "always", "never"]).default("auto"),
    /** auto 模式的体量阈值：warm 条目数 <= 此值走直通（免检索层）。 */
    autoThreshold: z.number().default(24),
    /** 直通时素材文本上限（字符），超出截断防 LLM 输入爆炸。 */
    maxDirectChars: z.number().default(8000),
    /** 自定义工作区/领域库目录列表：递归扫描其中 .md 作为 warm 之外的额外候选源。
     *  留空=仅 $DSH_HOME/linghun/memory/*（原行为）；配置后领域库参与 BM25 检索与未命中判定。 */
    workspaceDirs: z.array(z.string()).default([]),
  }).default({}),
  assemble: z.object({
    temperature: z.number().default(0.2),
    maxTokens: z.number().default(1200),
  }).default({}),
  /** 素材包输出：写入 linghun 的注入通道路径（配 linghun memory.assembler.injectPath 同值）。 */
  output: z.object({
    // label 由 linghun 注入时统一添加（memory.assembler.label），assembler 只写纯素材。
    injectPath: z.string().default(""),
  }).default({}),
  /** 同会话防抖：距上次组装不足该毫秒数则跳过（避免连续追问高频触发）。 */
  debounceMs: z.number().default(5000),
  /** LLM/检索失败时保留上次素材包（不覆盖、不阻断对话）。 */
  fallbackKeepLast: z.boolean().default(true),
  /** 认知循环团队（v0.2）：判断→捞取→组装→被判定→校准。 */
  team: z.object({
    /** 团队工作区目录（循环状态 + 缺口）；留空 $DSH_HOME/linghun/team。 */
    cycleDir: z.string().default(""),
    judge: z.object({
      /** 用 LLM 判官（默认 false = 代码启发式，零额外 LLM 成本）。 */
      llm: z.boolean().default(false),
    }).default({}),
    archivist: z.object({
      /** deep 模式启用史官时序组织（LLM，把 warm/episodic/journal 组织成来龙去脉）。 */
      enabled: z.boolean().default(true),
      /** 时序素材：warm 按最近访问取 topN。 */
      topRecent: z.number().default(8),
      /** 时序素材：episodic 最近文件尾部字节上限。 */
      episodicTail: z.number().default(6000),
      /** 时序素材：journal 读取最近天数。 */
      journalDays: z.number().default(3),
      /** 时序素材：每个 journal 文件尾部字节上限。 */
      journalTail: z.number().default(4000),
    }).default({}),
    advocate: z.object({
      /** deep 模式启用辩手矛盾扫描（LLM，默认关——编辑 prompt 已含冲突标注要求）。 */
      enabled: z.boolean().default(false),
    }).default({}),
    feedback: z.object({
      /** 启发式反馈采集：下一轮消息与素材包关键词重叠度 → 命中/未命中（被判定→校准）。 */
      enabled: z.boolean().default(true),
    }).default({}),
  }).default({}),
}).default({});

/** 检索模式决策：auto=体量自适应（<=autoThreshold 直通，否则 BM25）；always/never 强制。 */
function decideRetrieval(mode, entryCount, autoThreshold = 24) {
  if (mode === "always") return true;
  if (mode === "never") return false;
  return entryCount > autoThreshold;
}

/** 从事件流收集最近一条真实用户消息（跳过运行时上下文注入）。 */
function collectLastUserQuery(session) {
  // 防御性获取：新版 DSH Session 契约用 snapshotEvents()（Inspect 形态），无 log/events 字段。
  const events =
    typeof session?.snapshotEvents === "function"
      ? session.snapshotEvents()
      : (session.log ?? session.events ?? []);
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev?.type !== "user/message") continue;
    const src = ev.data?.source;
    // MessageSource.kind 合法枚举：user / plugin / model / tool；runtime-context 不存在。
    if (src?.kind === "plugin" || src?.kind === "model") continue;
    const blocks = ev.data?.content ?? [];
    const text = blocks
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text)
      .join("\n")
      .trim();
    if (!text) continue;
    // 系统注入块（技能目录/上下文）走普通 user/message 通道，非真实用户问题——跳过
    if (text.includes("<system-reminder>") || text.includes("<user_query_context>")) continue;
    return text;
  }
  return "";
}

/** 运行时题型启发式：评测按 rubric 分类，线上无 category → 按 query 模式判断。
 *  只影响检索策略（时间保底/广覆盖），不影响组装质量。 */
function guessCategory(question) {
  const q = String(question ?? "");
  if (/总结|学到了什么|综合|回顾|学到了哪些|comprehensive summary|learned/i.test(q)) return "summarization";
  if (/最新|现在|目前|还剩|几天|多久|是否已经|已经.*了|当前|update/i.test(q)) return "knowledge_update";
  return "general";
}

function apply(ctx, config) {
  const cfg = () => config;
  PROBE_ENABLED = config.debug !== false;
  probe("apply-enter");
  const appCtx = ctx;

  let llmClient = null;
  let pendingSession = null;
  ctx.inject(["llm"], (sctx) => {
    llmClient = sctx.llm;
    probe("inject-llm", { has: !!sctx.llm });
    // llm 服务落定后，补跑因「注入未就绪」错过的会话认知循环
    if (pendingSession) {
      const s = pendingSession;
      pendingSession = null;
      probe("llm-deferred-run");
      void runCognitiveCycle(s);
    }
    return () => {
      llmClient = null;
    };
  });

  let lastModel = { provider: "", model: "" };
  let lastAssembleAt = 0;
  let lastError = "";
  /** 上一轮素材包交付（供下轮「被判定」反馈采集）。 */
  let lastDelivery = null;

  const warmPath = () => {
    const p = (cfg().warm?.path ?? "").trim();
    return p ? p : join(resolveDshHome(), DEFAULT_WARM);
  };
  const outPath = () =>
    (cfg().output?.injectPath ?? "").trim() || join(resolveDshHome(), DEFAULT_ASM);

  /**
   * 认知循环主流程（v0.2）：
   *   判断(Judge) → 捞取(Act) → 组装(Compose) → 被判定(Feedback) → 校准(Calibrate)
   * 角色：判官（启发式默认 / LLM 可选）、捞手（BM25 代码）、史官（deep 时序组织）、
   *       辩手（deep 可选矛盾扫描）、编辑（素材包收口）、书记（循环状态+缺口回写）。
   */
  const runCognitiveCycle = async (session) => {
    const c = cfg();
    // llm 双源兜底：inject 回调可能晚于首个 turn/start 落定，现场从 ctx 直接读服务
    const llm = llmClient ?? appCtx.llm ?? null;
    probe("cycle-enter", { enabled: c.enabled, hasLlm: !!llm, viaInject: !!llmClient, provider: lastModel.provider, model: lastModel.model, hasOut: !!outPath() });
    if (c.enabled === false) return probe("early-return", { reason: "enabled-false" });
    if (!llm) return probe("early-return", { reason: "no-llm" });
    if (!lastModel.provider || !lastModel.model) return probe("early-return", { reason: "no-model", provider: lastModel.provider, model: lastModel.model });
    const out = outPath();
    if (!out) return probe("early-return", { reason: "no-out" });

    const query = collectLastUserQuery(session);
    if (!query) return probe("early-return", { reason: "no-query" });

    const tDir = teamDir(c.team?.cycleDir);
    ensureDomainDirs(tDir);
    probe("team-dirs-created", { tDir });

    // 被判定(Feedback)：上一轮素材包 vs 本轮用户消息 → 命中/未命中（启发式）
    if (c.team?.feedback?.enabled !== false && lastDelivery) {
      const fb = matchFeedback(query, lastDelivery.text);
      if (fb.overlap > 0) {
        try {
          const cyc = readCycle(tDir);
          writeCycle(tDir, recordFeedback(cyc, { hit: fb.hit, query }));
        } catch {
          /* best-effort */
        }
      }
    }

    // 防抖：同一会话短时间内不重复组装
    const now = Date.now();
    if (now - lastAssembleAt < (c.debounceMs ?? 5000)) return;
    lastAssembleAt = now;

    const warmText = readWarmSafe(warmPath());
    if (!warmText) return;

    try {
      const entries = parseWarm(warmText);
      const mode = c.retrieval?.mode ?? "auto";
      const autoThreshold = c.retrieval?.autoThreshold ?? 24;

      // 判断(Judge)：判官（默认代码启发式；LLM 判官失败自动降级回启发式）
      const baseCycle = readCycle(tDir);
      let judge;
      if (c.team?.judge?.llm === true) {
        try {
          judge = await judgeWithLlm(llm, lastModel, query, baseCycle, c.assemble);
          judge.by = "llm";
        } catch (err) {
          judge = judgeByHeuristics(query);
          judge.by = "fallback";
          console.warn(`[linghun-assembler] LLM 判官失败，降级启发式: ${err?.message ?? err}`);
        }
      } else {
        judge = judgeByHeuristics(query);
        judge.by = "code";
      }
      const cat = guessCategory(query);
      const level = judge.level ?? "medium";
      const strategy = judge.strategy ?? "general";
      const searchQuery = judge.query || query;

      // 判官履历（judge/history.jsonl）：每次判定决策留痕（分级/策略/依据），供主智能体复盘
      try {
        appendJudgeRecord(tDir, {
          turn: (baseCycle.turnCount ?? 0) + 1,
          query,
          level,
          strategy,
          by: judge.by,
          model: lastModel.model,
        });
      } catch {
        /* best-effort */
      }

      // 捞取(Act)：light 直通 / medium BM25 / deep BM25(+时序+矛盾)
      // 自定义工作区/领域库接入：扫描 extraDirs 的 .md 作为 warm 之外额外候选源
      const wsDocs = loadWorkspaceDocs(c.retrieval?.workspaceDirs ?? []);
      // 候选全集：warm 条目 + 工作区文档（工作区文档直接当独立候选块参与检索/未命中判定）
      const candidateDocs = [
        ...entries.map((e) => ({ kind: "warm", entry: e, block: e.block })),
        ...wsDocs.map((d) => ({
          kind: "workspace",
          entry: { block: `【工作区·${basename(d.file)}】\n${d.text}`, lastAccess: null, confidence: "medium" },
          block: `【工作区·${basename(d.file)}】\n${d.text}`,
        })),
      ];
      const forceRetrieval = level === "deep" && candidateDocs.length > 0;
      const useRetrieval = decideRetrieval(mode, entries.length, autoThreshold) || forceRetrieval;
      const k =
        strategy === "summarization"
          ? 24
          : strategy === "knowledge_update"
            ? 12
            : level === "deep"
              ? Math.max(18, c.retrieval?.topK ?? 12)
              : (c.retrieval?.topK ?? 12);
      const recentSafe = strategy === "knowledge_update" ? 6 : 0;
      let hits;
      if (useRetrieval && candidateDocs.length) {
        const docs = candidateDocs.map((d) => d.block);
        const bm25 = new BM25(docs);
        const idxs = bm25.top(searchQuery, k, recentSafe);
        hits = idxs.map((i) => candidateDocs[i].entry);
      } else {
        // 直通：体量小或 light——全量交编辑（含工作区候选，标注来源），躲开 BM25 长文档惩罚
        hits = candidateDocs.map((d) => d.entry);
      }
      let hitText = renderWarmEntries(hits);
      const cap = c.retrieval?.maxDirectChars ?? 8000;
      if (hitText.length > cap) hitText = hitText.slice(0, cap) + "\n…(截断)…";

      // 史官（deep 时序组织）：先查领域缓存（同 topic 且新鲜 → 复用免重梳），未命中才读时序素材 + LLM 梳理，成功写入缓存
      let timelinePart = "";
      if (level === "deep" && c.team?.archivist?.enabled !== false && entries.length) {
        try {
          const cached = findTimelineCache(tDir, query);
          if (cached?.finding) {
            timelinePart = `【史官·缓存复用 ${cached.stamp}】\n${cached.finding}`;
          } else {
            const tl = loadTimelineMaterial(resolveDshHome(), c.team?.archivist ?? {});
            if (tl.trim()) {
              timelinePart = await archivistWithLlm(llm, lastModel, query, tl, c.assemble);
              if (timelinePart.trim()) {
                writeTimelineCache(tDir, { topic: query, query, stamp: new Date().toISOString().slice(0, 10), finding: timelinePart.trim() });
              }
            }
          }
        } catch (err) {
          console.warn(`[linghun-assembler] 史官组织失败（跳过时序素材）: ${err?.message ?? err}`);
        }
      }

      // 辩手（deep 可选矛盾扫描）
      let advocatePart = "";
      if (level === "deep" && c.team?.advocate?.enabled === true && hitText.trim()) {
        try {
          const adv = await advocateWithLlm(llm, lastModel, query, hitText, c.assemble);
          if (!/^无冲突$/.test(adv.trim())) advocatePart = adv;
        } catch (err) {
          console.warn(`[linghun-assembler] 辩手扫描失败（跳过）: ${err?.message ?? err}`);
        }
      }

      // 组装(Compose)：编辑角色收口（携带循环上下文）
      const composed = [hitText, timelinePart, advocatePart].filter(Boolean).join("\n\n---\n\n");
      const outText = await editorWithLlm(
        llm,
        lastModel,
        cat,
        query,
        composed || hitText,
        {
          lastJudge: baseCycle.lastJudge,
          feedback: baseCycle.feedback,
        },
        {
          temperature: c.assemble?.temperature ?? 0.2,
          maxTokens: c.assemble?.maxTokens ?? 1200,
        },
      );

      // 写素材包：纯素材内容（label 由 linghun 注入时统一添加，避免消费侧双层 label）
      const payload = `${outText}\n`;
      writeFileSafe(out, payload);
      lastError = "";

      // 编辑发布记录（editor/bundles.jsonl）：每次素材包交付留档（条目数/来源可追溯）
      try {
        appendEditorBundle(tDir, {
          turn: (baseCycle.turnCount ?? 0) + 1,
          query,
          level,
          strategy,
          entryCount: hits.length,
          chars: payload.length,
          timeline: !!timelinePart,
          advocate: !!advocatePart,
        });
      } catch {
        /* best-effort */
      }

      // 校准(Calibrate)：书记回写循环状态 + 缺口
      try {
        let cyc = recordTurn(readCycle(tDir), judge);
        if (!hits.length && candidateDocs.length > 0) {
          cyc = recordGap(cyc, { query, hitText });
          appendGapFile(tDir, { query, at: new Date().toISOString() });
        }
        writeCycle(tDir, cyc);
      } catch (err) {
        console.warn(`[linghun-assembler] 书记回写失败（不影响注入）: ${err?.message ?? err}`);
      }

      // 记录本次交付，供下一轮「被判定」反馈采集
      lastDelivery = { text: payload, at: Date.now() };
    } catch (err) {
      lastError = String(err?.message ?? err);
      console.warn(`[linghun-assembler] 认知循环失败（保留上次素材包）: ${lastError}`);
      // fallbackKeepLast：不覆盖上次成功素材包（保持 linghun 侧可用）
    }
  };

  ctx.on("session/event", (session, event) => {
    probe("session-event", { type: event?.type });
    if (event?.type !== "request/header") return;
    if (event.data?.header?.config) {
      lastModel = {
        provider: event.data.header.config.provider ?? "",
        model: event.data.header.config.model ?? "",
      };
      probe("request-header", { provider: lastModel.provider, model: lastModel.model });
    }
    // 触发时机：request/header 晚于 turn/start、user/message 到达，此刻
    // 本轮用户消息已写入日志、模型信息已就位——避免首轮空转与素材滞后一轮。
    if (!llmClient && !appCtx.llm) {
      pendingSession = session;
      probe("llm-deferred", {});
      return;
    }
    pendingSession = null;
    void runCognitiveCycle(session);
  });

  // 只读辅助不导出（对外最小面）；错误信息经 console 输出（DSH 侧日志可见）
  ctx.on("ready", () => {
    probe("ready");
    console.info(`[linghun-assembler] 素材包输出路径：${outPath()}（与 linghun memory.assembler.injectPath 同值联动）`);
    console.info(`[linghun-assembler] 认知循环团队工作区：${teamDir(cfg().team?.cycleDir)}（cycle.json + gaps.md + 各角色领域）`);
  });
}

function readWarmSafe(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function writeFileSafe(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, "utf8");
}

export { Config, NS, apply, inject, name, guessCategory, collectLastUserQuery, decideRetrieval };
