# Tasks

## 1. 全扫与内容

- [x] 1.1 50 支官方包基线符合性全扫（12 支未达标清单：persona 短/skills=0）
- [x] 1.2 staging/source-snapshot.json：12 支 21 岗改版前 persona 全量快照
- [x] 1.3 六支柏讯套件 persona 深化（估值/宏观/区域经济/行业与企业/决策复盘/模拟交易）
- [x] 1.4 工厂集群两舰队岗深化（巡检 315→430+/报班 306→430+，保留 report_status）
- [x] 1.5 投研三镜头两岗深化（与套件共享岗同文，逐字节一致）
- [x] 1.6 分身工坊/壹座产品介绍（谦面岗）深化
- [x] 1.7 nano-pdf 包装岗深化（转正红线：零 skills、技能正文一字不动）
- [x] 1.8 四条新技能：架构师×2（fleet-authoring-flow/fleet-edge-vocabulary）+ 产品介绍×2（public-info-discipline/intro-triage-routing）

## 2. 门禁与发布

- [x] 2.1 scripts/test-assistant-packs-content-baseline.mjs 静态门 6/6（覆盖/前缀/共享岗同文/转正零 skills/技能/结构）
- [x] 2.2 staging/publish-assistant-packs.mjs 多作者会话版（四身份按包作者选会话；WAF 节流+502 退避）
- [x] 2.3 dry-run 12/12 全绿
- [x] 2.4 --fire 真发布 12/12（9 支首轮 + 3 支 WAF 冷却补发；区域经济/模拟交易单独补发成功）
- [x] 2.5 API 回读 12/12：v+1 全对（工厂 v3/三镜头 v5/架构师 v6/壹座介绍 v6/分身 v7/估值 v5/宏观 v5/区域 v4/行业 v4/决策 v4/模拟 v4/nano v4）

## 3. 部署侧缺陷与走查

- [x] 3.1 官方作者名册补两邮箱（fd-infra-deploy 83052dd + kubectl set env 同值先行；画廊 46→50 卡）
- [x] 3.2 真机走查 13/13：货架 12 卡全在（50 卡墙）、详情逐支版本/内容标记/无转义
- [x] 3.3 台账 §15.121 续十二 + 双推（origin+gitee）
- [x] 3.4 archive（ADDED×3 并入主 spec；validate --specs 通过）
