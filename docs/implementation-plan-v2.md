# dsh-onebot-personality 实施计划 v2

> 文档日期：2026-11-04（Asia/Shanghai）  
> 状态：实施前设计基线；本轮仅生成计划文档，不代表源码、构建、测试或真实 QQ 联调已完成。  
> 目标：独立 TypeScript DSH bundle；OneBot v11 正向 WebSocket；多人格；五阶段独立聊天模型；参考 Hindsight 的人格长期记忆。  
> 本版重点：权限贯穿检索、派生、缓存与发送；bank 并发、遗忘及跨存储恢复状态机；在线发送和 retain 分别持久化。

## 1. 目标、范围与不做事项

### 1.1 已确定的产品行为

1. 在当前工作区创建独立插件 `dsh-onebot-personality`，不修改 DSH 或其他插件源码。
2. 连接 OneBot v11 统一正向 WS 端点，收取群聊和私聊消息。
3. 插件配置多个人格，支持默认人格与群/私聊绑定；每个会话同时只有一个人格。
4. 允许群的全部正常入站消息可靠入队并后台 retain；只有明确 @ 机器人或普通文本提及当前人格名称/别名时才回复。
5. 私聊仅对允许列表中的用户正常回复和采集；两个允许列表默认均为空。
6. 每个“机器人账号＋人格稳定 ID”一个逻辑 bank，跨会话统一积累记忆，但读取必须遵守来源权限。
7. 五个聊天模型槽位：`router`、`recall`、`reflect`、`retain`、`reply`；支持人格级覆盖。
8. 首版复用 DSH 自动配置表单，不增加 HTTP 管理端点或复杂前端。
9. 默认交付源码、锁文件、中文文档、配置示例、测试及可安装预构建包，不自动安装当前 profile，不启用真实回复。

### 1.2 明确不承诺

- 不部署 Hindsight 服务，不依赖其 Python/数据库运行时，不宣称功能、算法或性能与原生 Hindsight 等价。
- 不创建拥有 shell、文件或任意工具权限的 Agent；只调用 `ctx.llm` 和固定服务适配器。
- 不下载、执行图片、语音、附件或消息中的 URL；首版以文本理解和非文本占位为主。
- 不承诺 OneBot 断线消息重放、网络发送 exactly-once 或两个存储间严格 exactly-once。
- 不把关闭 knowledge proactive 自动注入说成访问隔离；DSH 管理员、本机插件和底层存储仍处于可信边界。
- 不引入隐含的第六个聊天模型。embedding/rerank 由 dsh-knowledge 独立管理，不算五个聊天槽位。
- 不自动改变全局 knowledge 工具设置，不修改已有 AstrBot bridge 的行为。

## 2. Hindsight 参考依据与适配边界

### 2.1 已查阅的官方资料

本次查阅 GitHub 主仓库 README 及官方仓库内 retain、retrieval、reflect、observations、mental-models 文档正文。以下是架构参考，不是对其全部源码的审计。网页与 main 分支会变化，实施阶段应记录实际采用的提交版本。

| Hindsight 概念 | 官方资料说明 | 本插件的适配 |
|---|---|---|
| Banks | 按 bank 组织记忆，带身份背景和 disposition | 机器人＋人格稳定 ID 映射到 dsh-knowledge 库；插件补来源授权 |
| World / Experience | 按谁在说话、是否是 bank 的 agent 自身经历区分，不按第一人称语法分类 | QQ 用户自述是用户的 world 事实；成功发送的机器人发言可成为 experience |
| Retain | 提取事实、实体、关系、事件时间与获知时间 | 使用 retain 槽位；插件存结构化索引，knowledge 存正文 |
| Recall | 语义、关键词、图、时间路径融合，预算控制 | knowledge 提供可用语义/词法路径；插件补实体关系与事件时间；RRF 融合 |
| Observations | 原子化、有来源的综合认知，保留证据、冲突与演变 | 按来源范围合并，保留支持/反对证据，不以重复转述增加独立证据数 |
| Mental models | 对预设问题的持久答案，后台刷新、版本和新鲜度 | 稳定偏好、关系背景、未完成事项三类模板；统一由 retain 模型生成 |
| Reflect | 围绕证据有界分析，参考 mental models、observations、事实并验证引用 | 固定宿主循环，不授予 Agent 工具；最多三轮检索，输出摘要后单独调用 reply |
| Scope / Provenance | 来源范围和派生来源追踪 | 采用插件的保守来源闭包，不直接把标签或模型提示当作 ACL |

依据：[README][H1]、[Retain][H2]、[Recall][H3]、[Reflect][H4]、[Observations][H5]、[Mental Models][H6]。

### 2.2 有意不同于原生实现

- Hindsight 文档的 reflect 包含自主工具循环；这里替换成宿主控制的结构化请求和有限检索循环，不能执行任意工具。
- Hindsight mental models 可由 reflect 体系生成；这里遵循五槽位约定，后台提取、合并和模板刷新均使用 retain 模型，不调用 reflect/reply 替代。
- Hindsight 的实体解析支持名称相似度；这里 QQ 用户身份必须按 QQ ID，不因昵称相似、共同发言或模型判断合并。
- 不照搬“共享且无标签的 observation”来放宽访问；混合来源结果必须继承全部依赖。
- 官方现有 decision model、视觉槽位和 knowledge pages 等能力不纳入首版，不借此增加隐藏模型。
- 不复制官方召回预算、默认十轮 reflect 或 benchmark 成绩作为本插件指标；本插件预算和验收另行明确。
- 原始闲聊即使未提取事实仍保存为 raw evidence，并可在授权后检索；不等同于只检索提取后的事实。

## 3. 实施前兼容性核验门槛

用户前序材料称已核实本机 dsh-knowledge 0.5.2 公开服务。本轮没有重新检查本机实现，以下是实施前必须完成的只读核验，不能把服务名称视为已通过接口测试。

| 核验项 | 通过条件 | 不通过的处理 |
|---|---|---|
| DSH bundle / Host / Cordis | 确认 manifest、导出、配置 schema、注入和卸载规范 | 停在骨架适配，不修改宿主绕过 |
| `knowledge` | 建库、列库、列文档、读文档、加文档、删文档、搜索公开接口及分页完整性 | 必需能力缺失则报兼容性阻塞 |
| 候选前授权过滤 | `baseId` 与显式 docIds 限制在候选形成和外部 rerank 之前生效 | 禁用不安全路径；仅用授权文档构造词法路径，且标注降级；无安全路径则不启用 |
| 空 docIds | 测试空列表/省略的实际含义 | 插件统一空集合短路，永不靠底层默认语义 |
| 向量状态 | 能区分正文落库、embedding 成功/失败；确认失败后能否读到正文 | 不可观察时标记 unknown，不冒充 ready；建立可验证词法路径 |
| proactive | 新库能在含正文前关闭自动注入 | 无法安全配置则不开始导入；由管理员显式处理兼容性 |
| `storageDomain` | 持久性、原子写/事务、唯一性、CAS、迁移和关闭所有权 | 不允许内存模拟持久性；可在插件域内实现 WAL/串行提交，无法证明原子恢复则停止 |
| `llm` / 默认模型 | 实际路由解析、认证复用、reasoningEffort、token 上限、AbortSignal | 不支持的显式参数报错，不静默换供应商 |
| 重复导入对账 | 能分页枚举限定库文档并精确核对持久 marker | 不用语义 TopK 代替精确对账；缺失则阻止相关写入流程 |
| generic knowledge 工具 | 确认本机是否存在可排除此类库的公开设置 | 提供检查结果及管理员操作说明；没有则明确不能阻止其他可信工具访问 |

共享 DSH 包使用 peerDependencies，锁定并测试兼容范围，不把宿主核心打包进插件。不重复打开 knowledge 自己的数据库，不直接读写其内部表。

