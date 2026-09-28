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
    applyAssembler(ctx, AssemblerConfig({ output: { injectPath: asmFile } }));
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
    assert.ok(payload.includes("提取子智能体"), "素材包应带组装 label");

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
