## MODIFIED Requirements

### Requirement: 舰队成员回合的子进程对话逐回合全新

舰队成员岗位（任务携带 fleetId——节奏触发、委托唤醒、事件唤醒同一执行缝；归属 SHALL 从 `sourceTag.fleetId` **或** `origin.fleet.fleetId` 任一取得，见下条）的
回合在设计上无状态：提示模板与舰队上下文（直属岗位末次报数、在岗总览）每回合现算注入，
历史对话对回合产出没有贡献。实现 SHALL 与该模型一致：每个舰队成员回合 SHALL 以**全新
的子进程对话**执行——运行时子进程 MUST NOT 回放此前回合的对话状态，回合启动 MUST NOT
因旧账压缩而显著劣化。子进程对话 id 与宿主专属会话（镜像）id 解耦：镜像 SHALL 维持单一
稳定会话、每回合转写行继续追加供人阅读，侧栏 SHALL NOT 因轮换出现每回合一个新会话；
子进程侧对话在回合收尾（子进程转闲）SHALL 获得 best-effort 清理，清理失败 MUST NOT
影响后续回合（后续回合的全新对话 id 不依赖清理成功）。不携带 fleetId sourceTag 的普通
定时任务 SHALL 维持既有「绑定会话续执行」语义，本需求不改变其行为。

#### Scenario: 舰队回合不续旧账

- WHEN 一个舰队成员岗位第 N+1 次节奏触发，第 N 回合及更早的转写已完整落盘
- THEN 本回合以全新子进程对话执行，子进程不回放第 N 回合及更早的历史
- AND 连续多回合执行中，回合启动耗时 SHALL NOT 随回合数增长而显著上升

#### Scenario: 镜像会话稳定可读

- WHEN 一个舰队成员岗位逐回合执行
- THEN 岗位专属会话保持单一镜像会话，每回合的用户提示与产出继续追加其中可读
- AND 会话列表不因子进程对话轮换而增加条目

#### Scenario: 子进程孤儿回收且失败无害

- WHEN 一个舰队成员回合收尾、子进程转闲
- THEN 平台对该回合的子进程对话发起 best-effort 清理
- WHEN 清理被运行时拒绝或不支持
- THEN 记一条警告日志，下一回合仍以全新对话 id 正常执行

#### Scenario: 普通定时任务语义不变

- WHEN 一个不携带 fleetId sourceTag 的普通定时任务触发
- THEN 其绑定会话的续执行语义与本 change 之前一致

#### Scenario: 历史任务的归属双源可判

- **WHEN** 一条舰队任务携带 `origin.fleet.fleetId` 而 `sourceTag` 为空（2026-10-24 前后的存量记录）
- **THEN** 该回合 SHALL 按舰队成员回合对待：轮换子进程对话 id、注入舰队上下文、适用早停与报数收尾判据

