# dsh-linghun-assembler

灵魂的记忆提取侧·**认知循环团队版**：每次用户消息触发「判断 → 捞取 → 组装 → 被判定 → 校准」五步闭环，由角色化子智能体（判官/捞手/史官/辩手/编辑/书记）承载；按当前问题 BM25 检索 + 时序素材 + LLM 组装「有用素材包」，经 linghun 注入通道注入——**记忆按需供给，不再全文倾倒**。

> 组合形态：`dsh-linghun`（注入通道 + 记忆布局） + `dsh-linghun-assembler`（认知循环 + 提取 + 组装）。linghun 保持零 LLM 调用、零改动面；本插件独立版本迭代、独立启停。

## 认知循环团队

把「提取侧子智能体」升级为 A2A 式记忆团队。DSH 现成的地基（子智能体委派/Agent 句柄/工作区/可视化轨迹）全部拿来用，认知循环语义层自己做——每个角色 = 独立 LLM 调用 + 角色 prompt + 结构化输出，复用会话 llmClient（无自配 key），**不依赖 DSH 实验性 agent-team**。

```
用户消息 → turn/start
  → 反馈采集（上一轮素材包是否被本轮问题命中 → 校准信号）
  → 判官（Judge）：问题分级 light/medium/deep，决定捞取策略
  → 捞取（Act）：BM25 + 题型分流；deep 追加时序素材
  → 组装（Compose）：编辑角色压缩成「有用素材包」
  → 被判定（Feedback）：下轮 query 与素材包关键词重叠度判定命中
  → 校准（Calibrate）：书记回写循环状态 cycle.json + 缺口 gaps.md
```

### 角色分工

| 角色 | 职责 | 预算纪律 |
|---|---|---|
| **判官 Judge** | 问题分级（light/medium/deep）+ 策略选择 | 默认代码启发式（零 LLM）；`judge.llm=true` 才调 LLM |
| **捞手 Retriever** | 保留问题相关事实 + 标注相关推测（语义捞取，不词面匹配） | light 直通 / medium BM25 / deep BM25+时序；事实与推测分离标注 |
| **筛选员 Screener** | Jev 式判断层：先结构化分类（相关/事实推测/置信度）再渲染素材，过滤不相关 + 低置信按推测（宁缺毋滥） | 默认代码启发式（零 LLM）；`screen.llm=true` 才调 LLM；默认关 `screen.enabled=false` |
| **史官 Archivist** | deep 时读时序素材（warm 遗忘梯度 + episodic 归档 + journal 流水）梳来龙去脉 | 仅 deep 调用 LLM；失败跳过不阻断 |
| **辩手 Advocate** | deep 时查矛盾/不一致 | 默认关（`advocate.enabled=true` 开启） |
| **编辑 Editor** | 压缩成有用素材包（带循环上下文） | 每轮必调（复用 assemble.js 双轨 prompt） |
| **书记 Scribe** | 循环状态落盘 + 缺口回写 | 纯代码零 LLM |

### 领域模型（子智能体有领域，主智能体共享）

每个子智能体管理一块领域，全部长在海马体 memory/ 内——领域有主权，但不搞信息孤岛：

```
$DSH_HOME/linghun/memory/team/     # 团队工作区（与 warm/cold/episodic/journal/assembled 并列）
├── cycle.json                     # 共享认知台账（书记）：回合/判定统计/反馈
├── gaps.md                        # 共享缺口登记（书记）：检索未命中
├── judge/                         # 判官领域
├── archivist/timelines/           # 史官领域：时序梳理缓存（同 topic 复用免重梳）
├── advocate/                      # 辩手领域
└── editor/                        # 编辑领域
```

- **史官缓存复用**：deep 梳理过的 topic 落 `archivist/timelines/index.json`（带日期）；同主题且 7 天内新鲜直接复用，标注「史官·缓存复用」，不重复烧 LLM。
- **判官履历**：每次判定决策落 `judge/history.jsonl`（回合/分级/策略/依据，最多 200 条），可复盘「分级-反馈」对应关系。
- **编辑发布记录**：每次素材包交付落 `editor/bundles.jsonl`（条目数/来源标记/字符量），可追溯每轮注入了什么。
- **主智能体共享**：linghun 的 memory_read 输出「团队认知台账」段——回合数、判官分级、反馈命中/未命中、缺口清单、史官已梳理 topic、判官最近分级、编辑最近交付。主智能体看海马体时能看到自己的认知循环状态，据此补记忆（缺口 → memory_append → 下轮命中）。
- **缺口闭环**：gaps.md 暴露给主智能体后，检索未命中的 query 可被人工/主智能体补进 warm，形成「缺口驱动补记忆」闭环。

### 循环状态（团队工作区）

`$DSH_HOME/linghun/memory/team/` 下由书记维护：

- **cycle.json**：回合数、判官分级统计、反馈命中/未命中、缺口列表（原子写，损坏自动回落空状态）
- **gaps.md**：检索未命中的用户 query 回写，供下次/人工补记忆

ready 启动时会打印团队工作区路径。

## 为什么需要组装层

warm 记忆原文注入有两个已知缺陷（BEAM/100K 交叉验证实证）：

