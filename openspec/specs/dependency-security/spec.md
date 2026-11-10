# dependency-security Capability Spec

## Purpose

依赖安全轮次的处置契约：仓库各 manifest 上的安全告警要么在归属 manifest 内修复，要么留下带可达性论证的书面豁免；每轮以可复验的本地测试门收口，且把升级夹带的隐性跳变列为显式审查项。

## Requirements

### Requirement: Critical advisories are remediated or exempted per owning manifest

每条 critical 级依赖安全告警，系统 SHALL 在告警归属的 manifest（lockfile）内把受影响包提升到首个修复版本；当无修复版本或修复路径会造成不可接受的破坏时，SHALL 留下书面豁免，内容包含加载路径论证（运行时 / 仅安装期 / 仅脚手架期）、不可达理由与复查触发条件。

#### Scenario: fix available inside declared ranges

- **WHEN** 告警包存在修复版本，且该版本落在依赖树上所有父包声明的范围内
- **THEN** 归属 lockfile 更新后，依赖树中不再存在低于修复版本的实例，告警自动关闭

#### Scenario: fix exists but a parent pins an exact lower version

- **WHEN** 修复版本存在，但某父包将其精确钉在低版本，常规重解析无法提升
- **THEN** 通过 manifest 级 override 把该包提到修复版本，override 处记录理由与解除条件（上游换版后移除），并有证据证明 override 不改变实际构建产物（或列出改变的产物并过其测试门）

#### Scenario: no fix exists upstream

- **WHEN** 告警包没有任何修复版本
- **THEN** 豁免记录写明该包的加载路径与为何在本仓库不可达，以及复查触发条件（上游发补丁 / 父包换版）；豁免不阻塞发布，但 critical 级豁免必须在轮次记录中单独列出

### Requirement: Dependency rounds surface hidden jumps and sweep undeclared packages

每轮依赖升级 SHALL 在合并前过所涉 manifest 对应的全部测试门；升级动作清单中由小版本升级夹带的传递大版本跳变 SHALL 作为显式审查项记录；未被任何 manifest 声明而残留在依赖目录中的包 SHALL 在确认源码无引用后被清除。

#### Scenario: nested major introduced by an in-range bump

- **WHEN** 某直接依赖的小版本升级把一个传递依赖推上了新的大版本（父包自身声明的范围内跳变除外）
- **THEN** 该跳变出现在轮次记录中，并由覆盖该传递依赖使用面的测试门验证；测试红则用 override 钉回原大版本并记为推迟

#### Scenario: extraneous packages linger in the tree

- **WHEN** 依赖目录中存在未被 lockfile 声明的包（历史实验残留）
- **THEN** 轮次先确认源码与脚本对它们零引用，再随重装清除，清除动作记录在轮次记录中

### Requirement: Out-of-scope manifests are named with their owner

当告警落在一份由其他在途 change 持有的 manifest 上时，轮次记录 SHALL 列出这些告警并注明归属 change，而不是留空或静默跳过。

#### Scenario: manifest owned by an in-flight change

- **WHEN** 某份 manifest 正被另一个未归档 change 修改
- **THEN** 轮次记录列出该 manifest 的告警计数与归属 change 名，本轮不改动该 manifest 的任何文件
