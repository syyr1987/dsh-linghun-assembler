/**
 * 插件联动实测：mock DSH 运行时，把 dsh-linghun + dsh-linghun-assembler
 * 真实接起来，验证整条链路：
 *
 *   turn/start（带用户消息）→ assembler BM25 检索 + LLM 组装 → 写素材包
 *   → linghun soul:memory 渲染时注入素材包（替代 warm 原文纪律）
 *
 * 不 mock 插件内部逻辑，只 mock DSH 宿主接口（ctx.section/inject/effect/on）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply as applyLinghun, Config as LinghunConfig } from "../../linghun-plugin/index.js";
import { apply as applyAssembler, Config as AssemblerConfig } from "../index.js";

const WARM = [
  "## 2026-09-27 10:00 [fact] high\n\nsprint 1 截止 2026-03-29，transaction module 已交付。\n<!-- last_access: 2026-09-27 10:00 -->",
  "## 2026-09-28 09:00 [fact] high\n\n主分支已合并 165 个 commit，合并耗时 250ms。\n<!-- last_access: 2026-09-28 09:00 -->",
  "## 2026-09-28 11:00 [decision] medium\n\n用户偏好短句直接的回答。\n<!-- last_access: 2026-09-28 11:00 -->",
  "## 2026-09-28 12:00 [fact] medium\n\nOpenWeather API key 已配置，天气应用支持城市搜索。\n<!-- last_access: 2026-09-28 12:00 -->",
].join("\n\n") + "\n";

/** 构造 mock DSH 宿主：两个插件共用同一个 ctx，事件按注册顺序分发。 */
function makeHarness(llmStreamImpl) {
  const sections = [];
  const tools = [];
  const listeners = {};
  const sctx = {
    settings: {
      register: (ns, schema, entry) => {
        let val = entry.base;
        const watchers = [];
        return {
          get: () => val,
          watch: (cb) => {
            watchers.push(cb);
            return () => {};
          },
          set: (v) => {
            val = v;
            for (const w of watchers) w();
          },
        };
      },
    },
    effect: (cb) => cb(),
    llm: { async *stream() {} },
  };
  if (llmStreamImpl) sctx.llm = { stream: llmStreamImpl };
  const ctx = {
    systemPrompt: {
      section: (s) => {
        sections.push(s);
        return () => {};
      },
    },
    tools: { register: (d) => tools.push(d) },
    inject: (deps, cb) => {
      if (deps.includes("llm")) return cb({ ...sctx });
      if (deps.includes("settings")) return cb(sctx);
      return () => {};
    },
    effect: (cb) => cb(),
    on: (ev, cb) => {
      listeners[ev] = [...(listeners[ev] ?? []), cb];
    },
  };
  return { sections, tools, listeners, ctx };
}

