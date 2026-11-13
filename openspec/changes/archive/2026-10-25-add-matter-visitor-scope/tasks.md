# tasks

- [x] 1. gateway：matters 表 ALTER scope_key + open 接 visitor_scope + list/read 按
       scope 过滤（含存量无界兼容）+ 单测（异会不可见/同会可见/主人全见/无会话落无界）
- [x] 2. runner：manager 回合期 activeSession 记录 + matters.js open 附 visitor_scope
       （sha256(sessionId) 前 32）+ 单测（scope 供给/非回合落无界）
- [x] 3. 上产：出片滚 facet+runner 同代 → 生产双会话实证（A 开串→B 读不到→A 读得到）
- [x] 4. 台账 §15.47 + 归档
