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
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import z from "@deepseek-ai/schemastery";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import { parseWarm, renderWarmEntries } from "./warm.js";
import { BM25, retrievalParams } from "./bm25.js";
import { assembleWithLlm } from "./assemble.js";

const name = "linghun-assembler";
const inject = ["llm"];
const NS = "linghun-assembler";

const DEFAULT_WARM = join("linghun", "memory", "warm.md");

const Config = z.object({
  enabled: z.boolean().default(true),
  /** warm 记忆库路径；留空用 $DSH_HOME/linghun/memory/warm.md。 */
  warm: z.object({
    path: z.string().default(""),
  }).default({}),
  retrieval: z.object({
    /** 未命中题型分流策略时的默认 top-k。 */
    topK: z.number().default(12),
    /** 题型分流开关：knowledge_update 时间保底 / summarization 广覆盖。 */
    strategy: z.boolean().default(true),
  }).default({}),
  assemble: z.object({
    temperature: z.number().default(0.2),
    maxTokens: z.number().default(1200),
  }).default({}),
  /** 素材包输出：写入 linghun 的注入通道路径（配 linghun memory.assembler.injectPath 同值）。 */
  output: z.object({
    injectPath: z.string().default(""),
    label: z.string().default("以下记忆素材由提取子智能体按当前问题从记忆库组装（仅保留相关条目，细节原样）"),
  }).default({}),
  /** 同会话防抖：距上次组装不足该毫秒数则跳过（避免连续追问高频触发）。 */
  debounceMs: z.number().default(5000),
  /** LLM/检索失败时保留上次素材包（不覆盖、不阻断对话）。 */
  fallbackKeepLast: z.boolean().default(true),
}).default({});

/** 从事件流收集最近一条真实用户消息（跳过运行时上下文注入）。 */
function collectLastUserQuery(session) {
  const events = session.log ?? session.events ?? [];
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev?.type !== "user/message") continue;
    const src = ev.data?.source;
    if (src?.kind === "runtime-context" || src?.kind === "model") continue;
    const blocks = ev.data?.content ?? [];
    const text = blocks
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text)
      .join("\n")
      .trim();
    if (text) return text;
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

  let llmClient = null;
  ctx.inject(["llm"], (sctx) => {
    llmClient = sctx.llm;
    return () => {
      llmClient = null;
    };
  });

  let lastModel = { provider: "", model: "" };
  let lastAssembleAt = 0;
  let lastError = "";

  const warmPath = () => {
    const p = (cfg().warm?.path ?? "").trim();
    return p ? p : join(resolveDshHome(), DEFAULT_WARM);
  };
  const outPath = () => (cfg().output?.injectPath ?? "").trim();

  const runAssemble = async (session) => {
    const c = cfg();
    if (c.enabled === false) return;
    if (!llmClient) return;
    if (!lastModel.provider || !lastModel.model) return;
    const out = outPath();
    if (!out) return;

    // 防抖：同一会话短时间内不重复组装
    const now = Date.now();
    if (now - lastAssembleAt < (c.debounceMs ?? 5000)) return;
    lastAssembleAt = now;

    const query = collectLastUserQuery(session);
    if (!query) return;

    const warmText = readWarmSafe(warmPath());
    if (!warmText) return;

    try {
      const entries = parseWarm(warmText);
      const docs = entries.map((e) => e.block);
      const bm25 = new BM25(docs);
      const cat = guessCategory(query);
      const strat = c.retrieval?.strategy === false ? { k: c.retrieval?.topK ?? 12, recentSafe: 0 } : retrievalParams(cat, { k: c.retrieval?.topK ?? 12 });
      const idxs = bm25.top(query, strat.k, strat.recentSafe);
      const hits = idxs.map((i) => entries[i]);
      const hitText = renderWarmEntries(hits);

      const outText = await assembleWithLlm(llmClient, lastModel, cat, query, hitText, {
        temperature: c.assemble?.temperature ?? 0.2,
        maxTokens: c.assemble?.maxTokens ?? 1200,
      });

      // 写素材包：带 label 头部（与 linghun renderMemory 的注入格式一致）
      const label = (c.output?.label ?? "").trim();
      const payload = label ? `> ${label}\n\n${outText}\n` : `${outText}\n`;
      writeFileSafe(out, payload);
      lastError = "";
    } catch (err) {
      lastError = String(err?.message ?? err);
      console.warn(`[linghun-assembler] 组装失败（保留上次素材包）: ${lastError}`);
      // fallbackKeepLast：不覆盖上次成功素材包（保持 linghun 侧可用）
    }
  };

  ctx.on("session/event", (session, event) => {
    if (event?.type === "request/header" && event.data?.header?.config) {
      lastModel = {
        provider: event.data.header.config.provider ?? "",
        model: event.data.header.config.model ?? "",
      };
    }
    if (event?.type !== "turn/start") return;
    void runAssemble(session);
  });

  // 只读辅助不导出（对外最小面）；错误信息经 console 输出（DSH 侧日志可见）
  ctx.on("ready", () => {
    const out = outPath();
    if (!out) {
      console.warn("[linghun-assembler] output.injectPath 未配置：素材包不会写入，请在 linghun 的 memory.assembler.injectPath 填同值。");
    }
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

export { Config, NS, apply, inject, name, guessCategory, collectLastUserQuery };
