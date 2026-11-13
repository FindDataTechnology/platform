# onboarding-guidance Specification Delta

## ADDED Requirements

### Requirement: 桌面首启的本地舰队上线步

Electron 桌面壳内（以 preload bridge 存在为准）且本机无任何舰队时，首启 tour
SHALL 追加一步「跑起第一支舰队」，把「装官方入门样例 → 用模板向导实例化 →
跑一轮 → 产出进 boards」串珠成一条可执行路径。该步 SHALL 可跳过、可从帮助
中心重开，SHALL NOT 阻塞底层界面（沿用既有 tour 的交互契约：卡片不挡操作、
Escape 关闭、done 标记持久化）。纯浏览器（无 preload bridge）SHALL NOT 出现
该步——本机集群概念只对桌面进程成立。每一步的失败 SHALL 逐项降级呈现（市场
不可达时不阻断离线 bundle 路径；两者皆不可用时给出明确引导而非卡死），
SHALL NOT 阻塞应用启动。

#### Scenario: 桌面空舰队首启出现该步

- **WHEN** 桌面壳内首启、本机部署与舰队均为空、且 tour done 标记不存在
- **THEN** tour 在既有三步后追加「跑起第一支舰队」，提供开始与跳过

#### Scenario: 浏览器不出现该步

- **WHEN** 纯浏览器访客走首启 tour
- **THEN** tour 仍为既有三步，不出现本地舰队步

#### Scenario: 离线也能走通

- **WHEN** 桌面断网且安装包含预置入门 bundle
- **THEN** 该步经预置 bundle 完成安装与实例化，段末可见 boards 产出或待确认启动提示

#### Scenario: 样例安装仍是一次显式确认

- **WHEN** 用户在该步内推进到安装动作
- **THEN** 安装经一次明确的确认（沿用既有安装 consent/确认口径），不静默物化任何 pack