Windows 权限问题只在实际再次出现异常访问拒绝时按专用诊断规范处理；本计划不要求也不执行 ACL 修改或权限扩张。

## 4. 配置与五阶段模型

### 4.1 配置分组

- `onebot`：enabled（默认 false）、WS URL、secret token、预期机器人 QQ ID、鉴权方式、连接超时、心跳阈值、指数退避及抖动。
- `allow`：groupIds、privateUserIds，均默认空；QQ ID 统一作为十进制字符串处理，不用可能溢出的 JS number 做主键。
- `personalities`：稳定 ID、名称、触发别名、系统设定、风格、背景、disposition、可见性模式、五阶段模型覆盖。
- `bindings`：默认人格 ID、群 ID→人格 ID、私聊 QQ ID→人格 ID；绑定必须引用存在的人格。
- `models`：router / recall / reflect / retain / reply。
- `budgets`：入站上限、近期窗口、检索/证据预算、阶段时限、在线总时限、会话并行、retain 队列及任务重试、发送分段上限。
- `memory`：刷新阈值、防抖、新鲜度、缓存、源数据保留、清理批量与退避。
- `security`：成员验证有效期、共享模式确认、敏感信息脱敏、运行状态日志策略。

人格 ID 改变视为新身份，不自动迁移/合并；改名或改别名不改变 bank。绑定切换不移动历史消息：旧记忆仍属于入站快照中的人格，新请求不读取其他人格近期窗口。

### 4.2 槽位职责

| 槽位 | 职责 | 输出 |
|---|---|---|
| router | 判断事实查找或综合分析 | `mode: recall | reflect`，不输出工具权限 |
| recall | 检索规划、改写、实体/时间条件及检索后证据整理 | 查询计划、带 evidenceId 的要点和不确定性 |
| reflect | 基于已授权证据做有界综合，可提出信息缺口 | 摘要、证据 ID、冲突、不确定性；不直接发送 |
| retain | 提取、实体归一、关系、observation 合并、mental-model 刷新 | schema 校验的事实和派生记忆 |
| reply | 人格系统设定＋当前消息＋近期对话＋证据/摘要 | 最终待发送文本 |

所有阶段通过 `ctx.llm` 和现有认证调用。不得创建拥有工具的 Agent，不使用通用 knowledge 自动注入替代显式授权取证。

### 4.3 继承与快照

1. 路由优先级：人格阶段显式路由 → 全局阶段显式路由 → DSH 默认模型选择。
2. provider/model 是一个不可拆分的路由单元；只填一项视为配置错误。
3. UI/schema 明确显示 `inherit` 与 `explicit`；在可用的自动表单能力内展示说明，不假设存在自定义模型选择器。
4. token、timeout 等预算可逐项继承。reasoningEffort 必须在最终模型上校验；更换路由时不从其他模型继承一个可能不适用的 effort，未指定则采用所选模型默认。
5. 每条消息开始处理时解析具体五路路由，包含 DSH 默认的 provider/model，连同人格、配置版本和提示模板版本形成不可变快照。
6. 快照不保存密钥。重试仍以快照路由通过当时可用的宿主认证调用；认证撤销或模型移除则明确失败。
7. retain 后续合并/刷新沿用触发任务的 retain 路由。防抖任务按 bank＋scope＋template＋retain 配置指纹分区；不同路由不悄悄合并。补偿刷新继承最近有效触发记录的快照，无法取得则报告等待明确配置。
8. 所有 repair/retry 使用原阶段槽位。在线请求及其格式修复共享绝对截止时间和总调用预算，不因修复/重试重置；后台 retain 的每次持久重试可获得新的 attempt 截止时间，但沿用原路由，累计重试次数、调用量和任务成本不清零。每次 retain attempt 内的格式修复共享该阶段的剩余时间。

### 4.4 结构化输出与降级

- 使用 JSON 提示＋本地 schema 校验＋每次结构化调用最多一次格式修复；不假设通用 response_format 可用。
- evidenceId 必须属于本轮提供的授权集合；来源、作者、bank、权限不是模型能自由填写的字段。
- 引文可用原文区间/精确子串校验；无证据推断标记 inferred，不能作为已证实事实。
- router 失败：记录具体阶段错误，降级 recall。
- recall 规划失败：代码使用当前消息生成有界字面查询；不能扩张范围。recall 整理失败：保留已授权的原始证据。
- reflect 失败：保留本次已有 recall 证据交给 reply。
- retain 失败：持久重试/死信；不阻塞在线生成。
- reply 失败、超时或内容不完整：不发送半成品；不自动切换其他模型。
- 任何权限验证失败不是普通质量降级：取消或重新取证，禁止复用失效证据。

### 4.5 初始预算建议（可配置，非性能承诺）

| 参数 | 建议默认 |
|---|---|
| 在线不同会话并发 | 4；同会话 1 |
| retain 并发 | 2；同 bank 派生激活串行 |
| retain 最多重试 | 5 次，指初次失败后最多再试 5 次 |
| reflect 检索轮次 | 最多 3 轮，包含首次 recall |
| 在线 LLM 总调用数 | 最多 12 次，包含格式修复；给 reply 预留调用和时间 |
| 在线总时限 | 120 秒，包含排队及阶段执行；超时取消 |
| router / recall / reflect / retain / reply 单次时限 | 10 / 20 / 25 / 60 / 40 秒，并受父级剩余时限约束 |
| 五槽位输出 token 上限 | 256 / 1536 / 1536 / 2048 / 1536 |
| 近期对话 | 最多 20 条且总预算受限；不等待 retain |
| 入站 WS 事件 / 文本 / 消息段 | 256 KiB / 16 KiB UTF-8 / 256 段 |
| 召回候选 / 证据预算 | 合并最多 100 条候选；证据及元数据合计最多约 4096 tokens |
| 成员验证正缓存 | 最多 30 秒；发送前对实际依赖群强制重新查询 |
| mental-model 刷新 | 新增 10 条有效事实，或有新增时防抖 60 秒；设最大等待 5 分钟 |
| 发送分段 | 每段最多 1500 个 Unicode code points，最多 8 段，并受网关字节上限约束 |

预算在实施中按模型能力和网关上限校验；不支持输出上限或取消能力时不能假称已强制执行。没有可靠 tokenizer 时使用保守估算和字符硬上限。不能容纳完整当前消息的模型不得通过截断当前消息冒充成功，须报输入预算错误。

在线与后台各用独立调度器和请求/token 限额；同一供应商路由保留在线容量，在线拥塞时暂停领取新 retain 工作，不能让后台洪峰耗尽在线预算。首版建议 pending/retry 消息上限 10000、收件箱正文配额 256 MiB、磁盘剩余预警 512 MiB（实际值配置化）；后台每次 attempt 建议最多 8 次聊天调用，含修复。队列、磁盘、累计成本和速率都在入队/调用前检查；缺少磁盘探测能力不能隐藏写入失败。

## 5. 总体架构与模块边界

```text
OneBot WS
  │ 身份校验 / 大小限制 / 规范化 / allowlist / 幂等
  ▼
Ingress transaction ── Message + Snapshot + RetainTask + 可选 ReplyJob
  │                              │
  │ 在线队列                     │ 后台队列
  ▼                              ▼
PolicyEngine                  RetainWorker
  │                              │ raw evidence / facts
router → recall → [reflect]      │ observations / mental models
  │             ↑ recall        ▼
reply                         BankCoordinator
  │                              │ append + reconcile + CAS
send gate → Outbox            KnowledgeAdapter + storageDomain
  │                              │
分段发送                         └─ Index / Provenance / Tombstones
  └─ confirmed experience task
```

计划模块：

