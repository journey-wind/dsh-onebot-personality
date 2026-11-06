# Bank、版本与物理遗忘协调（源码实现）

[BankCoordinator](../src/memory/banks.ts) 与[对应测试](../tests/banks.test.ts)已实际构建/运行；公共knowledge adapter也已通过隔离真实服务的文本冷恢复。当前[入口](../src/index.ts)已有受保护挂载源码，但启用验收尚未完成；详见[验证记录](verification.md)，不据单元测试宣称整套部署通过。

## 创建与并发

- bankKey 来自 bot＋稳定人格 ID，provisionMarker 由入队先持久保存，不使用显示名。
- 同进程首建请求 single-flight；正文写入每个 intent 也 single-flight。全局跨进程排他仍由独立 owner 锁保证，不能拿 Map 冒充持久排他。
- unmapped 可记录 provisioning 后创建空库；未知旧 provisioning 只能 exact reconcile，未找到也不盲目再建。多候选/namespace/proactive 冲突阻断，不修改别人的库。
- knowledge 调用不占仓储提交屏障；所有正文计划/激活以原 worker/content guard 核对 owner、租约、来源代次和依赖。

## WriteIntent 和版本

`planVersion` 同时保存不可见的新版本和持久 WriteIntent，包含 canonical hash、恢复 marker、完整来源闭包、owner fence、预期有效版本以及派生输入的 bank revision。建议调用者用 `memoryIdFor` 生成 bank-scoped 稳定 ID；跨 bank 重用全局 memoryId 明确拒绝。

`writeVersion` 在登记 in-flight 意图后才调用公开知识适配器。实际完整操作注册在调用之前，超时不会销毁其观察关系。正文可读且 marker/hash 一致才记录 docId/text_saved；向量状态单独保存。正文后、本地 docId 记录前崩溃，重启使用持久原文/hash 精确对账，不重新跑模型生成不同“同一版本”。

`activate` 使用短事务检查当前来源/依赖、预期指针及派生 bank revision，再切换有效指针、退出旧版本、增加 bank revision。CAS 失败不覆盖旧有效版本；失败版本失效并进入独立清理队列，调用者须用原 retain 模型快照重新取证/有限重算。旧 superseded plan 禁止重新追加或激活。

## 已知文本与外部不确定性分离

找到完整匹配的文本，可以复用该 docId，并在合法 guard 下激活单一有效指针；**这不证明旧外部请求已经终止**。此前 unknown/in-flight 标记不会因为“查到了”或“查不到”自动变为 settled。重复文本只进入一个有效指针，其余独立清理。

正常适配操作完整返回并通过正文对账后，可登记完成。若请求超时、旧 owner 消失、底层操作拒绝或授权在回包前失效，无法证明完成时保持 unknown。JS 原始 Promise settlement 只是观测，不是任意远端终止证明；默认实现不提供“管理员点击确认就消除 unknown”的捷径。

因此某些异常可以做到**物理文档已经删除，但状态仍 blocked/purging**。这是有意保守的安全边界，而不是已实现所有异常自动恢复。维护重试与 retain 重试分离；持续不确定会退避并进入维护 dead-letter，不能宣称 purged。

## 完整对账与清理

- `reconcileBank` 只访问持久映射到本插件 namespace/marker 的 bank，完整枚举并核对每个插件文档。冲突 hash、缺失 active doc 等暂停该 bank。
- 已有 active canonical doc 不因为新重复副本排序更小而悄悄改指针；重复/孤儿文档进入清理队列。正在 active 的 docId 不允许被清理。
- 物理清理使用 owner-only maintenance guard，不用已失效的旧 source ACL，也不把忘记的正文重新保存进 checkpoint。
- 清理只读取插件文档正文做本地 integrity 验证，对协调器只返回 header/hash/docId/vectorState；明显外来标题不读正文、不删。
- malformed/truncated/不完整闭包的插件文档拒绝完整性证明，保持阻断，不假设它无关。

## 遗忘

先经仓储 `recordDeletion` 持久 ledger/tombstone 并擦除本地副本；`purgeForget` 随后扫描所有该实例映射的插件 bank，包括旧版本及未登记孤儿，按完整 header provenance 删除受影响文档，再完整复查。

仅当已登记写入没有 in-flight/unknown、本地敏感副本不存在、完整对账无受影响文档，才提交 purged。发现的新 docIds 在删除前持久登记；删除错误进入独立维护重试。迟到模型/知识回包只能留下 metadata，不能恢复被遗忘的正文/经验。已收敛的 adapter settlement metadata 才可释放。

不保证 QQ 已发送内容、供应商留存、备份或本机管理员复制也被抹除。旧备份开放恢复仍需独立可信最新 deletion ledger，见[存储安全边界](storage-safety.md)。

## 尚未完成

已补充全局删除批次上限、剩余 docIds 持久记录、scope/generatedAt 元数据、停止时本地 deadline timer 清理及[派生/调度组合](runtime-lifecycle.md)源码。完整 bank 枚举仍不保证有界读取；真实 storageDomain/knowledge 故障注入、跨进程锁/强杀恢复、控制状态容量与性能、Host 挂载、隔离安装与预构建包尚未验收或接入。当前只有 mock/故障测试**源码**，不可将它们作为通过证据。
