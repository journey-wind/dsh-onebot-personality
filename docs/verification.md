# 0.1.0 实际验证与分层验收记录

## 环境与范围

2026-11-05 用户确认后，权限快照为 danger-full-access、禁止审批提示。Node实测24.22.1，pnpm11.28.5。所有命令在插件工作区执行；未安装当前profile、未启动替代Web服务，也没有继续ACL修复或绕过脚本策略。2026-11-06目标扩展后，另经授权只读连接SnowLuma核验账号/统计事件；仍未向真实QQ发送消息或调用真实模型。

pnpm install --ignore-scripts 退出0，真实锁文件与 dist 已生成。依赖安装脚本未执行。首次类型检查和首次完整测试的失败都实际调查/修正，没有跳过失败或伪造锁文件。

## 最新完整结果 / goal round 14

**pnpm run test（含tsc build）退出0：513项，507通过，0失败，6跳过，总耗时11.20秒。**

6项跳过是当前 Windows 的 POSIX 权限分支/缺少 symlink 创建权限；junction、硬链接、现有 sidecar、真实双进程锁等对应可执行测试已运行。Windows owner-only DACL 仍是部署前提，不是测试认证。

实际覆盖包含：

- 聚合提交、故障隔离、删除日志优先、闭包全输入、授权屏障、unknown不重放、单调迟到确认及经验入队。
- 五独立槽位、原始快照/预算、取消、同槽一次修复、引用/实体/时间、派生 dirty/CAS、重试/lease/fence 和生命周期。
- 原生 SQLite 冷持久化、全批删除回滚/未知状态隔离、并发连接与**两个真实子进程**的排他/优雅释放/强杀后重新获取；外来应用数据库和未知版本原样拒绝。
- 真实Cordis根volatile默认值、默认禁用加载/卸载、缺依赖时明确等待且无业务效果、状态不含token/目录；Host controller重建、迟到资源关闭、关闭不确定时拒绝第二owner。
- 同一 Host controller 配置重建期间共享 ProviderQuota，旧 session.stop 不清零借用计数。
- **真实发布版 dsh-knowledge0.5.2 公共 API**：独立子进程内显式 DSH_HOME、cache、chunks 路径，与当前Host同版本的临时公共JSON backend/DomainFacility、SQLite chunks及仅内存注册的Web route port；没有启动 HTTP 服务。创建/完整读取原文及 chunk、关闭重开、插件 adapter proactive-off bank/canonical write/精确对账/授权读/删除、再次重开确认删除，均实际通过。验证了不是 MemoryStore 回退。未访问库私有 store/db 字段。

- **完整隔离Native管线**：真实Cordis依赖callback、插件SQLite control/ledger、真实WS loopback网关、fake LLM五槽和真实knowledge一起执行入站→router/reply→字面text确认发送→raw/成功experience持久化；两次资源工厂冷重开不补发、不重跑模型。随后通过实际ctx.plugin(Native entry, enabled config)完成root Volatile/依赖注入/控制器连接、公开status ready、卸载、WS关闭、backend撤销及真实owner重新获取，借用knowledge保持可用。该阶段未投递新消息/增加模型调用，WS mock不是当前GUI替代服务，也不是真实QQ发送。
- **撤权审计**：B已观察而C先于审计微任务重新允许时，B捕获的旧epoch仍先写ledger；多来源和同revision不同对象都受测。session.stop排空审计；真实Native ledger被外部测试连接锁住时，关闭返回错误、控制库隔离并保持owner，新的owner请求返回busy。强引用防止GC意外释放隔离锁。
- **根配置交接**：12项回归覆盖工厂已读取B却尚无Session、旧库已关但owner未释的B→C、每store游标/ACK、64策略/1MiB/8store边界、不可变WeakRef缓存与可变配置拒绝缓存。真实Native backend.close后注入B→C，确认最终关闭拒绝、owner busy且零新发送/模型；不是只验证fake close port。[边界](configuration-observations.md)不承诺离线未观察历史。
- **独立向量修复**：20项runner故障测试和7项adapter边界测试覆盖原始SDK结算、独立持久attempt、timeout/stop/cold unknown不重发、迟到元数据、遗忘purged阻断/闭包不缩减/结算不可伪造；真实公共rechunk在provider=none隔离服务通过，不宣称真实向量供应商成功。[协议与兼容差异](embedding-repair.md)另记。
- **离线包结构**：新增严格tar路径/校验和/exports/icon/locale/依赖/私密文件扫描器及无凭据配置示例，2项基础与对抗测试通过。开发候选已真实pack并通过195文件/589159字节归档检查，真实独立home/profile完成安装、配置合成、默认禁用挂载、卸载。最终0.1.0另用同一工具核验，其SHA256/内容清单以外置JSON/校验文件为准，不在包内循环嵌入自身hash。
- **原生socket**：真实ws默认适配器的Bearer/login、未认证事件丢弃、固定成员no_cache、字面CQ不执行、echo确认、ping/pong、错误身份阻断/关闭均通过。