```text
dsh-onebot-personality/
  package.json                    # bundle 声明、peer 依赖、scripts
  pnpm-lock.yaml
  tsconfig.json
  src/
    index.ts                      # Host 插件与 Cordis 生命周期
    config.ts                     # 配置、迁移、校验
    onebot/                       # WS、CQ/消息段、固定 API、分段
    llm/                          # 路由继承、快照、结构化调用和预算
    policy/                       # 范围、成员验证、来源闭包、发送屏障
    storage/                      # schema、事务、迁移、任务、outbox
    memory/                       # bank、retain、recall、reflect、派生、遗忘
    runtime/                      # 在线调度、恢复、运行状态
  tests/                          # mock、故障注入、矩阵、兼容性
  examples/                       # 无真实凭据的配置示例
  docs/                           # 中文配置、架构、安全与运维
  dist/                           # 预构建产物
```

这是拟建目录，不表示这些源码文件已经存在。内部模块名称不是对 DSH 现有 API 的断言。

## 6. OneBot 通信与入站流程

### 6.1 连接状态

`disabled → connecting → authenticating → ready → reconnecting → ready`；身份错误进入 `blocked`，卸载进入 `stopping → stopped`。

- 使用统一正向 WS 端点；token 优先以已验证支持的鉴权头传递，不把 token 打进 URL 或日志。
- 非本机连接优先要求 WSS；明文远程 WS 需要显式安全提示，不关闭 TLS 证书验证。
- 建连后查询 `get_login_info` 并核对预期机器人 QQ ID；事件 self_id 同样必须一致，不能用事件内容自动创建其他机器人 bank。
- 固定只读 API 可包括 `get_login_info`、`get_group_member_info`、必要的状态查询；真正发送消息的 API 只允许 `send_private_msg`、`send_group_msg`。
- 心跳结合网关 heartbeat 和连接活性检测；指数退避带抖动和最大间隔，成功稳定连接后重置。
- echo 采用唯一请求 ID＋连接代次；严格匹配 action 响应，检查 status、retcode 和必要字段；旧连接回包不能完成新请求。
- WS 恢复只恢复连接，不自动重放任何未确认发送。

### 6.2 规范化与触发

- 支持数组消息段和 CQ 字符串，按协议转义规则解析一次；禁止将解码后的普通文本重新当作 CQ 代码执行。
- 保留经敏感信息净化的结构化原始事件和规范化消息，而非包含认证环境的原始网络转储；插件 token、宿主模型凭据不得进入记忆、任务快照或普通日志。允许范围外事件不保存正文。用户自行发送的第三方秘密仅能按已知模式进行有界脱敏，不能宣称识别所有秘密；部署说明须提示勿在采集会话中发送凭据。
- 区分可触发的普通 text、reply/forward 引用、at 和非文本元数据。引用 ID 不主动回取全文，不用图片文件名、卡片 JSON、昵称元数据触发。
- at 仅当目标 QQ ID 等于已校验机器人账号时触发；`at all` 不视为 @ 本机器人。
- 普通文本对当前人格名称/别名执行确定性包含匹配；别名不能为空，并限制过短别名导致的误触发。
- 可识别的引用结构不参与触发；用户手工复制成普通文本的引文无法可靠区分，不宣称可语义识别所有引文，不为此调用 LLM。
- 忽略自身消息、系统/元事件作为对话、重复消息。系统成员变更通知可用于失效成员缓存，但不能替代实时身份验证。
- 幂等键：`botId + conversationType + conversationId + messageId`，持久唯一；相同键不同正文记录冲突，不覆盖原记录。缺少可稳定识别的 messageId 则拒绝并告警，不声称可靠幂等。
- 图片/语音/文件只保留类型及净化后的有限占位，禁止自动下载执行；匿名用户使用局部匿名标识，不能猜测为确定 QQ 用户。

### 6.3 可靠入队事务

1. 校验身份、允许列表、人格、事件大小和必需字段。
2. 解析人格与模型快照，生成服务端 sourceRef 与消息序号。
3. 一个本地原子提交保存：去重键、消息、快照、pending retain 任务；若触发回复，再保存 pending reply job。
4. 提交完成才允许在线生成；近期窗口从已提交消息读取，包含尚未完成 retain 的消息。
5. 未触发群消息只有 retain 路径，不调用 router、recall、reflect、reply。
6. 入站受队列容量、字节配额和磁盘健康约束。队列满或写失败时不回复、不继续采集，进入 degraded/paused 状态并报告缺口。

正向 WS 没有本插件业务 ACK，也没有可靠背压/重放保证。停止处理或断开连接不意味着消息会被上游保存。缺口分为已知丢弃数与不可确定的断线时间区间；磁盘满时告警本身可能无法持久化，须通过独立运行状态暴露。

## 7. 数据模型与持久记录

### 7.1 两个存储的职责

- dsh-knowledge：原始证据、world facts、experiences、observations、mental models 的可读正文；分块、向量、词法及可用 rerank 能力。
- 插件 storageDomain：事务性控制平面、索引元数据、来源、版本、任务、outbox、恢复和失败信息。允许保存入站原文作为可靠收件箱，但不能仅写插件库而宣称已存进 knowledge。
- 内存索引可从持久记录重建；正文缓存不是权威来源。不得修改 knowledge 内部表。

### 7.2 主要逻辑记录

| 记录 | 关键字段与约束 |
|---|---|
| SchemaMeta | schemaVersion、migration 状态、备份/恢复点 |
| Bank | bankKey(botId, personalityId) 唯一、baseId、provisionMarker、state、revision、generation、ownerFence |
| Source | botId、personalityId、会话类型/ID、sourceEpoch、allow 状态、forget 状态 |
| Message | 幂等键、作者身份、事件时间、receivedAt、原始/规范化消息、snapshotId、sourceRef |
| ConfigSnapshot | 人格设定、五路具体路由、预算、configRevision、promptVersion；不含密钥 |
| RetainTask | taskId、message/segment ID、snapshotId、状态、stage、retryCount、nextRunAt、lease/fence、checkpoint |
| MemoryVersion | memoryId、version、类别、正文 hash、docId、writeState、sourceRefs、依赖版本、supersedes、active 指针 |
| Evidence / ProvenanceEdge | 来源消息、事实/派生版本、支持或反对、引文/偏移、全部输入来源闭包 |
| Entity / Alias / Relation | 稳定实体键、QQ ID 或非确定实体、属性与每条关系的来源、事件时间、推断标记 |
| DerivedRefresh | bank、scope、template、retainRouteFingerprint、dirty revision、debounce、触发快照 |
| ReplyJob | 入站消息、人格/配置/授权版本、状态、依赖清单、生成输出 hash、取消原因 |
| Outbox / Segment | replyId、segmentIndex、正文、状态、echo、connectionEpoch、QQ messageId、错误/不确定原因 |
| ForgetTask / Tombstone | 目标来源或消息、代次、阻断时间、删除进度、失败与重试、最小防重放标记 |
| DeletionLedger / Watermark | 独立于正文恢复集的无正文删除/撤权操作日志、单调序号、幂等操作 ID、可信恢复水位与投影进度 |
| MaintenanceTask | embedding 修复、旧版本清理、孤儿文档清理、对账等独立任务 |

### 7.3 记忆字段

每项记忆包含：稳定 memoryId、类别、版本、机器人/人格、来源会话/消息/作者、证据、实体关系、事件时间区间、消息时间、写入时间、可信度标签、inferred、supersedes、依赖版本、有效状态。

- 可信度用 `reported / corroborated / disputed / inferred / unknown` 等内部等级；不冒充统计校准概率。
- 原话“我喜欢茶”是该 QQ 用户报告的偏好，不因第一人称写成机器人的体验。
- `eventTime` 与 `messageTime`、`writtenAt` 独立。相对时间按该消息时间及配置时区解析；保留原始表达、精度与歧义，无法解析时为 unknown。
- 长期偏好可无发生日期；不能把 knowledge 文档更新时间当作事件发生时间。
- 对同一原始消息的重复提取、同一回复的转述，不重复增加独立 proof count。
- 冲突事实保留支持/反对与历史，不简单“最新一句覆盖一切”；过期派生标 stale，不能假装当前事实。

