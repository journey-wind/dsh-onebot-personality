# Retain、召回与固定在线管线（开发状态）

本页对应已编写的[RetainWorker](../src/memory/retain.ts)、[事实校验](../src/memory/facts.ts)、[RecallEngine](../src/memory/recall.ts)和[OnlinePipeline](../src/runtime/online.ts)。均只有源码回读与 mock 测试源码，**没有执行构建/测试，也没有挂载入口**。

## Retain

- 一个已领取的消息/成功分段任务使用原入站快照的 retain 槽位；不创建 Agent，不改用 reflect/reply 或前端会话模型。
- 先把原始证据经 BankCoordinator 写入 knowledge 并激活，再抽取。用户第一人称仍是 world 报告；只有可靠成功的机器人分段是 experience。
- 原始与事实版本采用固定 task-based operation identity。已校验 facts 先存 checkpoint，知识写失败重试不重新抽取；下游 derived dirty hook 必须持久成功，任务才可 done。
- schema/语义失败最多一次同 retain 格式修复；每次 dispatch 前持久预留调用及累计 token，旧租约、遗忘、停止信号和输入身份在异步边界复查。
- quote 必须为原文精确非空子串。QQ 实体只能用宿主已知作者/明确协议 @ 的数字 ID，不把昵称合并到 QQ；不确定标签按消息/分段及来源代次生成宿主键，不自动跨消息、跨群合并。
- 单条原文不提供独立交叉验证，不能自称 corroborated。多来源佐证应由后续派生器按宿主去重计数。
- 可核验严格 YYYY-MM-DD 及今天/昨天/明天（原消息事件时间＋快照 IANA 时区），允许 pre-1970 事件时间。接收/创建时间仍非负，不能拿它替代事实事件时间。
- 不支持/有歧义的表达保留原文、不编造时间；机器人经验没有可靠发送时刻时不假用用户时间。DST 不存在/重复午夜不随意选择。

以上仅保证来源、格式和引文约束，**不等于自动证明自然语言事实/关系为真**；内容可能是用户报告、争议或推断。原始引文始终保留供复核。

## 召回

模型只能输出文本查询、实体候选和有界时间范围，不能选择 bank/文档或扩大 scope。RecallEngine 不调用任何聊天模型：

1. 建立实时 scope、过滤完整授权 metadata 集合，再读取本地正文/实体/时间字段。
2. 最多100个 corpus 文档时走公开 `readAuthorizedDocuments`；更大 corpus 对**完整授权集合**的本地 text 索引做 hash 校验后词法排序，再公开读取最多100个选中项。不以任意前100条代替完整候选。
3. 实体路径只处理授权记录的精确实体键及有界共现一跳；时间路径只用核验的 eventStart/eventEnd，未知时间不冒充 createdAt。
4. 词法/实体/时间是独立 RRF 票；按 memoryId＋version 去重，不把同一个 hybrid 列表伪造为多个语义路径。
5. 正文通过当前 doc/header/hash/version/provenance 检查，完整异步边界重新授权。空集合零知识调用，不用 undefined docIds 搜全库。
6. 模型证据 payload（正文、元数据、完整闭包）按 UTF-8 bytes 保守计入最多4096的默认预算。可返回标明精确起止位置的 quote snippet，或整项省略；不把截断内容伪称全文。

当前标记明确为 local-lexical，不宣称 native Hindsight/semantic 等价。保护边界：corpus最多20k、完整本地扫描最多64Mi UTF-16字符；超限或大 corpus 缺完整本地索引会失败/降级，不偷偷漏扫或扩大授权。持久索引容量、重建和真实性能仍待运行验收。

## 在线固定阶段图

- 当前完整规范化消息与授权近期窗口先进入 router；chat 直接 reply，recall 走规划/检索/整理，reflect 最多3轮（含首次），每轮规划和整理仍调用 recall 槽位。
- reflect 只给可核查的摘要、引用及缺证问题，不输出隐藏思维链，也不直接转发为 QQ 回复。
- router 质量失败降级 recall；规划失败使用当前消息的有界字面查询；整理/reflect 质量失败保留合法原始证据。权限、版本、成员、存储/所有权失败不是普通质量降级。
- 所有模型输入先把来源闭包加入持久 ReplyJob。引用列表只是输出引用，不能缩小全部已输入来源；已有近期机器人文本也继承完整依赖。
- 一个共享 CallBudget 覆盖所有阶段及修复，保留 reply 调用、估算 token 和时间；更紧的阶段 deadline 不新建/重置累计预算。摘要先规范化/去重引用，实际序列化 synthesis 最多8192字节，再按完整 final framing＋证据＋摘要上界预留，不能只看字符数而漏算 JSON 转义。
- 完整 stop 的纯文本 reply 才能进入 Outbox。超时、max-tokens、不完整和虚假规范引用不发送半成品，也不自动换另一模型。当前消息不通过截断冒充容纳成功。
- 同 job 调用 single-flight；已 generating/prepared/terminal 的 job 不自动重放。实际入队到执行的整个在线时限包含排队。

## 生命周期与待接入事项

组合层必须把同一个停止信号放进模型阶段和 Outbox.authorizeReply 的 `validateLive`，不能仅中断在线函数却让发送器继续提交。每段仍须 forced membership＋共享提交屏障，已提交网络不可撤回。

[派生、worker/限流、生命周期组合和维护批次](runtime-lifecycle.md)已补充源码，统一信号与停止资源清理也有未执行回归。仍待 Host 入口/配置观察实际绑定、真实持久域与知识兼容证明、向量修复适配、构建及隔离安装。RetainWorker 不自建 timer 或领取循环，不能据这些类存在宣称后台服务已经启动。
