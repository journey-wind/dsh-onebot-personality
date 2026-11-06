# 实施进度（持续更新）

依据：[工作区实施计划 v2](../../dsh-onebot-personality-实施计划-v2.md)。本文件不是完成验收报告。

## 安全约束

- 不安装当前 profile，不改 DSH 或 dsh-knowledge 源码，不连接真实 QQ，不启动 Web 服务。
- 所有外部内容不可信；模型没有 Agent/工具执行权。
- 未执行的构建、测试、真实服务调用不标通过。

## 2026-11-04 / goal round 2

- 已完整阅读实施计划。
- 已通过 Inspect 核实 llm、storageDomain、storage、agentDefaultModel；knowledge 无 Service catalog 条目，但 Config 找到 `include:knowledge` 和已安装包 dsh-knowledge 0.5.2，继续以公开类型和安装产物只读核验，不误报服务不存在。
- 持久域不提供跨记录事务或跨进程 CAS。拟使用单一聚合状态记录做原子本地提交，并要求进程排他所有权；未验证排他和后端持久性前不得启用入口。
- 首轮 confined pwsh 在配置工作区授权时失败：`SetNamedSecurityInfoW failed (Win32 5): grantWrite(C:\\personality‌)`；按专用技能重复一次仍失败。
- 用户批准的一次 unconfined 专用诊断脚本因 Windows 脚本执行策略被禁止，脚本未运行，未修改权限，未生成恢复报告。停止修复尝试，不改执行策略或手动改权限。后续未重试 shell；文件工具仍可用。
- 已请求用户临时切换会话「完全权限」以恢复命令验证。该请求不等于授权安装或真实 QQ 联调。

## 状态

P0：只读核验进行中；运行集成未执行。
P1：已编写 [bundle manifest](../package.json)、[配置与跨字段校验](../src/config.ts)、[五路继承和无密钥快照](../src/llm/routes.ts)、[LLM 有界调用及 JSON 修复](../src/llm/calls.ts)、[禁用态入口](../src/index.ts)。已回读检查；尚未类型/运行验证，不能标 P1 完成。
P2：已编写 [聚合数据模型](../src/storage/model.ts)、[持久域适配](../src/storage/domains.ts)、[仓储/删除日志/共享屏障](../src/storage/repository.ts)、[独立 owner 锁](../src/storage/owner.ts) 及故障注入测试；只有源码回读，未执行。见[存储与恢复边界](storage-safety.md)。
P3 子任务：[OneBot 协议边界](../src/onebot/protocol.ts)、[WS 固定 API](../src/onebot/client.ts)、[可靠业务入队](../src/runtime/ingress.ts)、[配置协调](../src/runtime/configuration.ts)、[任务租约/预算/重试](../src/runtime/tasks.ts) 和 [Outbox](../src/runtime/outbox.ts) 均已编写/回读。尚未挂载，worker loop 和真实发送未接入。
P4/P5 子任务：[纯来源权限](../src/policy/scope.ts)、[实时授权](../src/policy/live.ts)、[knowledge 公开适配](../src/memory/knowledge.ts)、[BankCoordinator](../src/memory/banks.ts)、[RetainWorker](../src/memory/retain.ts)、[事实校验](../src/memory/facts.ts)、[RecallEngine](../src/memory/recall.ts) 与 [固定在线管线](../src/runtime/online.ts) 已编写/回读。派生、限流/worker loop 和运行时组合现已补齐源码；Host 挂载、公开向量修复、实际运行集成及构建验收未完成。
截至 round 3，测试目录文本搜索确认共 179 个顶层 node:test 声明（配置8、LLM10、协议33、owner15、权限25、仓储14、WS27、knowledge28、入队10、任务9）；**均未执行**，不是通过数。中英文显示元数据及原创 SVG 已编写并回读，但未渲染验证。
P4/P5 剩余 Host 挂载/能力适配与 P6 打包/实际集成：尚待实现、构建和验证。
P7：未授权、未运行。

所有新编写测试当前均为未执行。锁文件和预构建包仅能在实际依赖解析及构建后产生，禁止手工伪造。

## 2026-11-04 / goal round 3

