# Tasks — add-facade-memory-read-lane

## 1. fd-memory 车道

- [x] 1.1 http.ts：`GET /memory` 与 `POST /forget` 增 rootKey 参数——person 带则拒、platform/runner 必带（缺 400）、deployment/pod 恒 403；平台缝 forget 审计主体 `platform:<tokenId>`。验证：单测三族矩阵（person 自身根 / platform 带 rootKey 读写通 / deployment 带 rootKey 仍 403）。
- [x] 1.2 镜像重出 + 滚产（判路按 fd-build-channel；可与下次 fd-memory 发布同车，独立出亦可）。验证：digest 双证 + ArgoCD Healthy + 生产 platform 令牌带 rootKey 读通。

## 2. 收尾

- [x] 2.1 台账补记 + 主 spec 同步（memory-visibility 2 MODIFIED）+ 归档（validate --specs 0 failed）；通知 fd-wanxing 姊妹 change 车道就绪。
