## ADDED Requirements

### Requirement: 车道入口页可渲染且文案可编译

面板车道入口页（`/lanes`）SHALL 在任意受支持语言下完整渲染：页面全部文案
（含协议示例形状）SHALL 通过消息编译器校验，含字面量花括号的文案 SHALL 按
vue-i18n 转义约定书写。消息编译类缺陷 SHALL 被 CI 关键测试清单拦截，不得
流入出片。

#### Scenario: 车道页渲染完整

- **WHEN** 已登录用户打开面板「模型车道」页（zh 或 en 界面）
- **THEN** 页面渲染出全部车道卡片（rerank/websearch/ASR/TTS 四行），无白屏、无未捕获异常

#### Scenario: 消息编译门拦截缺陷类

- **WHEN** locale 文案引入未转义花括号等消息编译错误
- **THEN** 关键测试清单（`make test-frontend-critical`，含全量消息预编译守测）失败，合入被拒
