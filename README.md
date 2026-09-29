# dsh-linghun-assembler

灵魂插件（`dsh-linghun`）的**提取侧子智能体**组装层。按当前用户问题从暖态记忆库（warm.md）做 BM25 检索，调会话 LLM 组装「有用素材包」，经 linghun 注入通道替代 warm 原文注入。

> 组合形态：`dsh-linghun`（注入通道 + 记忆布局） + `dsh-linghun-assembler`（提取 + 组装）。linghun 保持零 LLM 调用、零改动面；本插件独立版本迭代、独立启停。

## 为什么需要组装层

warm 记忆原文注入有两个已知缺陷（BEAM/100K 交叉验证实证）：

1. **长度失控**：warm 条目多、长，全文注入挤占 prompt；BM25 检索又因长文档惩罚漏掉最新关键事实。
2. **与问题脱节**：原文注入不按当前问题聚焦，相关细节淹没在无关条目里。

组装层把「检索 → 组装」机制化：每次用户消息开始时按 query 检索命中条目，LLM 压缩成「有用素材包」再注入，回答者拿到的是**相关、紧凑、细节原样**的素材。

## 工作机制

```
用户消息 → turn/start
  → collectLastUserQuery（跳过运行时上下文注入）
  → 检索 warm（默认 auto 自适应：条目 ≤24 直通全量免 BM25；大体量才走 BM25 + 题型分流）
  → 会话 LLM 组装（复用 DSH llm 通道，无自配 key）
  → 写素材包 → linghun memory.assembler.injectPath 注入
```

- **题型分流（STRATEGY）**：`knowledge_update` 加时间保底（BM25 top-12 + 最近 6 条强制并入，防长文档惩罚漏最新数值）；`summarization` 广覆盖（top-24，泛化 query 命中分散）；其他纯 BM25（top-12）。
- **摘要双轨 prompt**：`summarization` 类强制保留「事实线 + 建议线」（实际做过的功能/决策 + 模块化/验证/配置建议），防组装 LLM 压缩时裁掉建议要点。
- **LLM 通道**：`ctx.inject(["llm"])` 复用会话 llmClient，provider/model 从 `request/header` 事件取（与 linghun 收尾评估同一模式）。
- **降级**：LLM/检索失败默认保留上次素材包，不覆盖、不阻断对话。
- **防抖**：同会话 5s 内不重复组装。

## 安装与配置

**必须用 DSH 插件方式安装**（声明了 `dsh.bundle`，`dsh plugin add` 才会挂载为 profile layer；裸 `npm i` 只装依赖不挂载）：

```bash
# 以 web profile 为例（其他 profile 同理）
dsh plugin --profile web add dsh-linghun-assembler
```

**零配置联动**：默认素材包路径为 `$DSH_HOME/linghun/memory/assembled.md`，与 `dsh-linghun` 的 `memory.assembler.injectPath` 默认约定值同值——装完即可工作，无需配置。

需要自定义路径时（两侧必须填**同一个**路径）：

```yaml
# linghun 配置
memory:
  assembler:
    injectPath: /path/to/assembled.md   # 素材包写入/读取路径
```

```yaml
# linghun-assembler 配置
enabled: true
warm:
  path: ""            # 默认 $DSH_HOME/linghun/memory/warm.md
output:
  injectPath: /path/to/assembled.md    # 与 linghun memory.assembler.injectPath 同值
  label: 以下记忆素材由提取子智能体按当前问题从记忆库组装（仅保留相关条目，细节原样）
retrieval:
  mode: auto          # auto=按体量自适应；always=强制 BM25；never=强制直通
  autoThreshold: 24   # auto 模式下 warm 条目数 ≤ 此值走直通（全量交 LLM，免检索层）
  maxDirectChars: 8000  # 直通时素材文本上限，超出截断并标注
  topK: 12
  strategy: true
assemble:
  temperature: 0.2
  maxTokens: 1200
debounceMs: 5000
fallbackKeepLast: true
```

> **双重挂载提醒**：若此前用 `cordis.patch.yml` 手工 `insert` 过本插件（旧方式），升级到声明 `dsh.bundle` 的版本后请**删除手工 insert 条目**，否则会挂载两次（每轮组装跑两遍）。


## 评测依据

BEAM/100K 交叉验证（100K_1 + 100K_2 两集，各 20 题）：

| 版本 | 检索策略 | 100K_1 严格/加权 | 100K_2 严格/加权 |
|---|---|---|---|
| v1 基线 | 纯 BM25 top-12 | 65 / 75 | — |
| v2 时间保底 | 无差别并入最近 6 条 | 55 / 70 | — |
| v3 题型分流 | knowledge 保底 / summary 广覆盖 | 50 / 67.5 | 50 / 60 |
| **v4 摘要双轨** | 分流 + 双轨 prompt | — | **70 / 77.5** |

跨集稳定信号：`instruction_following` 好（2/2）、`summarization` 差（0/2 → 双轨修复后 1/2，题 18 满分）。单轮 20 题噪声 ±10%，同集反复调参在拟合噪声——跨集一致的好坏才是真能力。

## 开发

```bash
npm test          # 16 项：warm 解析 / BM25 / 题型分流 / 双轨 prompt / 插件入口 / 自适应直通 / 联动实测
```

## 路线

- v0.1.x：运行时组装（当前，插件组合形态）
- v0.2.x：组装策略在线调参、素材包质量自评
- v0.3.0：`memory_search` 工具形态——插件内置运行时检索，免组装、免注入通道

评测链路（离线 assemble.py + BEAM/100K）见 `linghun-assembler/`，与本插件解耦、永久保留。

## License

MIT