function fire(listeners, eventName, session, event) {
  for (const cb of listeners[eventName] ?? []) cb(session, event);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function setupHome() {
  const home = mkdtempSync(join(tmpdir(), "linghun-link-"));
  const memDir = join(home, ".dsh", "linghun", "memory"); // resolveDshHome() = $HOME/.dsh
  mkdirSync(memDir, { recursive: true });
  writeFileSync(join(memDir, "warm.md"), WARM, "utf8");
  const oldHome = process.env.HOME;
  const oldDsh = process.env.DSH_HOME;
  process.env.HOME = home;
  delete process.env.DSH_HOME; // 让 dsh-home-paths 走 HOME
  return () => {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    if (oldDsh === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = oldDsh;
  };
}

test("联动: turn/start → 组装素材包 → linghun 注入（替代 warm 原文纪律）", async () => {
  const restore = setupHome();
  const asmFile = join(tmpdir(), `linghun-link-asm-${Date.now()}.md`);
  const streamImpl = async function* () {
    yield { type: "text-delta", text: "素材：主分支已合并 165 个 commit（合并耗时 250ms），sprint 1 已交付 transaction module。用户偏好短句直接。" };
  };

  try {
    const { sections, listeners, ctx } = makeHarness(streamImpl);
    // 挂载顺序：assembler 先（触发写文件），linghun 后（渲染读文件）
    applyAssembler(ctx, AssemblerConfig({ retrieval: { mode: "always" }, output: { injectPath: asmFile } }));
    applyLinghun(ctx, LinghunConfig({ memory: { assembler: { injectPath: asmFile } } }));

    // 1) request/header：记录 provider/model
    const session = {
      log: [
        { type: "user/message", data: { content: [{ type: "text", text: "项目现在的状态怎么样？" }] } },
      ],
    };
    fire(listeners, "session/event", session, {
      type: "request/header",
      data: { header: { config: { provider: "deepseek", model: "deepseek-chat" } } },
    });

    // 2) turn/start：assembler 触发组装
    fire(listeners, "session/event", session, { type: "turn/start", seq: 1 });

    // 等待异步组装完成（LLM stream 是异步的）
    await sleep(100);

    // 3) 断言素材包已写入
    assert.ok(existsSync(asmFile), "素材包文件应已写入");
    const payload = readFileSync(asmFile, "utf8");
    assert.ok(payload.includes("165 个 commit"), "素材包应含检索命中的最新事实");
    assert.ok(payload.includes("认知循环团队"), "素材包应带组装 label");

    // 4) linghun soul:memory 渲染应注入素材包
    const mem = sections.find((s) => s.name === "soul:memory");
    assert.ok(mem, "linghun 应注册 soul:memory section");
    const out = mem.text();
    assert.ok(out.includes("165 个 commit"), "linghun 注入应包含组装素材包内容");
    assert.ok(!out.includes("引用存疑记忆必须先声明不确定"), "组装模式不注入 warm 原文纪律");
  } finally {
    restore();
  }
});

test("联动: LLM 失败时保留上次素材包（降级不阻断）", async () => {
  const restore = setupHome();
  const asmFile = join(tmpdir(), `linghun-link-fail-${Date.now()}.md`);
  writeFileSync(asmFile, "> 上次成功素材\n\nfact：上一轮组装结果。\n", "utf8");
  const failStream = async function* () {
    throw new Error("llm transport down");
  };

  try {
    const { listeners, ctx } = makeHarness(failStream);
    applyAssembler(ctx, AssemblerConfig({ output: { injectPath: asmFile } }));
    applyLinghun(ctx, LinghunConfig({ memory: { assembler: { injectPath: asmFile } } }));

    const session = {
      log: [{ type: "user/message", data: { content: [{ type: "text", text: "现在怎么样了？" }] } }],
    };
    fire(listeners, "session/event", session, {
      type: "request/header",
      data: { header: { config: { provider: "deepseek", model: "deepseek-chat" } } },
    });
    fire(listeners, "session/event", session, { type: "turn/start", seq: 1 });
    await sleep(100);

    const payload = readFileSync(asmFile, "utf8");
    assert.ok(payload.includes("上次成功素材"), "LLM 失败应保留上次素材包（不覆盖）");
  } finally {
    restore();
  }
});

test("联动: deep 查询触发史官时序素材 + 循环状态落盘", async () => {
  const restore = setupHome();
  const asmFile = join(tmpdir(), `linghun-link-deep-${Date.now()}.md`);
  const calls = [];
  const streamImpl = async function* (opts) {
    calls.push(opts.system ?? "");
    const sys = opts.system ?? "";
    if (sys.includes("史官")) {
      yield { type: "text-delta", text: JSON.stringify({ finding: "来龙去脉：项目从 2026-03 启动，先建 warm 记忆，后拆 assembler。" }) };
    } else {
      yield { type: "text-delta", text: "素材：项目来龙去脉已梳理，含时序脉络。" };
    }
  };

  try {
    const { sections, listeners, ctx } = makeHarness(streamImpl);
    applyAssembler(ctx, AssemblerConfig({ output: { injectPath: asmFile } }));
    applyLinghun(ctx, LinghunConfig({ memory: { assembler: { injectPath: asmFile } } }));

    const session = {
      log: [{ type: "user/message", data: { content: [{ type: "text", text: "这个项目的来龙去脉是什么？" }] } }],
    };
    fire(listeners, "session/event", session, {
      type: "request/header",
      data: { header: { config: { provider: "deepseek", model: "deepseek-chat" } } },
    });
    fire(listeners, "session/event", session, { type: "turn/start", seq: 1 });
    await sleep(100);

    const payload = readFileSync(asmFile, "utf8");
    assert.ok(payload.includes("来龙去脉"), "素材包应含史官梳理结果");

    // 循环状态落盘：$HOME/.dsh/linghun/memory/team/cycle.json（海马体 memory 区内）
    const cycleFile = join(process.env.HOME, ".dsh", "linghun", "memory", "team", "cycle.json");
    assert.ok(existsSync(cycleFile), "cycle.json 应已写入");
    const cycle = JSON.parse(readFileSync(cycleFile, "utf8"));
    assert.equal(cycle.turnCount, 1);
    assert.equal(cycle.judgeStats.deep, 1, "deep 判官统计应落盘");
    assert.equal(cycle.judgeStats.strategy.timeline, 1);
  } finally {
    restore();
  }
});

test("联动: deep 相同主题二次触发命中史官缓存（免重复梳理）", async () => {
  const restore = setupHome();
  const asmFile = join(tmpdir(), `linghun-link-cache-${Date.now()}.md`);
  const calls = [];
  const editorInputs = [];
  const streamImpl = async function* (opts) {
    const sys = opts.system ?? "";
    const userText = opts.messages?.[0]?.content?.map((b) => b.text ?? "").join("\n") ?? "";
    if (sys.includes("史官")) {
      calls.push("archivist");
      yield { type: "text-delta", text: JSON.stringify({ finding: "来龙去脉：项目从 2026-03 启动。" }) };
    } else {
      calls.push("editor");
      editorInputs.push(userText);
      yield { type: "text-delta", text: "素材：梳理结果。" };
    }
  };

  try {
    const { listeners, ctx } = makeHarness(streamImpl);
    applyAssembler(ctx, AssemblerConfig({ debounceMs: 0, output: { injectPath: asmFile } }));
    applyLinghun(ctx, LinghunConfig({ memory: { assembler: { injectPath: asmFile } } }));

    const session = {
      log: [{ type: "user/message", data: { content: [{ type: "text", text: "这个项目的来龙去脉是什么？" }] } }],
    };
    const header = { type: "request/header", data: { header: { config: { provider: "deepseek", model: "deepseek-chat" } } } };
    fire(listeners, "session/event", session, header);
    fire(listeners, "session/event", session, { type: "turn/start", seq: 1 });
    await sleep(100);
    const archivistAfterFirst = calls.filter((x) => x === "archivist").length;
    assert.equal(archivistAfterFirst, 1, "首次应调史官 LLM 梳理");

    // 第二次相同主题（debounceMs=0 不禁防抖）；触发语义：request/header（turn/start 不触发组装）
    fire(listeners, "session/event", session, header);
    await sleep(100);
    assert.equal(calls.filter((x) => x === "archivist").length, archivistAfterFirst, "二次应命中史官缓存，免重复 LLM");
    assert.equal(editorInputs.length, 2, "编辑应跑两轮");
    assert.ok(editorInputs[1].includes("缓存复用"), "第二次编辑输入应含缓存复用标注（免重梳）");
  } finally {
    restore();
  }
});

test("联动: auto 模式小体量直通（免检索层，全量交 LLM）", async () => {
  const restore = setupHome();
  const asmFile = join(tmpdir(), `linghun-link-auto-${Date.now()}.md`);
  // stream 收到什么就原样带出——用来断言直通路径把全量条目送给了 LLM
  let receivedHitText = "";
  const streamImpl = async function* () {
    // 从 messages[0].content 拿用户消息（含候选条目）
    receivedHitText = lastUserContent ?? "";
    yield { type: "text-delta", text: "素材：直通产物" };
  };
  let lastUserContent = "";
  const captureStream = async function* (opts) {
    const msg = opts.messages?.[0]?.content ?? [];
    lastUserContent = msg.map((b) => b.text ?? "").join("\n");
    yield { type: "text-delta", text: "素材：直通产物" };
  };

  try {
    const { sections, listeners, ctx } = makeHarness(captureStream);
    // 默认 mode=auto，warm 只有 4 条（<= 24）→ 走直通
    applyAssembler(ctx, AssemblerConfig({ output: { injectPath: asmFile } }));
    applyLinghun(ctx, LinghunConfig({ memory: { assembler: { injectPath: asmFile } } }));

    const session = {
      log: [{ type: "user/message", data: { content: [{ type: "text", text: "项目现在的状态怎么样？" }] } }],
    };
    fire(listeners, "session/event", session, {
      type: "request/header",
      data: { header: { config: { provider: "deepseek", model: "deepseek-chat" } } },
    });
    fire(listeners, "session/event", session, { type: "turn/start", seq: 1 });
    await sleep(100);

    const payload = readFileSync(asmFile, "utf8");
    assert.ok(payload.includes("直通产物"), "素材包应已写入");
    // 直通路径：LLM 收到的是全量条目（含与 query 无关的 OpenWeather 条目），而非 BM25 过滤结果
    assert.ok(lastUserContent.includes("OpenWeather"), "直通应把全部 warm 条目交给 LLM（不检索过滤）");
    assert.ok(lastUserContent.includes("sprint 1"), "直通应含全部条目");
  } finally {
    restore();
  }
});
