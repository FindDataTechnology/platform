# Register the live media-generation lane as a capability

## Why

体检增量对账（optimize-paas-module-audit N-12）实证：`backend/internal/server/routes/gateway.go:262-290,430-435` 上产了一整族图像/视频生成端点（同步图像、异步图像任务、视频生成/编辑/扩展、状态查询、内容下载），首页/介绍/试用账号三本 spec 均引用其端点，但**九本 ciyuan spec 无一规定协议形状、计量与失败语义**——对外契约仅由代码与首页文案自证，与「能力入册」口径相悖。

本 change 只把已在产、已有测试（`gateway_test.go`、`image_task_admin_toggle_test.go`、`grok_media_slots_test.go`、`gateway_model_allowlist_test.go` 等）钉住的行为入册，零代码改动。

## What Changes

- 新 capability `ciyuan-media-lane`：端点族、鉴权/模型白名单、异步任务状态机、计量口径、失败语义五条 Requirement。

## Capabilities

### New Capabilities

- `ciyuan-media-lane`：图像/视频生成车道（ADDED）。

### Modified Capabilities

（无）

## Impact

- 仅新增 spec；代码/测试零改动。实现归属：sub2api fork 仓（跨仓契约，实现标注在 spec 头注）。