## 8. 全流程权限模型

### 8.1 两种模式

| 模式 | 群回复 | 私聊回复 |
|---|---|---|
| 1：按来源限制（默认） | 仅当前群、同机器人同人格的允许来源 | 当前用户私聊＋通过当前成员验证的允许群，均须同机器人同人格 |
| 2：完全共享 | 同机器人同人格全部当前允许来源 | 同左 |

模式 2 必须显示并要求显式确认：“私聊内容可能用于群回复”。切换为模式 1 或移除来源立即失效相关授权、缓存和未发送输出。

允许列表是采集和来源可用性的上层限制；私聊允许用户列表不等于群内所有成员的采集白名单。来源群退出允许列表后，该群记忆不能继续用于任何回答。

### 8.2 授权快照与判定

宿主生成 `AuthorizedScope`：

```text
botId / personalityId / targetConversation / requesterQQ
visibilityMode / configRevision / authEpoch / bindingRevision
allowedSourceRefs(sourceId + sourceEpoch)
membershipProofs(groupId + requesterQQ + checkedAt + expiresAt)
```

记忆 m 可用必须同时满足：

```text
m 属于指定 bot 和 personality
AND m 是有效版本且未 tombstone、未失效
AND m 的来源闭包完整
AND m 的全部来源都在 AuthorizedScope 中
AND 每个来源的代次匹配且仍允许
AND 若依赖私聊读取群的成员资格，验证仍有效
```

空来源、不明来源、旧代次、未知权限一律拒绝。管理员配置的人格系统设定不是对话记忆，不伪造空来源“公共记忆”绕过规则。

### 8.3 当前成员验证

- 模式 1 私聊需要群记忆时，通过固定 `get_group_member_info` 查询当前用户、目标群、当前机器人连接；支持时要求禁用网关缓存。
- 返回错误、超时、用户/群不匹配、无法确认存在、连接身份变更均排除该群。
- 不依据昵称、用户自述或历史发言授权；成员事件只作为失效信号。
- 正缓存短期有效，负缓存可短期抑制重复失败；查询数量有上限，预算不足则少授权，而非默认放行。
- 每次模型调用前验证本次已用范围仍有效；发送前对实际依赖群强制刷新成员证明。若不能得到新证明，取消旧答案或重新生成不依赖该群的答案。
- OneBot 查询只代表查询时的观察结果，无法与 QQ 成员变更/消息发送建立原子事务；文档不得承诺消除所有远程竞态。

### 8.4 检索候选前过滤

1. 宿主先从持久元数据计算授权、有效的 docIds。
2. 空集合直接无证据返回，不向 knowledge 传空列表以期待默认限制。
3. knowledge 搜索必须限定 baseId 和显式授权 docIds；实体、时间、关系路径也必须在授权子图内进行候选生成和排名。
4. 不允许先从全 bank/全库取 TopK 再丢弃不合法结果；大集合分批也不能丢掉过滤条件。
5. 若底层过滤不能保证，禁用该路径；可通过公开读文档服务在授权集合上建有界词法索引。此时明确是词法降级，不宣称混合检索成功。
6. 结果返回和上下文扩展仍复核版本与来源，防止检索期间撤权或遗忘。
7. 模型仅提出文本查询和语义条件；bank/docIds/群身份/权限字段由宿主决定。
8. rerank 或 embedding 若使用外部服务，其输入也遵守授权范围和管理员配置的外发边界，不因“不算聊天模型”而绕过数据控制。

### 8.5 派生信息的来源闭包

- entity 属性、别名描述、关系边、observation、mental model、reflect 摘要、生成答案都带来源，不只正文带来源。
- 派生项的权限来源至少是所有输入记忆来源的并集；不能仅按模型声明的“实际引用”缩小范围。
- 如需更窄的派生项，必须用更窄范围重新生成，不能让模型声明“已匿名化”就降级为公共信息。
- 默认按单来源范围维护 observation 和三个 mental-model 模板；模式 2 可增加混合范围摘要，但同样保存所有来源。
- 不为所有可能的群组合预生成摘要，避免组合爆炸；动态多来源需求在线综合。
- 同一实体 QQ ID 可用于定位，但对该实体的私聊属性/关系不能作为全 bank 可见简介。
- 群内成功发送的机器人回答可能用过私聊记忆：其 experience 除发送会话外，还继承生成时全部输入依赖。不能把私聊信息经一次群回复“洗成群公开记忆”。
- 近期对话中的机器人历史回复同样继承依赖；只因发送在当前群不代表在更严格模式下仍可复用。

### 8.6 缓存与近期窗口

- 首版 reflect 内容缓存默认关闭；开启时缓存键含 bot、persona、请求者/目标会话、范围指纹、authEpoch、bindingRevision、配置/提示版本及依赖版本。
- 缓存命中仍逐项验证来源、遗忘代次和成员证明，不能只凭 TTL。
- 近期窗口按 bot＋persona＋conversation 分区；入站消息可在 retain 未完成时使用，但仍需权限检查。
- 群绑定变更、模式收紧、来源移除、成员失效、遗忘立即取消受影响调用并使缓存失效。
- 第三方 LLM 服务端的请求留存不受本地缓存清理控制，部署文档明确说明。

### 8.7 发送授权屏障

ReplyJob 保存所有实际发送给各阶段模型的来源闭包，而不仅是最终引用列表。发送前检查：插件启用、机器人身份、目标允许、人格绑定和相关配置版本、全部来源仍有效、成员证明仍有效、依赖未遗忘。

- 授权收紧或绑定改变：取消旧输出，不允许只删引用后发送。
- 可选择重新排队生成一次，但必须重新取证并使用新快照；默认取消，避免重复回复和不受控成本。
- 所有本地授权失效操作（配置/允许列表/绑定变化、遗忘 tombstone、sourceEpoch/authEpoch 变化、owner 失效）和“最终校验＋标记 sending＋提交网络请求”必须使用同一授权提交屏障串行化。遗忘先获得屏障并阻断，则后续段不得提交网络；发送先提交网络，则遗忘记录该在途操作并取消尚未提交部分，结果仍可能未知。不能只让配置更新共用屏障而把遗忘留在独立 bank 锁中，也不能校验后排队很久再发送。屏障不等待网络回包；各模块统一锁顺序，避免与 bank 协调死锁。
- 分段每段都复查。前段已成功、后段撤权时停止后续，记录 partial；不能承诺撤回已发送内容。
- 外部成员变更仍存在检查后的竞态；已提交的网络请求无法保证取消，结果按事实标 unknown/succeeded，而非伪装为未发送。
- 旧权限下已经发给模型的输入无法被事后撤回；可阻止后续调用和 QQ 发送，不声称撤销已发生的外部处理。

### 8.8 generic knowledge 与管理员边界

新库创建后、导入正文前关闭 proactive 自动注入。检查本机 generic knowledge 工具是否支持库级排除，提供管理员配置说明而不自动修改全局工具设置。若没有排除能力，明确其他可信 Agent/插件可能读取这些库；本插件的 PolicyEngine 不是 knowledge 存储层 ACL。需要不信任同机插件的强隔离时，应使用独立 profile/进程/存储部署边界，超出本首版承诺。

## 9. Bank 并发与跨存储写入状态机

### 9.1 Bank 创建与所有权

```text
unmapped → provisioning → ready
                    └→ reconciliation_required → ready / blocked
ready → suspended → ready
ready / suspended → retiring（仅显式管理操作）
```

