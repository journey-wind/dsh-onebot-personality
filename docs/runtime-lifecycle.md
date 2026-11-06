# 派生、调度与运行时生命周期（开发源码）

已编写[派生刷新](../src/memory/derived.ts)、[供应商配额](../src/runtime/quota.ts)、[worker loop](../src/runtime/worker-loop.ts)、[维护 lane](../src/runtime/maintenance.ts)和[运行时组合](../src/runtime/session.ts)，并补充 mock/故障测试。现已实际构建/执行，原生 Cordis 默认禁用入口及控制器也已测试；完整结果见[验证记录](verification.md)。**默认仍禁用，不是当前profile已启用服务；真实QQ发送/模型需另行授权，不能把隔离测试当已部署。**

## 派生刷新

- 用户 world 与机器人 experience 分家，scope 为完整 sourceRef 集合＋epoch，不只挑一个来源或昵称。
- Retain 的 dirtyRecorded 与刷新修订在同一事务提交；重复回调不重复加证据。raw ID 不计事实阈值；后续 checkpoint 保留该标记。
- observation 与稳定偏好、关系背景、未完成事项三个固定模板。默认新增10事实立即到期，否则60秒防抖，原始首次 dirty 起最多等5分钟；只影响对应 scope。
- 原快照 retain 槽位生成，绝不调用聊天 recall/reflect。输入只取合法事实，重算不把同身份旧摘要再喂模型，防止 self-dependency/摘要洗白。
- 输入的 own-version 与全部传递闭包先落任务；补充输入只能做 union，不丢先前模型已使用来源。模型建议引用须精确匹配，独立 proofCount 由宿主按原证据、作者与去重原话保守计算，机器人复述/同作者复制不构成独立 world 佐证。
- 输出先 checkpoint，普通重试/冷恢复不重跑模型；bank revision 与 scope dirty revision 在激活屏障复核。单 run 最多两次生成，修复/重算仍受原任务调用及累计成本上限约束。
- 遗忘先 ledger 投影，再从剩余合法事实重新生成；不在旧摘要删几个引用。整个旧 epoch 没合法事实时不重开。

限制：选择器使用有界最新任务/事实窗口（最多20k任务目录、10k匹配扫描、64事实，且受原 evidence budget 约束）。这不是全历史穷尽摘要，更不证明自然语言总结必然为真。原始证据保留供独立召回；大数据量效果和性能仍待验收。

## 本地配额

ProviderQuota 只计本插件向已注册 provider ID 的调用预留，不存正文、凭据、URL或模型输出。注册/解析由上游路由核验，不能传模型自选 endpoint。

滚动60秒：online 配置作为合并上限；retain 另受自身配置与合并容量一半的较小值约束，给在线保留容量。活实例内修改限额或 model 不清零旧窗口；临时不足返回可再试时刻，单请求永远放不下则明确 quota-request-exceeds-window。

admitCall 在后台任务持久调用/token 预留之前。仅容量等待经 queue.defer 不消耗失败重试次数/任务终身调用成本；真正 dispatch 前仍持久 reserveCall，格式修复一样计费。

Native Host controller 的配置重建会借用同一个 ProviderQuota，session.stop 不关闭/清零借用计数，已由跨两次 session 的实测验证。它仍不是供应商账单、跨进程/别名或其它插件的全局限流；整个插件/dependency scope 重建或进程重启的内存窗口不保证连续，需要跨重启严格计账时须另加持久预算。任务自身累计成本在控制库保留，不因手动 retry 清零。

## Worker loop

- 显式 start 才调度；同 bot/人格/会话只占一个在线槽，持有到完整 Outbox completion，跨会话用在线并发池。
- 不重放 generating/prepared/sending；过期 pending 交在线管线取消。后台池独立；在线有压力时暂停新 retain 领取，原快照并发与同 bank 派生串行仍由持久队列核对。
- 默认120秒 lease、30秒 heartbeat。旧 lease/owner 回包不能保存正文；已失效但未结算的外部工作仍占本地槽，不伪称取消。
- 只管理自己的 timer 和 promise；enqueue/维护独立退避，不消耗 retain 模型重试。停止不等待可能永不返回的供应商请求。

