# 入队、传输与知识适配（开发状态）

本页描述已编写源码的接口与边界，**不是运行测试报告**。当前[插件入口](../src/index.ts)尚未启动这些模块，仍明确拒绝 enabled=true。

## 可靠入队

[Ingress](../src/runtime/ingress.ts) 在已核验连接身份、allowlist 和当前配置 revision 之后解析人格及五路模型快照。先检查队列、收件箱字节及真实磁盘探测，再由一个 content-guarded 聚合提交写入 Message、Snapshot、RetainTask 和可选 ReplyJob。source/bank 的无正文元数据可先创建；正文提交失败不能留下半条消息、半个快照或孤立任务。

- 群普通消息只产生 retain；当前人格名称/别名或准确 @ 本机器人才产生回复 job。私聊必须在允许列表。
- 去重键由可信协议规范化生成，bodyHash 由宿主在脱敏前对**消息内容字段**计算，不对认证头或完整网络环境计算。相同键不同正文只保存有限 hash/计数冲突审计，不覆盖旧正文。
- 收件箱配额统计正文与保留事件 JSON 的 UTF-8 字节，不拿字符串长度冒充字节。容量检查在事务内重复，避免并发越限。
- 未知磁盘健康/低空间/写失败进入 paused 状态，并暴露已知丢弃计数；OneBot 正向 WS 没有业务 ACK 或可保证的背压，不能承诺上游补发。
- 即使上层忘记传 token 脱敏选项，入队前也重新规范化 allowlisted 事件投影并脱敏，保留合法 JSON；不把完整 JSON 序列化后用正则改坏结构。

[配置协调器](../src/runtime/configuration.ts) 将撤权先写独立 ledger，再更新配置/授权/绑定版本并取消未提交输出。等待协调时的新入站被拒绝，不用旧 revision 继续采集。重新允许打开新 epoch，旧任务和历史数据不自动复活；绑定切换也不改变旧消息的人格归属。

## Retain 任务

[RetainTaskQueue](../src/runtime/tasks.ts) 只负责持久任务控制，不自动创建 timer/模型请求：

- 全局按原快照并发上限领取；同 bank 派生任务串行，独立 raw 可以并行。
- 每次领取增加独立 leaseToken；即使同一个 owner 内租约过期重领，旧回包也不能保存 checkpoint/正文。
- 调用/格式修复先持久预留预算。attemptCalls 随新 attempt 清零，但累计 calls、reservedTokens、retryCount 和失败历史不清零。
- 初次失败后最多再试配置的次数；指数退避带抖动。dead-letter 的显式 host retry 保留原路由和历史；cancelled/遗忘任务不能直接复活。
- 在线拥塞时暂停领取新 retain；[本地配额、在线容量预留与 worker loop](runtime-lifecycle.md) 已挂载到Host入口，并通过隔离Native生命周期/运行验证；不表示已在当前profile启用。

## OneBot WS

[OneBotClient](../src/onebot/client.ts) 使用统一正向端点，Bearer 仅放请求头；不关 TLS 验证，不跟随重定向，不接受带凭据/query 的 URL。先 get_login_info 对账号，再允许事件和只读成员查询。echo 带连接代次和 UUID；旧连接不能完成新请求；断线不重放 send。

`prepareTextSend` 只准备 echo/epoch 和固定 text 消息；`submit()` 必须在共享提交屏障内同步进入 socket.send，网络回包在屏障外等待。完整 action/params/echo 的 JSON UTF-8 字节受限，不能只计分段正文。

unknown 不自动变回 prepared。迟到可靠回包仅在同一仍有效连接、有限条数及 TTL 内提供 metadata callback；原 completion Promise 仍是 unknown。**outbox 持久化必须单调处理**：晚到 succeeded/failed 可能早于旧 unknown 回调写库，旧 unknown 不得覆盖已确认结果。[Outbox](../src/runtime/outbox.ts) 已编写 prepare/send/late-confirmation 协议和确认 experience 入队，已挂载到入口/worker loop并通过真实WS loopback确认及experience测试；不能据此声明真实QQ发送已授权或验证。

成员固定查询带 no_cache:true，严格比对机器人连接、group_id 和 user_id；网关不支持或无法确认时不授权。真实网关是否遵守 no_cache 和远程成员竞态仍需单独联调。

## Knowledge 0.5.2

[KnowledgeAdapter](../src/memory/knowledge.ts) 只使用公开服务方法，不 import 其运行时实现、不调用 HTTP、不打开内部 DB：

- bank 采用 exact namespace/marker + 全量 listBases 对账；新空库原子携带 autoRetrieve=false、injectUsagePrompt=false、autoRetrieveWeight=0 并读回核验后才可导入正文。既有不安全库拒绝，不擅自改其它库或全局工具设置。
- 标题、首行恢复头、规范化正文和来源闭包一起做确定性校验。hash 排除恢复标记/自身字段，UTF-8 编码与 LF 规范化明确；模型正文里的伪标记不会成为恢复头。
- 追加前、异常后都通过完整 listDocuments 精确对账，不用 semantic TopK。相同 marker 不同 hash 阻断；完全相同副本选 code-unit 排序的 canonical docId，其余返回孤儿清理列表。
- 正文已保存、embedding 报错时复用可读正文，不盲目二次追加；文本和 vectorState 分开。
- 首版默认只对显式授权非空 docIds 公开读取并本地词法排序，包含 CJK bigrams。空集合零服务调用；不进行全库候选、外部 rerank、embedding 查询或隐藏聊天模型。此路径明确标 local-lexical，不宣称 hybrid。
- 所有异步边界复核 host guard，读取后再次校验 memoryId/version/hash/来源是否仍是当前授权有效版本。适配器自身不负责计算 ACL，运行时调用者必须提供校验回调。
- 原始 addTextDocument Promise settlement 可观察，只含 metadata；它不等于远端工作已终止。父协调器必须先持久登记在途 intent/不确定性，并在确认对账与清理收敛后才释放 settled registry。

[BankCoordinator](../src/memory/banks.ts) 已编写持久 WriteIntent、版本激活/CAS、精确对账、独立清理和保守物理遗忘流程，边界见[协调说明](bank-coordination.md)。[LivePolicy](../src/policy/live.ts) 已连接实时成员证明、候选/文档授权和近期窗口，并支持强制发送前新查询。[retain/召回/固定在线管线](pipelines.md)、[派生/调度与生命周期组合](runtime-lifecycle.md)及受保护Host挂载源码已补充，隔离Native启用/关闭、原生故障及公开向量修复边界已有验证；真实供应商与QQ发送不由这些测试替代。

## 验证状态

协议/WS、knowledge、入队、任务、配置/权限/仓储等现已实际运行，含原生双进程锁、Cordis Native入口、根观察交接及隔离真实knowledge API，最新分层结果见[验证记录](verification.md)。隔离profile已验证默认禁用安装/卸载；真实模型/embedding/rerank/QQ发送未授权，不因测试通过而自行开启。命令权限由用户恢复，未绕过系统执行策略。
