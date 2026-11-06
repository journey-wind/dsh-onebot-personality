# P0 兼容性核验（只读，尚未验收）

本页保留2026-11-04最初只读基线；2026-11-05已恢复命令环境并完成编译、原生锁、真实Cordis及隔离knowledge文本测试，最新结果见[实际验证记录](verification.md)，下表旧“待验证”不应覆盖该记录。基线：[实施计划v2原始参考](implementation-plan-v2.md)。

## 核验方法与限制

已调用 `cordis_inspect_list` 并定向查询 Host `Service.listService` 的 `llm`、`storageDomain`、`storage`、`agentDefaultModel`。已查询 `Config.listConfigs` 的相关 entries 并只读阅读其 package README、公开声明和安装产物。

- DSH checkout 元数据：0.2.1-rc.3；Cordis 4.0.5；Schemastery 3.18.5。
- `knowledge` **未收录在 Service Inspect catalog**；这不证明服务未运行。最初 Config entry 为 include:knowledge，2026-11-05重查为 include:ui-knowledge；包仍为dsh-knowledge0.5.2，公开服务子路径为dsh-knowledge/knowledge，不能混淆 entry/module/Service。该服务必须以其公开类型、运行特性检测与隔离集成验证共同适配，不能编造 Inspect 已通过。
- 当前受限命令在工作区权限配置阶段失败；已授权诊断脚本又被系统执行策略禁止，未执行。未运行 shell、模型请求、knowledge 写入或 profile 安装。以下“只读观察”**不等于实际服务集成通过**。

## 核验表

| 能力 | 只读观察 | 尚待验证/处理 |
|---|---|---|
| 插件生命周期 | Cordis 接受 Standard Schema；Schemastery 提供本机自动表单、`volatile()`、secret role；domain handle 由调用者关闭 | 实际隔离挂载、卸载、表单和图标渲染未运行 |
| `llm` | `prepareCall` 捕获注册代次；`resolveCallConfig` 校验 effort；`GenerateOptions` 支持 maxTokens/signal；无 Agent 必要 | 输出上限是传给 adapter 的参数，不能单凭签名证明远程供应商强制执行；需实际 adapter 测试 |
| 默认模型 | `agentDefaultModel.currentSelection()` 返回具体 provider/model/effort | 未读取或调用真实默认路由，不消耗模型额度 |
| knowledge 建库 | `createBase({name, description, config})`，`listBases()` 返回完整数组 | 创建时传 `autoRetrieve:false, injectUsagePrompt:false, autoRetrieveWeight:0`；读回验证后才准许导入 |
| knowledge 精确枚举 | `listDocuments(baseId)` 为完整数组，不是有隐藏 TopK 的搜索；`getDocument`/`readDocumentText` 可读正文 | 适配器可在完整数组上本地分页；大库枚举成本需报告；隔离写入对账测试未运行 |
| 搜索候选过滤 | 安装产物 searchSingle 先 resolveSearchFilter，再把 filter 传入 vector/lexical lanes；内存路径先按 docIds 过滤再 rank；`[]` 明确返回空 | 尚须读完 SQL lane、rerank 和上下文扩展并做秘密标记测试；未证明前默认仅公开读取授权文档的本地词法路径，不冒称 hybrid 已验证 |
| 空候选 | 公开声明及安装产物明确 `filter.docIds: []` 匹配零文档，省略则不限制 | 插件仍统一空集合短路，不调用 knowledge 搜索 |
| 向量状态 | 文档摘要有 embedded/status/embeddingError；正文、向量状态分离可表达 | 注入 embedding 失败，确认正文仍能读到；不能观察时标 unknown |
| 域持久性 | domain 单记录写 durable 后才更新内存；没有跨记录事务；单进程 open 排他；SQLite/JSON 后端都不提供跨进程 CAS | 本地事务拟采用单一聚合控制状态记录的短提交；另行实现插件拥有的跨进程排他所有权，不能用内存锁冒充 |
| JSON 后端限制 | Windows rename 无显式 write-through；per-record 批删持久性较弱；无跨进程锁 | 不在未验证后端上启用；优先限定已核验持久后端，失败 fail closed |
| SQLite 后端限制 | 单条语句原子写，batch 删除事务；`:memory:` 非持久；无跨进程协调 | 必须排除 memory 路由；所有权排他单独解决，不直接打开 knowledge 内部 DB |
| schema 迁移 | 域版本不同默认拒绝打开 | 不修改宿主；插件 schema 使用内部版本及可恢复迁移；未知新版本阻断 |
| generic 工具排除 | knowledge 公开 `getEnabledBaseIds/setEnabledBaseIds/enabledScope`；文档说明按全局 enabled bases 限定工具和自动检索 | 这不是 per-caller ACL；插件不自动改全局选择。管理员可显式选择不含人格 bank 的其它库，但之后新库/全库选择仍需审查 |

## 已检查的公开契约

### LLM

- `prepareCall(config, signal?, configure?)` 返回 config、可选 context、注册绑定 stream。
- `resolveCallConfig(config, signal?)` 不静默改路由；插件仍复查 provider/model/maxTokens。
- `stream` 输出 `text-delta`、`block-end`、`finish` 等；只有 stop 完整输出可发送，max-tokens/error/aborted 禁止发送。
- `purpose` 仅接受 compaction/session-title；本插件不伪填其他 purpose，不创建 session 或工具 Agent。

### Knowledge 0.5.2

- `whenReady(): Promise<void>`。
- `listBases(): BaseSummary[]`；`createBase(request)`；`getConfigFor(baseId)`；`renameBase(id, request)`。
- `listDocuments(baseId): DocumentSummary[]`；`addTextDocument({baseId,title,content})`；`deleteDocument(id, options?)`。
- `getDocument(id,{includeChunks?,rawTextLimit?})`；`readDocumentText(id,charStart?,charEnd?)`。
- `search({query,baseId,filter:{docIds},topK,mode}, {signal?,deadlineAt?,rerank?})`。

这些是安装包公开声明里的契约，不是将 Inspect provider 当作业务 API，也不调用 HTTP 管理端点或读内部数据库。

## 运行开关

在 P0 的排他所有权、原子恢复、proactive 关闭和安全读取路径实际证明之前，插件只能以禁用/blocked 状态提供配置和状态，不连接 OneBot。当前入口额外拒绝 enabled 开发骨架，避免把尚未完成的实现投入真实 QQ。

## 待执行验收

1. 安装工作区开发依赖，生成真实锁文件，类型检查和全部 mock 测试。
2. 在隔离临时数据域验证 domain 原子提交、写失败、进程竞争和重启恢复。
3. 使用实际 knowledge 服务临时库验证枚举、marker、正文可读、embedding 失败及授权秘密不泄漏；完成后清除测试库。
4. 在隔离 profile 验证包安装/卸载、原生表单、secret 脱敏和图标；**不安装当前 profile**。
5. 真实模型/embedding/rerank/QQ 均另列状态，不以 mock 替代。真实 QQ 需用户明确提供配置并确认 AstrBot 不重复回复。