knowledge冷恢复包含正常关闭，不等于完成所有知识写入ACK后强杀/丢电矩阵。未观察到的离线配置历史及startup/teardown间隙仍需明确审计边界。

## 实际发现与修正

- 第一轮 tsc：ws.ping 的 mask/callback 端口差异、只读闭包投影、UUID默认参数收窄、测试空数组断言收窄、SDK接口差异；补充 Cosmokit直接peer使声明可移植。
- 首次完整套件：441项中408通过/28失败/5跳过。新建空 owner DB 的 BEGIN EXCLUSIVE 会生成自身 journal，原 sidecar 防护因此拒绝；修为先确认专用空 schema/header，在短事务持久初始化 DSOW/version1，再持有无写长事务。没有放开对未知 sidecar/外来 DB 的拒绝。
- 匿名事件整个 JSON 的数字子串断言误撞 UNIX 时间戳，改为验证身份投影；匿名 gateway user_id 不再当真实 QQ 或 self 身份。闭包比较保持完整集合而不要求插入顺序；重新允许 epoch 只要求不复用旧值，并确认后续不被旧删除水位覆盖。
- 召回授权曾反复解析全目录，130候选用例约202秒；元数据-only、不可变状态身份/证明到期约束的缓存与精确依赖目录后，独立测试约1.60秒，最新并行全套约3.52秒。每次仍检查 config/fiber/owner/proof/当前输入及待删除闭包，不缓存正文/词法特征。不是2万条库的性能承诺。
- 实际 knowledge 对 lexical-only 完整文档可给出 pending 状态；adapter在验证完整正文后按有效 provider=none 标为 not_requested，不虚构向量任务/成功。

## 依赖和兼容边界

pnpm peers check 退出1：knowledge固定 onnxruntime-node1.21.0，其范围依赖解析到ppu-paddle-ocr6.6.1（可选peer要求^1.23.2）。没有升级/覆盖第三方依赖。文本路径实测通过；不证明OCR/native-model路径兼容。

Host源码SDK和npm发布SDK同为0.2.1-rc.3，部分接口不同（公共KvUnit批删除、StorageErrorCode等）。额外原子批量/unknown-state是本插件自己的显式扩展。实际knowledge descriptor版本0、默认single，也已在集成测试核验。版本号不代替真实API检查。

knowledge即使显式chunkStorePath也会探测DSH_HOME下旧文件，启动还扫描本地模型目录。因此测试必须在子进程动态导入之前隔离DSH_HOME及显式cache/chunks，不能只改一个数据库路径。

## SnowLuma 实际只读连接 / P7子集

用户提供安装位置和控制台5099后，只读核验SnowLuma2.1.1配置，定位forward WS3001。探测器从指定私有文件在内存读取Bearer，15秒实际探测退出0：ready/OK、身份verified且与预期一致，收到1个meta_event，群/私聊消息0。具体QQ及凭据不写入分发文档。探测结束已关闭连接，没有QQ发送、模型/知识处理或正文保存。[探测文档](snowluma.md)记录命令及边界。8项隔离mock回归另外验证身份错误/拒绝、deadline、掉线、取消、哨兵零泄露和仅登录action。

## 支持边界与未运行的额外验收

1. 从未被插件观察的离线配置历史、根/进程在未提交观察后丢失，不是已持久审计；Volatile.get不能还原该历史。具体见[根观察日志](configuration-observations.md)。
2. 原生owner强杀/真实ledger busy及mock逐点故障均有证据，但不宣称完成所有物理丢电排列或真实供应商远端取消。整体旧备份回滚不支持安全开放。
3. 全库枚举耗时/大库吞吐未认证；供应商内存窗口跨整个plugin/dependency scope或进程不连续。任务累计成本持久保持。
4. OCR/native推理peer冲突未覆盖；Windows DACL由部署者外部验证；图标/设置表单浏览器渲染未验证，资源文件检查不替代视觉结果。

ACTIVATION_VERIFIED现为true，开发硬拒绝已解除且实际Native入口受测；配置仍默认disabled，只有显式身份/允许列表/目录与注册模型通过才开放业务。当前profile没有安装/启用。P7仅SnowLuma只读身份/事件子集已授权执行；真实QQ发送、真实模型与embedding/rerank未授权、未执行。