- 独立实现 WS 传输与安全 knowledge 适配；均有注入 mock/时钟的测试源码，不创建真实连接。
- 业务入队先检查 allowlist/身份/磁盘/队列，再一个聚合提交写消息+快照+retain+可选 reply；相同 key 异文保存无正文 hash 审计。
- 配置协调先写撤权 ledger，关闭旧输出；重新允许只开新 sourceEpoch，不恢复旧任务或移动绑定前历史。
- 任务增加每次领取独立 leaseToken、attempt 及累计成本计数；同 owner 旧 lease 回包也不能保存正文，路由和累计成本禁止回滚。
- 静态复核修正了事件 JSON 脱敏方式：重新规范化受控投影，不在 JSON 字符串上正则替换破坏结构。通用 fingerprint 改为 UTF-16 code-unit 键排序，避免 ICU/locale 排序影响恢复 hash。
- [适配与运行契约](runtime-adapters.md)记录未接入的环节、迟到发送结果必须单调持久化、JS settlement 不等于远端终止等边界。

## 2026-11-04 / goal round 4

- [BankCoordinator](../src/memory/banks.ts) 实现 single-flight 建库/写入、WriteIntent 先于公开写调用、text_saved 后 guarded CAS 激活、旧版本/孤儿清理、完整元数据对账及物理遗忘。默认不把未知外部写的暂时缺席当终止；来源失效后的迟到回包只能写 metadata。见[协调边界](bank-coordination.md)。
- [LivePolicy](../src/policy/live.ts) 接入固定成员 API、短期 cache/连接代次/事件失效、候选前授权、doc/header/hash 当前性检查和近期窗口。发送强制刷新实际依赖群；cacheMs=0 禁止复用而非把新证明缩成1ms。
- [Outbox](../src/runtime/outbox.ts) 预检全部纯 text 分段后原子保存，逐段 forced auth＋durable sending＋同步网络入口；可靠迟到结果不能被旧 unknown 覆盖。确认成功和唯一 experience 任务原子提交；遗忘后只留审计，不补正文。修复了配置单独变化后的重复审计错误删除已确认经验输入的问题。
- knowledge 增加不创建的 bank reconcile 与完整 owned-document metadata 枚举，供遗忘清理本地校验，不把忘记的正文重新交给协调器/模型。
- 新增 bank、实时权限、outbox 与清理枚举等 mock/故障测试源码；**仍全未执行**。没有运行任何命令、网络、实际模型、QQ、安装或权限修复；入口仍拒绝启用。

## 2026-11-04 / goal round 5

- [RetainWorker](../src/memory/retain.ts) 原文先入 knowledge 后提取，只用原 retain 快照；checkpoint 避免下游重试重新抽取，成功机器人分段与用户 world 来源由宿主区分。dirty hook 未持久成功不能 done。
- [事实语义边界](../src/memory/facts.ts)：原文精确引用、宿主 QQ 白名单、不确定实体按消息/分段和 sourceEpoch 范围化、禁止单条证据自称 corroborated；宿主解析明确日期/相对日，未知保持歧义。时间索引支持 pre-1970；遗忘同时擦除实体键与事件时间，迟到索引新增同样需要 content guard。
- [RecallEngine](../src/memory/recall.ts) 在完整授权集合上做词法/实体/时间独立路径与 RRF，只公开读取明确选中 docIds，保守限制完整 payload 和 snippet。knowledge 增加授权文档精确批读，不用空查询误丢 graph/time-only 候选。
- [OnlinePipeline](../src/runtime/online.ts) 固定 router→recall→reflect→reply，最多3轮检索，未生成完整结果不进 outbox；近期窗口/证据在进入模型前累积持久来源闭包，引用子集不能缩小已输入依赖。单 job single-flight，保留 reply 的共享调用/token/时间，不新建预算绕开上限。
- 独立只读审查发现并修正源码问题：Zod optional 字段的 exactOptionalPropertyTypes 投影、规划空 timeRange 的格式修复/字面降级、去重引用及序列化摘要8192字节上限/实际 final framing 预留、正常输出超限的明确 failed 分类。测试初始时钟改为 Date.now 对齐，另有直接 phase deadline/累计 token 边界测试。
- 新增 retain/facts、recall、在线集成及索引擦除/快照测试**源码**，回读但全部未执行。没有依赖安装、类型检查、运行测试、QQ/模型网络、当前 profile 安装或权限修复；入口继续拒绝启用。详见[管线契约](pipelines.md)。

## goal round 6 中断与 2026-11-05 / goal round 7 恢复

