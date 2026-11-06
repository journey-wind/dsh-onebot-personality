# 控制平面与恢复边界（开发实现，未执行验证）

本页说明当前[数据模型](../src/storage/model.ts)、[仓储与提交屏障](../src/storage/repository.ts)、[持久域适配](../src/storage/domains.ts)、[进程所有权](../src/storage/owner.ts)的设计及尚待验证项。不是完整功能或生产验收声明。

## 本地原子提交

宿主 `storageDomain` 只保证单记录写入的持久性，不提供跨表事务或跨进程 CAS。本插件以一个 schema 校验的 global 聚合状态记录提交消息、快照、retain 任务和可选 reply。每次复制状态、执行同步修改、复核 owner/来源/依赖并校验关系，再调用一次 global.set；成功前不发布新的内存快照，失败则暂停仓储。

这牺牲了大数据量写入效率：聚合状态会重复序列化，尚无吞吐量或最大容量实测。配置中的默认配额是上限建议，不是性能承诺。不能把测试里的 FaultCell 内存模拟用到生产。

正文写入必须有 content guard，包含 bot、persona、来源代次、所有原始消息和依赖版本；新入站消息只在提交前允许缺席，提交后必须存在。metadata guard 不得新增消息/任务/快照/正文、改变正文或激活记忆。仓储检查新增输出至少继承本次全部输入闭包。源撤权必须经删除/撤权日志，不允许通过普通元数据事务悄悄改 allowed。

## 排他 owner

采用**插件自己拥有的独立 SQLite 锁文件**，不打开 knowledge 内部数据库。私有连接在 DELETE journal mode 下持有 BEGIN EXCLUSIVE；第二个同路径连接应立即拒绝，正常关闭释放。随机 ownerId 是身份，不是 fence；单调 ownerFence 保存在控制状态，每次新 owner 启动增加。

要求：

- 所有共享同一控制域的进程必须使用同一规范化锁路径。更换锁路径会变成另一个锁，不能跨不同路径保证排他。
- 锁路径必须位于可信的本地文件系统；禁止 symlink/junction、硬链接、非普通文件和可疑 sidecar。网络盘/文件系统可靠性不能由 Node 路径检查证明。
- Windows 的 mode0600/0700 不等于 Windows 文件权限验证。管理员需事先提供私有父目录；代码不修改既有 Windows 文件权限、文件所有者或已有文件模式。
- 不得用其他描述符单独打开/关闭持锁文件，以免影响 POSIX 进程级文件锁。
- 顺序必须是：取 owner → 开域/恢复 → 运行；卸载时先停止入口/worker、取消外部计算、排空仓储提交并失效 fence、关闭域，最后释放 owner。不能先释放锁再等待旧写入。

[owner 测试](../tests/owner.test.ts)目前只编写连接级测试，**未执行**。独立进程竞争、强杀后重启和 Windows 文件系统测试仍待实现/执行；不得仅凭代码宣称崩溃排他已验证。

## 删除日志与 tombstone

删除/撤权日志存入不同的持久域，只有最小标识、代次、操作 ID、单调序号与 hash chain，无消息正文。请求首先进入共享屏障并逻辑阻断，持久写 ledger，再投影控制状态。后半步失败时保持阻断，下一次启动先重放 ledger，再开放读取。

遗忘投影会清除收件箱正文及事件 JSON、事实 checkpoint、记忆/WriteIntent 正文、实体/事件时间索引和 outbox 正文，取消受影响任务，失效派生、指针及未提交输出。已在途发送变为 unknown，不伪称未发送。未收敛的外部知识写入保持 unknown，不因枚举暂时找不到文档而宣告 purged。

purged 至少要求：完整对账证明、不含正文的可信 ledger 水位、pending docIds 为空、所有相关外部写入非 in-flight/unknown、本地副本已清除。[BankCoordinator](../src/memory/banks.ts) 已挂载完整owned-bank枚举、清理及证明提交逻辑，并通过故障/隔离公共knowledge验证；外部写不确定时即使文档已删除也保持阻断，不能据源码或 mock 测试报告实际物理清除已完成。

## 共享发送屏障

`commitAndSubmit` 把最后本地复核、durable sending intent 和**同步提交**固定网络调用串在同一屏障内；只返回网络 completion Promise，屏障不等回包。transport 的 start 回调必须在返回 Promise 前真正提交，不能在内部先 await 或延迟入另一个队列。后续分段逐段走此流程。

[Outbox](../src/runtime/outbox.ts) 已挂载该屏障和固定WS prepared send，Native/worker loop隔离路径受测。成员资格远程查询与实际 QQ 发送仍不是原子事务。已发给 LLM 或已提交 QQ 的内容无法事后撤回。

## 恢复

- retain 旧 owner/过期运行任务从 checkpoint 进入 retry，保留累计调用和重试次数。
- pending/generating/prepared 在线回复默认取消，不重启补发。
- sending 分段重启转 unknown，禁止自动重发；已成功段不再发。
- 遗忘先恢复阻断，旧 owner 的迟到正文不能凭原 guard 落库。
- 未知 schema、断裂 ledger hash/watermark、回滚的删除日志均拒绝开放。

**不支持直接开放旧备份恢复。** 两个域使用不同名称并不意味着 ledger 独立保全；如果正文和 ledger 被整体回滚，代码无法证明最新删除水位。当前显式 restoreMode 一律拒绝，等待真实独立最新 ledger 的外部保全机制；管理员点击确认不是替代证据。绕过恢复流程直接回滚底层文件属于不受保证的管理员操作。

## 未完成验证

[仓储故障注入测试](../tests/repository.test.ts)和[权限矩阵测试](../tests/policy-scope.test.ts)均为已编写、未执行。实际 storageDomain 后端路由、持久性、双进程和 knowledge 服务集成尚未验收。入口保持禁用；这些模块未被当前插件入口启动。
