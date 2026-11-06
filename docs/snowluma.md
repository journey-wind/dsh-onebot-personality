# SnowLuma：OneBot v11 只读连接探测

## 命令（先由维护者完成构建）

在项目根目录运行；只提供**已经由你确认的私有配置文件完整路径**，不要把 access token 放进参数、环境变量或聊天记录：

```powershell
$config = Read-Host '输入 SnowLuma 私有 OneBot JSON 配置文件完整路径'
node scripts/probe-snowluma.mjs --config "$config" --duration-ms 15000
```

默认精确选择 `networks.wsServers` 中名为 `ws-default` 的条目。需要选择其他条目时使用 `--server 精确名称`，不支持扫描、模糊匹配或自动发现。文件名必须是 `onebot_<数字QQ账号>.json`；其他文件名必须显式加 `--expected-self-id 数字QQ账号`。显式参数优先，预期身份绝不从事件或登录响应反向推断。

- `--duration-ms`：整数 1–60000，默认 15000；握手和身份验证包含在总时限内。
- 只接受 loopback 主机 `127.0.0.1`、`localhost`、`::1` / `[::1]`；拒绝远程及通配地址、非法端口、URL 用户信息、查询参数、片段、转义和点路径段。
- 服务角色必须是 `Universal`，不能被显式禁用。配置文件最多 256 KiB，只读指定文件；不会读取旁边的账号配置或修改 SnowLuma 配置。
- `--config` 是唯一凭据来源；不支持 `--token` 或 token 环境变量。脚本只在内存中向 WebSocket 握手发送 `Authorization: Bearer …`。

脚本见 [probe-snowluma.mjs](../scripts/probe-snowluma.mjs)。它动态加载构建产物中的 `OneBotClient`，使用已经过原生 `ws` 包装器测试的默认实现；单纯 import 脚本不会连接。

## 已知配置不等于连接成功

维护者已只读确认安装的 SnowLuma 版本为 **2.1.1**，Web 管理控制台为 **http://127.0.0.1:5099**。5099 是控制台，不是 OneBot v11 WebSocket。

已确认的 forward WS 配置为本机 **3001**、路径 `/`、角色 `Universal`、消息格式 `array`，另有 HTTP 3000 与既有 reverse WS client 6199。**本探测不使用或修改 HTTP / reverse WS 配置，也不要求更改这些端口。** 存在这些配置并不证明 forward WS 正在监听、凭据有效或 QQ 登录身份正确；只有实际运行探测得到验证结果才算连接证据。

## 已执行的真实只读连接

2026-11-06，按用户提供的安装目录定位私有账号配置后，实际运行15秒探测：进程退出0，`state=ready`、`code=OK`、`authentication=verified`，预期账号与登录返回账号一致（此分发文档不记录具体QQ/本机私有路径）。端点为 `ws://127.0.0.1:3001`。

收到1个 `meta_event`，群/私聊事件均为0。未读取/记录正文、未发送QQ消息、未调用模型、未更改SnowLuma配置；结束后探测连接已关闭。不能把这次结果描述为已收到真实聊天消息，或人格回复服务已持续启用。

## 一行结果与退出码

标准输出只有一行 JSON；标准错误不输出原始异常。成功必须同时满足当前 transport state 为 `ready`、`get_login_info` 身份与预期一致。结果包括：

- `state`：清理前实际捕获的传输状态，不是 `dispose()` 之后人为产生的 `stopped`。
- `code`：固定错误码或 `OK`；例如 `IDENTITY_MISMATCH`、`AUTH_FAILED`、`CONNECTION_TIMEOUT`、`DISCONNECTED`、`INTERRUPTED`。
- `authentication`：只有结束时仍然 ready 才是 `verified`；曾经通过验证后掉线不冒充已连接。
- `expectedSelfId`、可选 `verifiedSelfId`：仅账号身份元数据。后者表示曾验证的身份，不保证当前连接仍然可用。
- `endpoint`：只有 loopback 主机和端口，不含路径、查询或凭据。
- `eventCount` 与固定 `counts`：`message` 下 `group/private/other`，以及 `notice/request/meta_event/other`。未知类型只累加 `other`，不输出原字符串。

退出码：成功 0，失败 1；SIGINT / SIGTERM 尽力优雅取消并返回 130 / 143。Windows 强制终止进程不保证可执行信号清理。握手拒绝若只表现为底层 socket 错误，探测不会凭空判断是口令错误，而会在总时限结束时报 `CONNECTION_TIMEOUT`，可带固定 `lastError`。没有事件但身份验证成功也可返回 `OK`、事件数 0；这只证明连接和身份，不证明已经收到 QQ 聊天事件。

## 隐私与 P7 权限边界

这是 **P7 只读认证和事件计数**，不授予 QQ 发送权限，不启动 Agent、模型或知识处理，也不创建人格、记忆或消息持久化。业务回调仅比较 `post_type` / `message_type` 的固定值；不访问聊天正文、发送者、群号、消息 ID、昵称或任意子类型，不输出、记录或保存原始事件。底层 transport 为验证协议和身份必须有界解析 WS 帧，但不会把正文交给本探测的输出或存储。

唯一 OneBot action 是 transport 内部固定的 `get_login_info`；传输层可以发送 WS ping/pong，不进行成员查询、任意 action、`prepareTextSend` 或任何 QQ 回复。入站帧上限 256 KiB、出站 action 上限 16384 字节、pending 上限 32。根级 deadline / 轮询计时器和信号监听器由探测拥有，所有结束路径都会清理并调用 `dispose()`。

不要粘贴私有 JSON、token 或聊天事件来排障。分享结果前仍应按需要遮盖 `expectedSelfId` / `verifiedSelfId`。

## 离线验证

测试见 [snowluma-probe.test.ts](../tests/snowluma-probe.test.ts)。维护者统一构建之后，可单独运行：

```powershell
node --test dist/tests/snowluma-probe.test.js
```

测试只连接随机端口的本机 WS mock，使用可验证清理的临时私有配置；覆盖真实 Bearer header、固定登录动作、身份不匹配、认证拒绝、deadline、掉线、取消、严格输入校验、文件大小上限和敏感哨兵不出现在输出中。不会连接实际 SnowLuma、QQ、Host 或模型。测试通过不替代实际只读连接探测。