- round 6 两个子任务中断，留下部分源码；round 7 先检查落盘文件再恢复，未把部分文件或失败执行当作完成/通过。
- [DerivedManager](../src/memory/derived.ts) 已补齐 dirtyRecorded/刷新修订原子记录、固定 observation/三个 mental 模板、按完整来源集合/epoch 和 world/experience 分 scope、原 retain 快照、独立证据计数、checkpoint 恢复、bank/scope 双重 CAS 与有限重算、遗忘后从剩余事实重建。
- [ProviderQuota](../src/runtime/quota.ts) 与 [WorkerLoop](../src/runtime/worker-loop.ts) 已编写滚动配额、在线容量保留、逐会话串行、独立后台池、heartbeat、未知外部操作跟踪、容量等待 defer、独立维护 lane 和停止清理。admitCall 在持久终身成本预留前，quota 等待不耗失败重试次数。
- [RuntimeSession](../src/runtime/session.ts) 组合上述组件，统一 root signal 到每个模型 worker 和 Outbox 的 live guard；新增只读状态、retryRetain 和限定来源/作者的内部遗忘方法。提供的 repo/Host 服务不被它关闭，Host 入口尚未挂载。
- [维护](../src/runtime/maintenance.ts) 与 [BankCoordinator](../src/memory/banks.ts) 删除尝试按批次全局限量、保留剩余 docIds，不提前 purged；完整 bank 枚举仍不是有界读取。未核验的 embedding 修复明确不可用/维护死信，不假称修复。
- 静态审查发现并修正：loop 自己故障时必须完成 session.stop 而非只 fence；BankCoordinator 的本地 deadline timers 在 stop 释放且不冒充远端取消；启动即使复用旧 revision 字符串也强制重核来源撤权，不能让旧后台任务绕过新允许列表。新增相应未执行回归源码。
- 新增派生、配额/loop、session 生命周期、跨 bank 分批遗忘、延迟费用、旧 epoch 刷新保留等测试，均只编写/回读，**仍全部未执行**。没有 native 命令、依赖安装、类型检查、真实网络、QQ 或当前 profile 安装。边界见[运行时说明](runtime-lifecycle.md)。

## 2026-11-05 / goal round 8–9

- 重新查询实际 Host Service/Config/Event 并读取安装包公共类型：Cordis4.0.5、storage/storage-domain0.2.1-rc.3、knowledge0.5.2。当前 knowledge Config entry 为 include:ui-knowledge，不能沿用旧 entry id。
- 发现并修正 P0 导入问题：SDK UNIT_NAME_RE 不允许连字符，两个 domain ID 改为下划线。旧开发名称从未部署，无静默数据迁移。
- 共享 storageDomain 不公开实际路由/磁盘位置，不能猜 cwd；已确认公开 DomainFacility 构造函数可使用插件独占 backend/显式 routes，不覆盖 Host 全局服务。[OwnedSqliteBackend](../src/storage/sqlite.ts) 实现插件私有目录内独立 control/ledger 文件、FULL 同步事务、未知状态隔离与仅自有句柄关闭，附未执行 native SQLite 测试。新增明确目录/私有权限环境前提配置及直接 storage peer；这不是已验证证明。
- Volatile.get 返回冻结配置本身，只有对象身份、无公开 version/订阅。[配置 reader](../src/runtime/reference.ts) 按快照身份缓存解析，用 boot-unique 无密钥 revision。观察通知现仅为可选清理，不充当权限。
- 所有后台 guard/queue/maintenance/Outbox 和 SDK 实际入口增加同步拉取 currentness；knowledge 实际 read/add/delete/provision 前重检，异步 ACL 后另有纯同步文档 validator，堵住 await→微任务撤权→效果调用的空隙。模型序列化、prepare、stream 前也同步重检；禁止仅靠 await authorize。
- [资源工厂](../src/runtime/bootstrap.ts) 使用公开 backend.register＋独立 DomainFacility，逐 await 复核并顺序关闭 session/domain/facility/backend/owner；ACTIVATION_VERIFIED 明确 false，Native Host 入口仍拒绝 enabled，未触碰真实 profile/QQ。
- 上述新增/更新测试全部未执行；两次子任务中断后按落盘状态恢复，未把失败当通过。命令环境未恢复，也没有再试 ACL 修复或绕过系统脚本策略。

## 2026-11-05 / goal round 10：命令环境恢复后的实际验证