- bankKey 有持久唯一约束；创建前记录确定性 provisionMarker，不用人格显示名当唯一标识。
- 每次只允许一个实例拥有该插件域；第二实例获取不到 owner lease/fence 时拒绝启动，避免热重载和多进程双消费。
- 创建 knowledge 库后持久绑定 baseId。若中途崩溃，限定命名空间分页列库，按精确 marker 对账；多候选隔离人工核验，不盲目创建/合并。
- 确认 proactive 已关闭前不导入正文。不关闭不属于本插件的库。

### 9.2 并发规则

- 全局 retain 并发默认 2；不同 bank 可并发。
- 同 bank 的原始证据/独立事实提取可并发，持久写意图必须唯一；派生激活、有效指针切换、遗忘代次更新串行。
- LLM 与 knowledge 网络调用不占长时间数据库事务。读取依赖 revision→外部计算→短事务 CAS 激活。
- CAS 失败不覆盖别人新版本；使用任务原 retain 快照，重新取合法依赖、标记 dirty 后重算。
- worker lease 带 fencing token；所有含正文的本地提交（提取结果 checkpoint、WriteIntent、缓存、派生正文、experience 任务载荷）以及新任务创建都在提交事务中核对 ownerFence、来源代次、tombstone 和授权状态，不仅是最终激活检查。租约过期、遗忘后或卸载后的迟到 LLM/knowledge 回包不得重新落下敏感正文；允许记录不含正文的错误/对账元数据。
- 限制 CAS 冲突重算次数；持续冲突延迟重试而不是无限忙循环。

### 9.3 文档追加版本状态

```text
planned → writing → text_saved → active → superseded → cleanup_pending → cleaned
               └→ reconcile_required ─→ text_saved / writing / failed
planned / text_saved / active ─→ invalidated → cleanup_pending
```

独立的向量状态：`not_requested / pending / ready / failed / unknown`，不与正文状态合并。

写入协议：

1. 本地提交 WriteIntent，含 memoryId、version、内容 hash、精确 marker、来源代次、依赖版本、目标 bank。内容 hash 基于不含恢复标记的规范化正文与必要来源元数据计算，明确编码和序列化版本，避免把 hash 自身写入被哈希内容的循环定义。
2. 调用公开 knowledge 添加正文服务；标题及正文包含插件生成的 `memoryId/version/writeIntentId/hash` 标记，不使用模型输出标记。
3. 核实正文可读后记录 docId 与 text_saved；embedding 失败可以是文本已保存，不应立刻重复添加正文。
4. 在 bank 协调下重新检查来源、tombstone、ownerFence、依赖版本；短事务 CAS 激活新版本，同时退出旧有效指针并增加 bank revision。
5. 旧文档异步清理，在实际删除前已不进入任何召回集合。
6. 新文档成功但本地记录失败时，恢复先按 marker 精确对账并比较 hash；匹配则复用，不调用 LLM重新生成并误认同一版本。
7. knowledge 调用超时视为写入结果未定，进入对账；不能直接当作“没有写入”。
8. 多个完全相同候选选定一个 canonical docId，其他进入孤儿清理；同 marker 不同 hash 隔离报错。

对账必须通过限定 bank 的完整分页枚举/精确查询完成，不依赖语义搜索找到“看起来相同”的文档。两库没有跨库事务，文档短暂重复或孤儿仍可能发生；控制目标是可恢复、可审计及只有一个有效指针。

### 9.4 向量与清理任务

- 无 embedding 时使用词法；embedding 失败显示 `text_saved + vector_failed`，独立修复而非删除已保存正文。
- 若底层 embedding 错误连词法搜索也阻断，走授权正文的插件词法降级路径；没有安全路径就明确失败。
- 旧版本清理、孤儿对账、embedding 修复各自有重试和状态，不消耗原消息 retain 的重试次数。
- 删除返回“已不存在”视为清理成功；其他错误记录并退避重试。

## 10. Retain 任务状态机与派生刷新

### 10.1 任务状态

```text
pending → running → done
              └→ retry → running
              └→ dead-letter
pending / retry / running → cancelled（撤权、遗忘、身份失效）
```

`running` 必须有 owner、leaseUntil、fence 和 checkpoint；启动时仅回收失效 owner/过期 lease 的任务，不抢占仍活跃 worker。

checkpoint 阶段：

```text
ingress_committed
→ raw_intent / raw_text_saved / raw_active
→ extracted_validated
→ fact_versions_written / facts_active
→ derived_jobs_enqueued
→ done
```

- 已校验提取结果持久保存，不因后续清理失败重新抽取事实。
- `done` 表示本消息 raw/facts 流程完成且派生任务可靠入队，不表示所有 mental models 和向量已更新；运行状态分别展示。
- 抽取无有价值事实时仍保留 raw evidence，正常 done。
- 提取失败可死信但原始证据保持已保存；知识正文写失败则报告 raw 未落 knowledge，不能冒称已完成。
- 最多初次＋5 次重试，指数退避加抖动；格式错误只在单次调用内修复一次，任务层重试仍受总次数约束。
- 管理员内部 retry 接口保留失败历史。tombstoned 目标永不复活；普通 cancelled/quarantined 但未遗忘的数据，只有经显式重新授权、来源重映射和依赖复核后才能创建新的恢复任务，不能直接把旧任务改回 pending。

### 10.2 提取与合并

- 首版逐消息处理，不默认批处理；后续批处理必须相邻同会话、同人格、同快照指纹，且逐条保留证据。
- 来源和作者由宿主注入；模型只提出事实内容、实体/关系建议、事件时间和推断等级。
- 用户事实和机器人经历分开。失败或未知发送的文本不能当成功对话、不能提炼为用户事实。
- 合并同 scope 的 observation；保留具体支持/反对来源和引文，反复重复同一证据不增加 proof count。
- 新事实未合并时提高 scope dirty revision，旧 observation 标 stale；在线遇到 stale 项需核对更底层事实，不能直接作为最新结论。
- 指令注入、人格改写、调用工具等消息内容只当不可信数据；模型输出不能改变配置或任务权限。

### 10.3 Mental-model 模板

1. 稳定偏好：谁明确表达了哪些偏好、是否后来变更、证据和时间。
2. 关系背景：人物/组织关系、QQ 身份与非确定实体的区分、矛盾及未知。
3. 未完成事项：谁提出的事项、承诺主体、状态、截止时间、完成/取消证据；机器人提出建议不等于用户已经承诺。

每份模型包含 templateId、scope、sourceRefs、dependencyVersions、coveredRevision、generatedAt、stale 和版本历史。

按新增有效事实和防抖触发；繁忙来源设最大等待，防止一直推迟。新增无关事实不得刷新所有 scope。刷新输入仅由宿主选定合法证据，不运行聊天 recall 槽位；需要检索时使用固定检索服务和 retain 自己的内容处理。模板生成、冲突合并和更新都用触发任务的 retain 槽位。

## 11. 按来源遗忘与撤权

### 11.1 区分三个动作

- 移出允许列表：立即停止采集、使用和相关任务，不自动宣称物理删除。
- 改严格模式：立即收紧读取，不改变原始记忆归属。
- 显式遗忘：逻辑阻断优先，随后物理删除所有受影响正文和派生副本。

默认移出允许列表后保留旧数据但 quarantined；重新允许只开启新 sourceEpoch，旧数据不自动恢复。若管理员需要恢复非遗忘数据，须显式操作并重新校验派生。被遗忘内容不能恢复或因重新允许而重放入库。

### 11.2 遗忘状态机

```text
requested → blocked → purging → purged
                         └→ retry → purging
                         └→ dead-letter（仍保持 blocked）
```

