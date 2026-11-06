# 启动、停止交接时已观察撤权的保全

## 被发现的问题

只有active Session接收配置通知不够。实际资源工厂尚未返回Session时已读取撤权B并拒绝旧A启动，若下一次启动前配置重新允许为C，拒绝本身没有把B写入ledger。另一个窗口是旧repository已关闭但owner尚在释放：向已停止Session再追加审计，原stop Promise不会自动重新排空。

这些是真实交接边界，不可用“每次读取最新配置”代替历史撤权审计。这些窗口已通过对应源码回归及真实Native关闭路径验证；它们曾是保留开发启用保护的原因，验证后才解除硬拒绝。

## 当前实现

[根观察日志](../src/runtime/observations.ts)由Native entry生命周期持有，跨依赖scope内的HostController替换保留。所有实际成功配置拉取都同步观察，而不只在active Session存在时观察。保留内容只含expectedSelfId、人格ID集合、群/私聊允许列表和无凭据revision；不含token、URL、模型、提示或正文。

- 连续同一source-policy投影去重；模型/token变化不增加策略历史。冻结且相关策略容器也不可变时，WeakRef身份/revision缓存避免每次SDK guard重解析；可变/浅冻结策略不能走缓存。
- 对每个规范store key保留独立ACK游标。新Session启动任何worker/连接前，依次把尚未落库的历史策略对当前来源旧epoch实施仅撤权，不授予访问、不更新有效指针或当前Config revision。
- 每个策略先同步捕获目标epoch，再等待ledger提交。期间看到的新策略继续排空；ACK后才推进游标，避免B在之后C的新epoch上被重复应用。
- 关闭时在repository关闭前再次flush；若其后又观察到新策略，释放owner前的同步assertFlushed必须拒绝。保留owner/阻断替换，不把关闭成功当审计成功。
- 已停止Session不再向关闭中的库排队；交接历史由根日志处理。当前配置/原有完整来源闭包的即时guard仍独立存在；日志和poll从不授予模型/正文/发送权限。

日志总生命周期最多64次不同策略、1MiB元数据及8个store key，不驱逐未审计历史；溢出/审计失败fail closed。这是安全上限，不是可调的容量或可靠的离线配置历史。

## 明确边界

根插件/进程在尚未flush的观察后丢失，该段是未提交/UNKNOWN，不是已持久撤权成功。公共Volatile.get不提供离线历史；不得假造subscribe/precommit、使用Cordis私有写符号，或用没有diff的postevent充当授权。

原生关闭窗口遇到未审计策略时，保留owner可能需要受信运维在同一持锁所有权下重新打开metadata完成审计；不提供force-unlock/清除墓碑按钮。不能删除锁文件后抢跑，也不能把进程重启当已证明安全恢复。
