# 配置、部署与联调清单

## 当前状态

这是独立Host bundle，不修改DSH、SnowLuma或其他插件。默认不连接QQ，不提供任意Agent工具。完整mock/原生兼容测试、真实Native入口及隔离安装流程已执行，开发硬拒绝已解除；默认配置仍disabled，安装成功不代表已经授权自动回复。以[验证记录](verification.md)和[发布前事项](open-issues.md)为准。

当前profile未安装本包。只读SnowLuma探测是单独的限时工具，已验证账号和1个协议元事件，未验证真实群/私聊消息，也没有开启人格回复。[只读命令与隐私边界](snowluma.md)可以独立使用。

## 配置输入

[最小禁用示例](../examples/disabled.json)是普通Config对象，不是整份Loader patch。[五路模型示例](../examples/five-routes.json)演示两个人格、继承和单人格reply覆盖；所有账号、群号、供应商及模型名称均为占位符，不是本机真实配置。

- onebot.wsUrl：正向Universal WS。当前SnowLuma控制台5099不是WS；已核验的forward配置为loopback3001。token只填Native secret表单/指定私有配置，不放URL、源码、聊天或命令行参数。
- expectedSelfId：必须是实际机器人账号，不能根据收到的陌生事件猜测。身份不符时停止，不切换账号。
- allow：显式群/私聊用户允许列表。外部事件先核验身份与允许列表，再使用正文；空允许列表不会自动开放全部来源。
- personalities：使用稳定ID；改ID不搬移历史。默认source-restricted。fully-shared必须显式确认私聊内容可能用于群回复，不能借改人格/昵称绕过权限。
- bindings：只影响新消息所属人格；不重分配旧消息。群内普通文本提及当前人格/别名或准确at当前机器人触发；其他允许消息只排retain。
- models：router/recall/reflect/retain/reply独立。显式路由必须成对填写已注册provider与model；人格可逐槽继承或覆盖。空effort采用该路由默认值，不把旧模型effort强行带到新模型。不能填写任意API endpoint或密钥。
- persistence.directory：独立可信本地绝对目录，不使用SnowLuma目录、会话cwd或共享宿主数据库。privateDirectoryReady是部署者完成外部权限检查的声明，不能代替Windows owner-only DACL验证。不要给不可信用户改父目录/创建junction的权限。
- budgets：在线/后台独立预算与容量，目录低磁盘/队列满会明确阻断；数字不是吞吐承诺。大库全枚举仍可能耗时。

准备显式启用时，仍须分别授权真实模型、embedding/rerank及QQ发送，填写实际允许列表/模型，并先做下述重复回复检查。只读探测授权不能替代这些确认。

## AstrBot bridge与通用knowledge

1. SnowLuma已有reverse WS client时，不删除、不改端口、不重启已有链路。当前观察到的6199是既有配置，不是本插件要求。
2. 明确同一bot/会话是否已有AstrBot bridge或其他机器人自动回复。先选择唯一负责回复的路由，避免两条链路同时收到同一消息后各自生成；不让本插件自动禁用别的插件。
3. 本插件owned bank在创建前设autoRetrieve=false、injectUsagePrompt=false、autoRetrieveWeight=0，读回实际配置后才导入；不向通用Agent挂长期记忆钩子，不注册任意检索/权限修改Tool。
4. 管理员应检查通用knowledge的自动检索/使用提示实际候选，不包含这些proactive-off bank。管理员显式选择bank或直接读取存储仍是宿主特权，不由本插件的QQ请求ACL控制。
5. 不让模型返回的QQ号、引用、CQ代码或bank/docIds改变权限。输出固定text数组；看起来像CQ的文本也不执行。

## 故障、遗忘与备份

状态只暴露计数和固定错误码，不输出token/正文。内部getStatus、retryRetain、forgetBySource、forgetByAuthor及getForgetStatus供受信管理代码使用，不是QQ命令或模型Tool。

- unknown发送不重发、不冒称成功；仅确认送达分段形成experience。断线没有重放保证。
- 任务重试保持原五路快照、checkpoint及累计成本；清理/向量修复是独立维护历史。
- 遗忘先持久ledger阻断，再清理本地与owned知识文档；purging/unknown不是purged。修复在途/迟到写也参与阻断，不能手改状态强制清除。
- owner-held、存储提交不确定或回滚检查失败：保持隔离，保全现场；不删除owner文件、不用第二进程抢跑、不把重启当已完成修复。
- 正常关闭再备份，并独立保全最新删除日志/水位。整目录一起恢复旧备份不受支持，单独不同文件名不是反回滚保障。恢复前必须证明最新墓碑仍在；丢失最新ledger时不能安全开放旧历史。
- 自定义迁移/未知schema版本拒绝启动，不提供自动猜测修复。细节见[私有存储与恢复](owned-storage.md)、[向量修复协议](embedding-repair.md)。

## 构建与预构建检查

在工作区执行，安装脚本保持关闭：

```powershell
pnpm install --ignore-scripts
pnpm run test
# pnpm pack会省略根pnpm-lock.yaml；先更新可分发的同字节锁快照：
Copy-Item pnpm-lock.yaml lockfiles/dependencies.yaml
pnpm pack --pack-destination artifacts
node scripts/verify-package.mjs artifacts/dsh-onebot-personality-0.1.0.tgz artifacts/inventory.json
```

原始锁文件在源码根目录；[分发锁快照](../lockfiles/dependencies.yaml)保持完全相同字节，测试会拒绝陈旧快照。离线检查不执行包代码，检查tar路径/链接/校验和、exports、原生显示资源、精确依赖、禁止的数据库/私密文件及常见私钥/API凭据形状；不是所有潜在秘密的形式证明。

可用公开DSH CLI做临时profile安装验证：

```powershell
node scripts/check-isolated-profile.mjs <absolute-bundle.tgz> <absolute-public-dsh-bin.js>
```

该工具在tarball所在目录创建独立临时home/profile，先核对公开resolveProfileDir确实落入该目录，再通过公开CLI安装/合成/默认禁用挂载/卸载。安装明确ignore-scripts，卸载通过环境保持脚本禁用；不调用当前profile管理API、不启动GUI或真实业务。日志与验证JSON留在临时目录供审计。渲染后的图标/表单视觉效果仍未验证，文件检查不等于浏览器渲染成功。