1. 在共享授权屏障内先按第 11.3 节可靠登记删除日志，再由本地事务写 tombstone，提高来源/消息的 forget generation 与 authEpoch。阻断生效后立刻从所有候选、缓存和近期窗口排除。
2. 若 tombstone 提交失败，整个受影响 bank 暂停处理并报故障，不返回“遗忘成功”。
3. 取消依赖该来源的在线任务、outbox 未发分段、retain 和派生任务。
4. 按反向依赖图失效所有派生项；来源闭包不完整时暂停该 bank，而不是假设没有依赖。
5. 删除 knowledge 中原文、事实、旧版本、孤儿及受影响的 observation/mental-model 全文；从剩余来源重新生成，不在旧摘要中简单删一个引用。
6. 清理插件消息正文、提取结果、生成文本、缓存、outbox 正文及可复制敏感内容的错误字段；保留不含正文的最小 tombstone/幂等键/审计状态。
7. 遗忘与 knowledge 写入并发时，写入前和激活前检查代次；所有含正文的中间结果持久化同样检查。迟到落库文档不能激活，并进入删除对账。旧 owner 的回包不能取消 tombstone。迟到发送成功只能更新不含正文的送达审计；如果依赖已遗忘，不得创建/补偿 experience 正文任务。
8. `purged` 的条件：受影响来源的 worker 已停止或被 fence、所有本地含正文写入受阻、所有已登记在途 knowledge 写入都已确认终止或完成并删除、完整分页对账与本地副本清理完成。WriteIntent 的无正文账本保留至收敛，用于追踪旧 owner/超时请求。有限次数“查不到文档”或静默等待本身不能证明外部写入已终止；不能证明时保持 `purging` 并显示 `external-write-unknown`，可进入维护死信但始终 blocked，不提前宣告物理清除。

### 11.3 备份恢复与删除水位

- 物理删除不意味着备份、外部模型留存、已经发送到 QQ 的内容均被抹除。部署必须说明这些边界。
- 不能只重放旧备份自带 tombstone：它可能缺少备份之后发生的遗忘。采用独立于正文恢复集的追加式、带单调序号的删除/撤权日志（deletion ledger）；可使用插件拥有的独立持久域并配套管理员导出/归档，但不得在恢复旧正文时把该日志一并回滚。
- ledger 只保存最小目标标识、代次、操作 ID 和水位，不保存被遗忘正文。遗忘请求先在授权屏障内阻止新操作，可靠追加 ledger，再提交控制库 tombstone 投影；若后一步失败，bank 保持暂停，恢复从 ledger 重放，不将操作报告为完成。两个持久位置不假定跨库事务，使用可重放操作 ID 对账。
- 显式恢复流程先冻结入口，以保留下来的最新 ledger 或经核验的完整外部归档重建 tombstone/sourceEpoch，再清理恢复出的正文与派生，完成对账才开放处理。日志截断/归档必须保留足够的墓碑基线和可信水位，不能因正文删除而丢失防复活证据。
- 无法证明恢复时拿到的是最新删除水位（例如正文和 ledger 均被整体回滚且没有独立可信记录）时，恢复验收不通过并保持 bank blocked；不能以“管理员点击确认”替代缺失记录。部署若没有独立保全机制，就明确不支持旧备份的安全开放恢复，而不宣称可自动防复活。任意绕过恢复流程的文件回滚属于不受保证的管理员操作。

## 12. 在线回复与独立发送状态机

### 12.1 在线数据流

1. **快照与排队**：使用已可靠入队的消息；同会话串行，不同会话有界并行，排队也计入总时限。
2. **授权近期窗口**：从相同 bot/persona/conversation 读取有界历史，过滤撤权/遗忘和跨范围机器人输出；避免当前消息被重复计入历史。
3. **Router**：仅判断 recall 或 reflect；无权限扩大能力。
4. **Recall 规划**：当前消息及必要的已授权近期内容进入 recall 模型，输出文本查询、实体候选和时间条件。
5. **执行检索**：计算候选前授权集合；knowledge 路径和插件实体/时间路径独立有界执行。
6. **融合整理**：按 memoryId＋version 去重，避免同文档多块挤占全部预算；RRF 合并。若只能取得 knowledge 的 hybrid 列表，将其作为一条路径，不把相同结果伪装成两条独立语义/词法投票。可用 rerank 由 knowledge 配置控制，不强行增加外部模型。
7. **Recall 整理**：仅用授权证据；输出经过 ID/引文校验的要点；失败保留合法原始证据。
8. **Reflect 可选分支**：优先检查授权且新鲜的 mental models/observations，必要时验证 raw facts。reflect 可提出缺失问题，但后续检索规划/整理仍调用 recall 槽位。最多三轮，包含首次；预算耗尽使用已有证据标明不足。
9. **Reply**：独立调用 reply 槽位，输入人格系统设定、完整当前规范化消息（入站上限内）、授权近期窗口、recall 证据或 reflect 摘要。不索取隐藏思维链，不直接转发 reflect 摘要。
10. **输出验证与分段**：完整生成后验证长度和纯文本，保存依赖清单及 outbox。超出总发送预算则不发送截断的“完整答案”；若配置允许缩写，也必须仍用 reply 槽位并计入预算。
11. **发送屏障**：复查全部权限、配置、绑定、依赖及成员身份；失效则取消。
12. **确认经验**：仅成功发送分段创建机器人 experience retain 任务，并继承生成依赖和入站 retain 快照。

当前消息、近期对话和记忆均是数据，不能覆盖人格 system 指令、操纵 scope、调用任意 API 或执行 CQ。机器人没有记忆证据时应说明未知，不能补造“以前说过”。

### 12.2 ReplyJob 状态

```text
pending → generating → prepared → sending → completed
    │          │          │          ├→ partial
    │          │          │          ├→ unknown
    │          │          │          └→ failed
    └──────────┴──────────┴────────────→ cancelled（仅取消尚未提交的部分）
```

生成失败与 retain 失败互不覆盖；未触发消息根本不创建 ReplyJob。已在网络中的发送不能仅标 cancelled，必须保留已发/未知状态。

### 12.3 每段 Outbox 状态

```text
prepared → sending → succeeded
                  ├→ failed
                  └→ unknown
prepared → cancelled
unknown → succeeded / failed（仅凭可靠迟到回包或人工核验，不自动重发）
```

- reply 完整输出后本地事务保存段序列及正文 hash，唯一键 `replyId + segmentIndex`。
- 每段通过授权屏障后先持久标 sending，再执行对应固定发送 API。sending 的定义是“可能已提交”，不是收到确认。
- 正文始终为 `[{type: 'text', data: {text: '...'}}]`；模型输出中的 `[CQ:...]` 只会作为文字发送。
- 只有 retcode/status 明确成功且响应字段符合网关约定，才确认 succeeded 并记录 QQ messageId。
- 明确拒绝回包标 failed；超时、断连、回包不可判定、请求可能已提交后取消等标 unknown。
- echo 是回包关联，不是上游幂等键。unknown 不自动重试，不因重连恢复为 prepared。
- 前一段 succeeded 才发送下一段；任意 failed/unknown 停止后续。整体保留部分成功和每段状态，不用单一“失败”掩盖已经发送的内容。
- 通常发送成功确认与创建 experience retain 任务在本地同一事务完成，且事务检查当前 owner、来源代次及 tombstone；若依赖已撤权/遗忘，则只保存不含正文的成功确认和禁止创建经验的原因，不再持久化回复正文或补偿经验任务。事务失败时不能假定未发送；恢复按 unknown 处理并对账。
- 默认对失败发送也不自动重发；确需管理员重发必须显式确认，并在 unknown 场景提示重复风险。

### 12.4 崩溃恢复策略