## RuntimeSession 组合与所有权

构造只创建惰性组件；显式 start 才核对状态并启动已配置的客户端/调度。禁用配置不启动连接、模型或 worker timer。当前 Cordis 公共 Volatile 只有同步 get，返回递归只读配置快照本身，没有公开 version/subscribe/precommit；不能虚构同步通知。组合层现以快照对象身份及 boot-unique revision 作为每次敏感操作的即时拉取条件，同时检查公开 fiber 活性。通知只作可选清理提示，poll/postevent 不能授权读取、模型或发送。

启动会重新核对当前来源，即使 bootstrap-local revision 字符串恰与旧控制库相同，也不能跳过撤权。已变更/移除的来源先ledger阻断，再开放任何后台工作。对已观察到的B撤权，会在abort处理前同步捕获当时epoch，排队仅撤权审计；即使最新配置已变成C，superseded也不取消该审计、不授予权限。stop排空所有已排审计后才允许释放owner。

停止信号同时覆盖 Online、Retain、Derived 及 Outbox 的 live guard。外部停止、配置变化或 loop 自身故障均先同步 fence，再完成一次幂等 session.stop：

1. abort root、停止新任务/配额、dispose 本 session 工厂创建的客户端；
2. 清除本 session 配置订阅和 loop timer；
3. BankCoordinator 取消全部本地 deadline timer 并拒绝本地等待者，但保留真实外部操作观测；在控制库持久标 unknown/需对账；
4. 排空已观察撤权的本地ledger审计；失败则保持owner隔离且强引用，不能靠GC解锁。此本地收敛不同于无取消能力的远端写，后者不无限等待，也不承诺撤回已提交QQ/模型数据。

组合器**不关闭注入的 repository、owner/domain handles 或 Host LLM/knowledge 服务**。Host bootstrap 必须先 await session.stop，再关闭自己拥有的存储/锁，并保留 ledger；不能误关共享服务。

内部管理方法：getStatus、retryRetain、forgetBySource、forgetByAuthor（须明确 botId/personalityId/qqId）及 getForgetStatus。不是 QQ 命令，不自动注册成模型 Tool。遗忘返回 durable 逻辑阻断状态，不承诺立即物理 purged。

状态只返回连接/队列/银行/向量失败/unknown 数量和固定错误码；协议拒绝事件数与 ingress 丢弃数不是去重后的实际消息总数。正向 WS 不提供重放保证，断线损失仍可能未知。

## 维护与未完成验收

每次维护限制全局删除尝试数（包括多个 bank），剩余 docIds 持久保留，分批未完不加失败次数、不提前 purged。原始完整 owned-bank integrity 枚举仍会扫描全库；该限制**不等于枚举耗时/读取次数上限**，容量和性能须实测。

[独立向量修复](embedding-repair.md)已接入公开rechunk及原始SDK结算追踪，unknown参与purged阻断，不重跑正文追加；缺少公开能力明确unsupported，文本词法仍可用。真实向量供应商未授权验证。

已新增[私有 SQLite 后端](owned-storage.md)、公开独立 DomainFacility 的资源工厂与直接快照 reader 源码。原连字符 domain IDs 不符合 SDK UNIT_NAME_RE，已改成下划线名称；之前从未部署，不自动迁移任何旧文件。Host effect/controller 挂载源码、类型/构建、原生 SQLite/双进程排他及强杀后释放、隔离真实 knowledge 文本冷恢复已完成对应测试。完整隔离Native DI、[根级观察交接](configuration-observations.md)、真实close-tail owner保持及Native entry启用/卸载已验证。预构建开发候选及隔离安装流程已通过，最终清单另附；全部物理丢电排列及离线未观察历史不在支持声明内。[当前入口](../src/index.ts)已解除开发硬拒绝但默认disabled，未安装当前profile、未启动替代Web服务。另已授权进行SnowLuma只读登录/元事件探测；没有真实QQ发送或模型调用。