1. **长度失控**：warm 条目多、长，全文注入挤占 prompt；BM25 检索又因长文档惩罚漏掉最新关键事实。
2. **与问题脱节**：原文注入不按当前问题聚焦，相关细节淹没在无关条目里。

组装层把「检索 → 组装」机制化：每次用户消息开始时按 query 检索命中条目，LLM 压缩成「有用素材包」再注入，回答者拿到的是**相关、紧凑、细节原样**的素材。

### 子智能体定位与查证边界（v0.3.0）

- **收口者架构**：子智能体（编辑/史官等）是主智能体的记忆提取侧，运行在主智能体认知架构内；负责输入侧素材供给，不替主智能体做最终判断与回答。
- **HHH 输入输出解耦**：主智能体输出侧 HHH=诚实>友善>有用（管「怎么说真话」）；子智能体输入侧=素材给足（诚实约束的是「不编造事实」，不约束展开度）。
- **候选未命中标注（第6条）**：候选条目中无直接相关数据时，如实标注「候选条目中未检索到该数据」，不编造；但这是**输入侧检索事实，不是记忆库的最终裁决**——主智能体是收口者，由它决定是否进一步查证（配合 dsh-linghun v0.3.0 的未命中查证纪律）。
- **自定义工作区/领域库接入（v0.3.2）**：配置 `retrieval.workspaceDirs` 后，递归扫描这些目录下的 `.md` 文件作为 warm 之外的额外候选源，参与 BM25 检索与「候选未命中」判定；命中块带 `【工作区·文件名】` 来源标记。领域本体知识不再游离于记忆闭环之外。

## 工作机制

```
用户消息 → turn/start
  → collectLastUserQuery（跳过运行时上下文注入）
  → 反馈采集：上轮素材包与 query 关键词重叠度 ≥0.25 且命中显著词 → 命中（校准信号）
  → 判官：问题分级（代码启发式或 LLM）→ 捞取策略
  → 捞取：light 直通 / medium BM25+题型分流 / deep BM25+题型分流+时序素材（史官）
  → 组装：编辑角色带循环上下文压缩「有用素材包」
  → 书记：recordTurn + 无命中缺口回写 gaps.md + 写 cycle.json
  → 写素材包 → linghun memory.assembler.injectPath 注入
```

- **判官分级**：`deep`（来龙去脉/矛盾/历史/演变/对比等）走最强捞取 + 时序；`medium`（总结/状态更新）走 BM25 广覆盖或时间保底；`light`（常规）直通。默认代码启发式零 LLM，`judge.llm=true` 才调 LLM（失败自动降级启发式）。
- **题型分流（STRATEGY）**：`knowledge_update` 加时间保底（BM25 top-12 + 最近 6 条强制并入，防长文档惩罚漏最新数值）；`summarization` 广覆盖（top-24，泛化 query 命中分散）；其他纯 BM25（top-12）；deep 追加 `max(18, topK)` 并强制史官时序素材。
- **摘要双轨 prompt**：`summarization` 类强制保留「事实线 + 建议线」（实际做过的功能/决策 + 模块化/验证/配置建议），防组装 LLM 压缩时裁掉建议要点。
- **LLM 通道**：`ctx.inject(["llm"])` 复用会话 llmClient，provider/model 从 `request/header` 事件取（与 linghun 收尾评估同一模式）；角色 LLM 调用统一 `callRoleLlm`（结构化输出 + JSON 提取）。
- **降级**：LLM/检索失败默认保留上次素材包，不覆盖、不阻断对话；史官/辩手失败直接跳过。
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
  label: 以下记忆素材由认知循环团队按当前问题从记忆库组装（仅保留相关条目，细节原样）
retrieval:
  mode: auto          # auto=按体量自适应；always=强制 BM25；never=强制直通
  autoThreshold: 24   # auto 模式下 warm 条目数 ≤ 此值走直通（全量交 LLM，免检索层）
  maxDirectChars: 8000  # 直通时素材文本上限，超出截断并标注
  topK: 12
  strategy: true
  workspaceDirs: []   # 自定义工作区/领域库目录（v0.3.2）：递归扫描其中 .md 作为 warm 之外的额外候选源
  screen:
    enabled: false     # 筛选员（Jev 式判断层）默认关；true 则命中条目先分类再渲染
    floor: 0.6         # 置信度闸门：低于此值的条目强制按推测标注（宁缺毋滥防漏）
    llm: false         # 默认代码启发式（零 LLM，Jev 式判别）；true 才走 LLM 结构化判断（相关/类型/置信度三题型）
assemble:
  temperature: 0.2
  maxTokens: 1200
debounceMs: 5000
fallbackKeepLast: true
team:
  cycleDir: ""        # 默认 $DSH_HOME/linghun/memory/team（cycle.json + gaps.md）
  judge:
    llm: false        # 判官默认代码启发式，零 LLM；true 才走 LLM 分级
  archivist:
    enabled: true
    topRecent: 8      # warm 最近访问 top N
    episodicTail: 6000   # 最近归档尾部字节
    journalDays: 3       # journal 最近 N 天
    journalTail: 4000    # 每天流水尾部字节
  advocate:
    enabled: false    # 辩手默认关
  feedback:
    enabled: true     # 反馈采集（下轮 query 与素材包重叠度判定命中）
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

AGPL-3.0