| 崩溃时状态 | 恢复动作 |
|---|---|
| retain pending/retry | 按原快照和 nextRunAt 恢复 |
| retain running，旧 lease 失效 | 从 checkpoint 对账并重试，先核对已写 knowledge |
| reply pending/generating | 首版默认 cancelled(restart)，避免重启后突发旧回复；消息 retain 不受影响 |
| segment prepared | 默认取消剩余分段，不启动旧回复续发 |
| segment sending | 标 unknown，禁止自动重发；可能实际上已送达 |
| segment succeeded | 不重发；仅在来源/代次仍有效且未遗忘时核对并补偿唯一 experience 任务，否则只保留无正文审计 |
| 清理/遗忘任务进行中 | 先恢复阻断，再恢复删除/对账，不能先开放召回 |

这是安全优先的恢复策略：承诺后台记忆任务恢复，不承诺重启后补发全部在线回复。未来如提供“恢复未提交回复”选项，必须重新授权、检查过期和零已发/未知分段，不能改变 unknown 默认禁重发原则。

## 13. 生命周期、运行状态与内部管理

### 13.1 启动顺序

1. 校验配置和依赖能力，拒绝非持久存储/未知人格/无有效模型。
2. 获取插件域 owner lease，检查 schema 版本并完成可恢复迁移。
3. 核对 deletion ledger 水位与控制库投影，先补齐 tombstones/撤权代次，再加载有效版本并重建授权索引与反向依赖图；备份恢复模式缺少可信最新水位时不开放读取。
4. 对账 bank/knowledge 写意图和 outbox；恢复任务状态。
5. 启动后台 worker 和维护队列。
6. 仅 enabled 且无阻塞时连接 OneBot，身份核验通过后开始处理消息。

### 13.2 卸载顺序

1. 停止入口和重连，拒绝新任务，标记 shutting_down。
2. 取消在线 LLM 和检索调用；已提交发送记录可能未知，不能当作未执行。
3. worker 停止领取，保存 checkpoint；有界等待在途调用，失效 fence 防止迟到激活。
4. 刷新本地状态、释放 owner lease，关闭本插件拥有的存储句柄与资源。
5. 不关闭注入的共享 knowledge/LLM 服务，不销毁其他插件资源；具体句柄所有权按核实后的 Cordis/服务契约执行。

### 13.3 内部接口与可观察性

提供可信宿主可调用的内部服务方法（不暴露公网 HTTP、不让 QQ 消息直接执行）：

- `getStatus()`：连接/身份、schema、bank、队列深度、pending/retry/dead-letter、文本/向量状态、发送 unknown、缺口区间。
- `retryTask(taskId)`：失败任务重试，验证来源与快照，不绕过 tombstone。
- `forgetBySource(scope)`：群/私聊/作者/指定消息范围的遗忘；作者条件可跨其来源消息建立反向依赖。
- `getForgetStatus(id)`：区分逻辑阻断和物理清理完成。
- `reconcileBank(bankKey)`：限定本插件 bank 的对账与修复，不跨其他库。

日志默认只含阶段、路由标识、脱敏 ID、耗时、计数、错误码和关联 ID；不记录原文、token、鉴权头、含凭据 URL、模型密钥或完整 prompt。模型供应商错误消息先净化再落盘。

## 14. 配置示例（规划草案）

以下展示配置语义，不宣称已经与本机自动表单 schema 对接。provider/model 是占位值，必须替换成 DSH 实际注册路由。

```json
{
  "onebot": {
    "enabled": false,
    "wsUrl": "ws://127.0.0.1:3001",
    "token": "",
    "expectedSelfId": "100000000"
  },
  "allow": {
    "groupIds": [],
    "privateUserIds": []
  },
  "models": {
    "router": {"selection": "explicit", "provider": "PROVIDER_A", "model": "MODEL_ROUTER", "maxOutputTokens": 256, "timeoutMs": 10000},
    "recall": {"selection": "explicit", "provider": "PROVIDER_B", "model": "MODEL_RECALL", "maxOutputTokens": 1536, "timeoutMs": 20000},
    "reflect": {"selection": "explicit", "provider": "PROVIDER_C", "model": "MODEL_REFLECT", "maxOutputTokens": 1536, "timeoutMs": 25000},
    "retain": {"selection": "explicit", "provider": "PROVIDER_D", "model": "MODEL_RETAIN", "maxOutputTokens": 2048, "timeoutMs": 60000},
    "reply": {"selection": "explicit", "provider": "PROVIDER_E", "model": "MODEL_REPLY", "maxOutputTokens": 1536, "timeoutMs": 40000}
  },
  "personalities": [
    {
      "id": "assistant-main",
      "name": "小忆",
      "aliases": ["忆酱"],
      "systemPrompt": "你是小忆。遵守证据边界，不虚构长期记忆。",
      "style": "自然、简洁、友善",
      "background": "一个帮助大家整理信息的聊天伙伴。",
      "disposition": {"skepticism": 3, "literalism": 3, "empathy": 4},
      "visibility": "source-restricted",
      "models": {"reply": {"selection": "inherit"}}
    }
  ],
  "bindings": {
    "defaultPersonalityId": "assistant-main",
    "groups": [],
    "privateUsers": []
  },
  "budgets": {
    "onlineConcurrency": 4,
    "retainConcurrency": 2,
    "retainMaxRetries": 5,
    "reflectMaxRecallRounds": 3,
    "onlineMaxLlmCalls": 12,
    "onlineDeadlineMs": 120000
  }
}
```

显式覆盖示例：将某人格的 reply 改为 `selection: explicit` 并同时填写 provider/model；其他四槽继续继承。完全共享使用 `visibility: fully-shared` 并要求独立确认字段，不能仅靠默认值开启。

## 15. 测试与验收矩阵

### 15.1 模型路由

| 编号 | 场景 | 必须断言 |
|---|---|---|
| M1 | 五个不同 mock 路由 | 每次调用的阶段、provider/model、token、timeout 正确 |
| M2 | 人格覆盖与全局/默认继承 | 路由成对继承；半路由拒绝；effort 不跨不兼容模型串用 |
| M3 | reflect 多轮检索 | 规划/整理仍为 recall；总结为 reflect；最后始终 reply |
| M4 | retain 提取/合并/模板刷新 | 全部 retain；防抖/恢复后仍用原任务路由 |
| M5 | 显式模型移除/认证失败 | 阶段错误可见，不偷偷换供应商 |
| M6 | JSON 格式与语义错误 | 最多一次修复；伪 evidenceId、伪来源、错误引文被拒绝 |
| M7 | 预算和取消 | 修复计入总调用；超时不重置；reply 失败零发送 |

### 15.2 OneBot 与发送

- 鉴权头、token 日志净化、机器人身份不符、旧连接 echo、retcode 错误、心跳和重连退避。
- 数组/CQ 解码、文本转义、普通提及、机器人 at、at all、引用/元数据忽略、自身/系统/匿名事件。
- 幂等重复、同键不同正文、缺 messageId、入站大小/消息段限制。
- 同会话串行、不同会话并发上限、未触发群消息 retain 但零在线模型调用。
- 长回复分段顺序、纯 text 发送、模型生成 CQ 指令不执行。
- 发送前明确失败、提交后超时、断线、迟到回包、partial、unknown 不重发。
- 已送达但本地成功记录前崩溃：重启 unknown，不重复发，不冒称成功 experience。
- 仅已确认成功分段入 experience；去重事件不能导致再次回复。

### 15.3 记忆、并发、恢复

- world/experience 分类、QQ 身份、别名歧义、事件时间与写入时间区分。
- 原始闲聊保存、提取慢/失败不阻塞回复、无 embedding 和 embedding 失败词法降级。
- 新版本先写后激活、旧版本不可召回、重复导入精确对账、不同 hash 冲突隔离。
- 两 worker 同 bank 创建、同时合并 observation、CAS 冲突、lease 过期回包不能激活。
- 在 WriteIntent 前后、knowledge 文本落库前后、docId 记录前后、有效指针切换前后逐点故障注入。
- 原始事实完成但派生队列未提交、刷新防抖中重启、死信重试、清理重试与 retain 重试分离。
- 遗忘与提取/knowledge 写入/激活并发；迟到写入不能复活；混合派生全部失效并重建。
- 在发送最终校验与网络提交之间执行遗忘，验证共享授权屏障的提交顺序；已提交发送保留真实未知状态。
- 清理完成后注入旧 LLM/knowledge/发送回包，断言不再保存敏感 checkpoint、WriteIntent 或 experience 正文；未知外部写未收敛不得进入 purged。
- 备份恢复核验独立最新 deletion ledger；缺失更新墓碑、回滚 sourceEpoch、ledger 追加后控制库提交失败均保持阻断；迁移失败不半启动；双实例拒绝双消费。

