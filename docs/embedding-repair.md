# 独立向量修复与遗忘边界

[EmbeddingRepairRunner](../src/memory/embedding-repair.ts)只修复已激活、当前版本、仍有完整来源授权的单个规范文档；不创建新文本、不调用聊天模型、不切换有效指针。原消息retain的重试/成本与维护任务分离。只有明确vector_failed才排队，pending/not_requested不会被冒充失败而重跑。

## 提交与结算

1. 完整来源、原始消息、传递依赖加目标自身active version先获准，再使用控制库正文重建canonical/hash。
2. [公共adapter](../src/memory/knowledge.ts)准备阶段只读，核验owned bank/proactive-off、完整header/hash/provenance及精确docId。返回冻结的单用port，不执行mutation。
3. 同一授权屏障内持久记录attemptId/generation、ownerFence、doc/hash/完整provenance、独立attempt成本，再注册原始SDK结算观察与有界本地等待，最后同步复核并提交唯一一次reindexDocument(docId,{mode:'rechunk'})。
4. 原始Promise结算证明与来源授权分开：撤权后只允许原owner/attempt匹配的元数据结算，绝不保存正文或重开指针。成功还须重新核验同一规范doc/vector ready，才能标记向量成功。

本地等待最长30秒，不表示远端已取消。timeout、根停止或冷恢复的in-flight变成unknown，不能因标记存在/正文缺失/重新启动而自动重发。最多10次已知终止后的独立尝试；新attempt不能覆盖未知旧操作。

## 遗忘

删除投影和purged不变量同时检查原始WriteIntent及维护mutation。未知修复在途时，即使当前文档已删空也不进入purged；观察到同owner真实结算后再枚举清理迟到文档。普通metadata事务不能伪造结算、删去未知历史、缩减闭包或注入新attempt。

已知无调用证据与unknown不同：若最终同步guard拒绝且prepared.invoked=false，则可记录not_started。极窄停止/提交竞态若不能建立该证据，宁可保留unknown；不提供强制清除开关。

## 真实公共服务与存储兼容

安装的knowledge0.5.2公开reindexDocument支持rechunk。隔离测试使用与当前Host相同版本的公共JsonStorageBackend（显式临时root、导入前隔离DSH_HOME），真实rechunk及冷重开通过，embeddingProvider=none，不涉及外部模型。

发现真实reindex会传入processing:undefined，普通JSON序列化会省略它，而本插件严格OwnedSqliteBackend按非JSON值拒绝。后者只服务插件control/ledger，不用于宿主knowledge；没有为了测试放宽控制库存储校验。此前使用严格自有后端模拟knowledge的reindex失败已记录并改为实际Host公共后端验证。不能据此声称所有自定义后端兼容。

缺少公共reindex能力会明确unsupported死信，不调用私有库、重解析URL、修改全局embedding配置或追加重复正文。真实embedding供应商成功率/取消/延迟未授权验证；provider=none的rechunk不能证明向量模型可用。
