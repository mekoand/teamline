# CC Switch Is an Optional Personal Alpha Resource Adapter

Personal kernel v0 preserves the resource-adapter boundary without depending on CC Switch. Personal Alpha may use CC Switch as an optional adapter to read provider references, availability, quota, and usage signals and to request a switch after user confirmation. Teamline continues to own goal budgets and resource-action decisions, while CC Switch owns provider configuration and credentials. Teamline does not copy API keys. Only signals attributable to a specific goal may trigger budget actions; globally aggregated usage can only produce guidance. Current public documentation mainly covers configuration import by deep link, provider switching, local routing, and usage statistics, so a stable public interface must be validated before integration. Teamline will not depend directly on CC Switch's private SQLite schema and should add required capabilities upstream when practical.

Sources: [CC Switch repository](https://github.com/farion1231/cc-switch), [Deep Link documentation](https://github.com/farion1231/cc-switch/blob/main/docs/user-manual/en/5-faq/5.3-deeplink.md)

---

## 中文

# CC Switch 是个人 Alpha 的可选资源适配器

个人内核 v0 只保留资源适配器的数据边界，不依赖 CC Switch。个人 Alpha 可以把 CC Switch 作为可选适配器，读取 Provider 引用、可用性、额度和用量信号，并在用户确认后请求切换；Teamline 继续拥有目标预算与资源动作决策，CC Switch 继续拥有 Provider 配置和凭据，Teamline 不复制 API Key。只有能够归因到具体目标的信号可以触发预算动作，全局聚合用量只能提示。当前公开文档主要说明配置导入 Deep Link、Provider 切换、本地路由和用量统计，接入前必须验证稳定的公开接口；Teamline 不直接依赖 CC Switch 的私有 SQLite 结构，必要能力优先通过上游贡献补齐。

Sources: [CC Switch repository](https://github.com/farion1231/cc-switch), [Deep Link documentation](https://github.com/farion1231/cc-switch/blob/main/docs/user-manual/en/5-faq/5.3-deeplink.md)