### 15.4 安全矩阵

至少使用 2 个机器人、2 个人格、3 个群、3 个私聊用户及不同成员关系，覆盖：

1. 模式 1 群只能读取本群；私聊只能读取本用户私聊及验证通过群。
2. 模式 2 同人格共享但不跨机器人/人格，不含退出允许列表的来源。
3. 成员身份错误/超时/退出/缓存过期、查询预算耗尽都 fail closed。
4. 空 docIds 不触发全库搜索；搜索接口收到的集合全部授权；图/时间路径不使用未授权节点边。
5. observation/mental model 混合来源、实体简介、别名和关系元数据不得绕过限制。
6. 缓存命中、近期窗口、机器人经验同样过滤；模式 2→1 后旧全局摘要和依赖私聊的群回复不能复用。
7. 在 router、recall 规划、搜索、整理、reflect、reply、发送排队、分段间分别撤权/遗忘/改绑定。
8. 每个域放独特秘密标记，断言未授权标记不进入候选、任何模型输入、外部 rerank 输入、缓存或发送正文。已在合法请求发出后撤权的例外按第 8.7 节单独记录。
9. 伪造引用 ID、QQ ID、bank/docIds、人格切换命令、CQ 注入和 prompt injection 不能改变宿主权限。
10. 遗忘清理同时覆盖插件收件箱、outbox、派生历史及 knowledge，清理失败保持阻断。

### 15.5 构建与真实测试分层

- 静态：格式、lint、TypeScript 类型检查、配置 schema、依赖/密钥扫描。
- 单元：确定性 mock 模型、存储、时钟、WS、故障注入。
- 兼容集成：实际 DSH 服务适配与 dsh-knowledge 版本，用临时数据域验证，不操作真实 QQ。
- 包检查：预构建产物、exports/manifest、peerDependencies、锁文件、离线解包检查；在隔离临时 profile 中验证安装/卸载，不安装当前 profile。
- 真实模型：单独报告供应商、模型、reasoningEffort、token/延迟、JSON 成功率；无凭据标未运行。
- 真实 embedding/rerank：单独验证向量就绪与失败降级；mock 不能替代。
- 真实 QQ：需用户提供 OneBot 地址/token、机器人账号、允许列表、模型，并确认 AstrBot bridge 不会同会话重复回复；单独授权启用。

## 16. 实施阶段与退出条件

| 阶段 | 工作 | 退出条件 |
|---|---|---|
| P0 兼容核验 | 只读核实服务、bundle、持久性、过滤语义和可用模型 | 接口清单与能力报告；阻塞项不隐瞒 |
| P1 插件骨架 | bundle、自动配置表单、peer 依赖、快照、模型适配 | 类型检查与继承测试通过，默认不启用 |
| P2 可靠控制平面 | schema、事务、owner、任务、bank、版本、outbox、tombstone | 崩溃恢复和 CAS 单测通过 |
| P3 OneBot | WS、身份、解析、触发、允许列表、入队与安全发送 | mock 网关矩阵通过，不连接真实账号 |
| P4 权限与记忆 | 授权候选、来源闭包、raw/facts、词法、实体时间 | 未授权信息不进入候选/模型，可靠 retain |
| P5 派生与在线 | observations、mental models、五阶段、reflect 循环、发送屏障 | 五路调用与全流程撤权测试通过 |
| P6 故障与打包 | 遗忘、跨库对账、磁盘/队列满、迁移、预构建安装检查 | mock/兼容集成报告和可安装包 |
| P7 可选真实联调 | 经授权使用真实模型、embedding 和 QQ | 单独报告，不以未运行当作通过 |

权限引擎和状态机是基础设施，不能等功能完成后再补。P0 如果无法获得候选前过滤或可恢复持久性，必须先落实安全降级或明确阻塞，不绕过宿主、不虚构完成。

## 17. 交付清单与最终验收

### 17.1 实施阶段应交付

- 独立 TypeScript 源码、锁文件、构建配置、配置 schema 与无真实凭据的示例。
- 中文配置指南、架构/状态机、安全边界、备份恢复、遗忘和故障处置说明。
- mock 单测、故障注入、安全矩阵、兼容集成与包安装检查。
- 可安装预构建 bundle 包、内容清单和校验值。
- 测试报告明确分开：构建、类型、mock、实际知识服务、真实模型、真实 embedding/rerank、真实 QQ。
- generic knowledge 排除检查说明及 AstrBot bridge 重复回复联调清单。

### 17.2 验收必达

1. 群未触发消息可靠入队后台 retain，零在线生成；@/当前人格文本提及才回复。
2. 五阶段可独立选模型，支持人格覆盖，重试与刷新不串路由，不静默换供应商。
3. 事实问题 recall、综合问题 reflect，之后都独立调用 reply；失败遵守约定降级。
4. 同人格积累、多来源可见性正确；撤权贯穿候选、模型输入、缓存、派生、近期窗口和发送。
5. retain 慢/失败不阻塞在线；重启恢复任务；两库对账、版本与遗忘防复活通过故障测试。
6. 在线发送状态独立持久化；unknown 不盲目重发；只确认成功的部分进入机器人经历。
7. 无任意 Agent 工具执行，模型不能执行 CQ、修改权限或指定 bank/docIds。
8. 默认不开启真实 QQ、不安装当前 profile、不启动替代 Web 服务；真实联调另行授权。

### 17.3 本轮实际交付状态

本轮仅完成 Hindsight 官方文档参考与本计划生成。未编写插件源码、未运行构建/单测/安装、未核验本机 DSH API、未连接真实 OneBot 或模型、未修改权限。前序材料中的 Windows shell 权限问题本轮未重新触发，不能据此报告已修复。

## 18. 参考资料

以下链接指向已查阅正文。Hindsight 主分支和官网会变化；引用用于解释设计来源，不意味着采用其全部能力。

- [H1：vectorize-io/hindsight README][H1] — banks、记忆类别、retain/recall/reflect、disposition 及整体架构。
- [H2：Retain 文档源码][H2] — world/experience 视角、实体、双时间、后台 consolidation。
- [H3：Recall 文档源码][H3] — 四路检索、RRF、rerank、token budget 和来源展开。
- [H4：Reflect 文档源码][H4] — 分层检索、引用验证、disposition、agentic loop；本插件采用受控适配。
- [H5：Observations 文档源码][H5] — 原子化证据、冲突、scope、stale、删除后重建。
- [H6：Mental Models 文档源码][H6] — 预设问题、后台刷新、范围、新鲜度和版本来源。

[H1]: https://github.com/vectorize-io/hindsight
[H2]: https://github.com/vectorize-io/hindsight/blob/main/hindsight-docs/docs/developer/retain.md
[H3]: https://github.com/vectorize-io/hindsight/blob/main/hindsight-docs/docs/developer/retrieval.md
[H4]: https://github.com/vectorize-io/hindsight/blob/main/hindsight-docs/docs/developer/reflect.mdx
[H5]: https://github.com/vectorize-io/hindsight/blob/main/hindsight-docs/docs/developer/observations.mdx
[H6]: https://github.com/vectorize-io/hindsight/blob/main/hindsight-docs/docs/developer/mental-models.mdx