- 用户切换 Full access，版本检查、仅工作区 pnpm install --ignore-scripts、锁文件生成、类型/构建均已实际执行。没有再次运行 ACL 修复或更改系统策略。
- 首次441项中28失败已逐类修复：专用SQLite owner需先短事务初始化自身header再持长排他事务；匿名伪QQ/时间戳断言、闭包集合顺序及epoch增量断言也已纠正，没有放弃安全检查。
- 原生双子进程排他/优雅释放/强杀后重获取、外来数据库不变、SQLite批量回滚和冷恢复均通过。6项平台/权限跳过明确记录。
- 召回重复全目录解析修成不可变metadata-only缓存，仍在每次使用核对当前配置/证明/owner/待删除闭包；130候选独立回归约202秒→1.60秒，并行全套约3.52秒，不承诺大库吞吐。
- 新增[Host controller](../src/runtime/host.ts)和真实Cordis入口加载/卸载测试；Native挂载源码使用依赖callback scope的一条顺序disposer。配置重建共享借用配额，session.stop不清零窗口。启用保护仍为false。
- 新增[真实knowledge隔离测试](../tests/knowledge-real.test.ts)：子进程导入前隔离DSH_HOME及所有cache/chunks；临时全持久域，真实公共API与本插件adapter跨三次上下文重开验证原文、marker、proactive-off、对账/授权读/删除。路由只在内存注册，没有HTTP listener，也没有OCR/模型调用。修正lexical-only文档pending状态的向量分类。
- **最新完整构建/测试457项，451通过、0失败、6跳过，退出0。** 详情及尚未完成矩阵见[验证记录](verification.md)。当前profile未安装、真实QQ/模型未连接，不宣称P6整体完成。

## 2026-11-05–06 / goal round 11–12

- 已观察B撤权而C抢先重新允许的旧epoch审计会继续落ledger，不因superseded丢弃；多来源/同revision身份、失败stop与不可授权的只撤权审计均回归。
- 完整Native DI＋临时control/ledger＋真实WS网关mock＋fake LLM＋真实knowledge已通过入站/字面发送确认/raw与experience/冷重开无补发；另用真实SQLite ledger busy验证owner保持隔离，GC不得意外解除。
- 新增真实loopback WS三项及[SnowLuma只读探测器](../scripts/probe-snowluma.mjs)/八项mock回归。用户扩展目标并提供安装目录、5099控制台；只读配置确认3001 forward WS。2026-11-06实际15秒连接身份verified、收到1个meta_event、无群/私聊事件；无真实QQ发送/模型/正文保存，配置未改。
- **最新完整构建472项，466通过、0失败、6跳过，退出0。** 更细证据及兼容边界见[验证记录](verification.md)。只读连接不等于已启用人格回复，release保护仍保留。

## 2026-11-06 / goal round 13–14

- 独立embedding修复已实现：durable attempt/SDK原始结算/unknown不重发/遗忘purged阻断，20项runner与7项adapter回归通过。真实rechunk/provider=none在当前Host同版本公共JSON backend通过；私有control/ledger仍为严格SQLite。真实reindex的undefined字段与自有严格JSON差异未掩盖。
- 根级已观察策略日志补齐启动无Session、关闭repo后owner未释的B→C；12项回归及真实Native backend.close后注入验证owner保持，不释放未审计历史。日志仅保留有限元数据；离线未观察历史仍非可还原承诺。
- 实际Native entry通过ctx.plugin/Volatile/依赖注入、loopback身份、公开status、卸载/服务撤销、backend撤销及owner重新获取，默认保持disabled。至此解除开发硬拒绝，未在当前profile安装或启用真实业务。
- **完整构建回归513项，507通过、0失败、6平台/权限跳过，退出0。**
- 首个pnpm包实际发现根锁文件被pack工具省略、合成测试key被凭据扫描命中，改为同字节分发锁快照与明确构造的测试值，未删安全测试。开发候选195文件已核验；临时独立home/profile完成真实CLI安装/合成/禁用加载/卸载。首次remove不支持ignore-scripts参数，已据实际日志修正并清理失败夹具。
- 正在为0.1.0生成最终归档/清单/校验并复核隔离安装；当前profile只读Inspect确认未安装本包。真实QQ发送/模型/embedding未授权，SnowLuma仅只读连接子集完成。

## 归档证据

最终0.1.0归档的资源/内容/SHA256及独立profile安装结果由包外随附清单/验证JSON给出，不在归档内循环嵌入自身hash。其它明确限制见[支持边界](open-issues.md)，不把未运行P7或平台跳过伪造为通过。

