# dsh-onebot-personality 0.1.0

独立TypeScript DSH bundle，按[实施计划v2原始参考](docs/implementation-plan-v2.md)实现来源受控的多人格长期记忆。

**默认禁用，不自动连接/回复QQ，不安装当前profile。** Native可启用入口已在隔离环境完成依赖注入、连接、停止/卸载验证；真实QQ发送、真实模型、embedding/rerank仍须分别授权。SnowLuma已单独验证只读身份与1个协议元事件，未保存聊天正文。

## 能力

- router、recall、reflect、retain、reply五槽独立配置；人格覆盖、完整继承、不可变原任务快照及累计预算。
- Native Schemastery设置表单与secret token；正向OneBot v11 Bearer/身份核验、允许列表、会话串行和字面text发送。
- 独立SQLite控制库/删除日志、跨进程owner、任务lease/checkpoint/重试；unknown不盲目重发，只有确认成功分段进入experience。
- 原文先存、后台facts提取、实体/时间词法召回、来源闭包与实时成员授权；observation及三个固定mental-model模板的dirty/CAS刷新。
- proactive-off owned knowledge bank、canonical/hash精确对账、版本激活与物理遗忘；独立向量修复追踪真实在途操作。
- 根级已观察配置策略日志，覆盖启动/停止交接；各SDK/body/commit边界仍同步核验当前配置与完整闭包。
- 无任意Agent/工具执行，模型不能选择bank/docIds、改权限或执行CQ代码；原创SVG与中英文显示资源。

## 已验证与限制

完整回归 **513项：507通过、0失败、6平台/权限跳过**。包括真实SQLite双进程/强杀释放、真实Cordis、真实knowledge公共API/冷重开、loopback网关及Native entry生命周期。实际安装检查使用独立临时home/profile，不改当前GUI。

不宣称：全历史穷尽摘要、自然语言必真、供应商远端取消、跨整个进程重启的连续速率预算、未观察离线配置历史可还原、整目录旧备份安全恢复、Windows DACL自动认证、OCR/真实模型或浏览器视觉效果已通过。详见[验证记录](docs/verification.md)与[边界说明](docs/open-issues.md)。

## 构建与使用

```powershell
pnpm install --ignore-scripts
pnpm run test
Copy-Item pnpm-lock.yaml lockfiles/dependencies.yaml
pnpm pack --pack-destination artifacts
```

先读[部署/配置指南](docs/deployment.md)，使用[禁用示例](examples/disabled.json)或[五路模型示例](examples/five-routes.json)。供应商、账号和目录必须替换为受信配置；不要把真实token放进示例。宿主SDK使用精确peerDependencies，不捆绑宿主实现。

## 文档

- [验证记录](docs/verification.md) · [实施进度](docs/progress.md) · [兼容基线](docs/compatibility.md)
- [SnowLuma只读连接](docs/snowluma.md) · [部署与AstrBot重复回复检查](docs/deployment.md)
- [状态/备份边界](docs/storage-safety.md) · [独立SQLite](docs/owned-storage.md) · [Root配置交接](docs/configuration-observations.md)
- [知识适配](docs/runtime-adapters.md) · [Bank/遗忘](docs/bank-coordination.md) · [在线与retain](docs/pipelines.md)
- [生命周期/配额](docs/runtime-lifecycle.md) · [向量修复](docs/embedding-repair.md)

本项目原创代码与图标按MIT许可。dsh-knowledge保持独立依赖，不复制实现、不访问私有库；部署者须独立确认其许可证及外发配置。
