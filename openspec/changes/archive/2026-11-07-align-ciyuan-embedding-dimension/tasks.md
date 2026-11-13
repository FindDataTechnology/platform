# 任务：词元嵌入维度契约对齐

- [x] 1.1 三方核证（spec 1024 / 生产 4096 / fd-memory 不传 dimensions）
- [x] 1.2 fork 守卫实现（validateOpenAIEmbeddingsResponseDimensions + handler 502 不计费）
- [x] 1.3 夹具自洽修正 + 6 例表测 + 转发级负例；service 包 142s 全绿
- [ ] 1.4 spec delta validate --strict + archive
- [ ] 1.5 fork 提交 + patch ledger 登记（出片滚版待静窗，不在本批）
