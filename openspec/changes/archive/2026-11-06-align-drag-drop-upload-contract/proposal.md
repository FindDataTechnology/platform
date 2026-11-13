# Align the drag-drop-upload contract with the shipped behaviour

## Why

体检（optimize-paas-module-audit N-19 / 第一遍 P0-1 同域）实证该 spec 的两处条款与线上行为不符：

1. **「不支持类型 → HTTP 415」从未实现**：全仓零 415 赋值点。真实路径是客户端无类型预检、拖入即走同一 multipart 通道上传；服务端分类/抽取失败时回 **422**（`server/routes/documents.js:53-56`，且原文件仍落盘、`preview` 引用随响应返回），Composer 把附件芯片置 failed 并弹 toast（`web/src/components/Composer.tsx:355-380`）。
2. **「粘贴纯文本入文档」无实现**：全仓零 `onPaste`；粘贴进 Composer 就是普通文本编辑（这正是期望行为）。

按 spec 验收会得出错误结论（找 415 找不到、以为粘贴入库丢了）。本 change 只改文本，让 spec 描述真实契约。

## What Changes

- `drag-drop-upload` 唯一 Requirement 重写：415→422（含原文件保留+preview 引用+失败芯片/toast），粘贴条款改为如实陈述（不拦截、入正文）。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `drag-drop-upload`：上传拒绝语义与粘贴语义按现势改写（MODIFIED）。

## Impact

- 仅 spec 文本；代码零改动。
