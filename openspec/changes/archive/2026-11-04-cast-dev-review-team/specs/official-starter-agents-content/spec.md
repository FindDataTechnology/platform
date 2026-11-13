## ADDED Requirements

### Requirement: 改铸的外部角色必须是无触手顾问

从外部角色定义改铸而来的官方 pack 岗位，其 persona 必须（SHALL）只承诺"读—判—说"行为：判定对象由用户贴入或由工具面实际返回，且必须（SHALL）显式声明自身无执行触手、不得假装打开仓库 / 运行测试 / 扫描端口 / 读取覆盖率。上游正文里依赖 shell 或文件写的动作段必须（SHALL）改写为"建议用户在其工具链执行"的形态。每岗 persona 必须（SHALL）携带该岗所取自的上游文件出处与钉定 revision；包级 provenance 必须（SHALL）以 official-adopted 记录上游仓、许可证与钉版。

#### Scenario: 动手承诺被拒
- **WHEN** 某岗 persona 含"我来运行测试/我打开了仓库"一类未标注需用户执行的承诺
- **THEN** 基线测试拒绝，不允许上架

#### Scenario: 出处缺失被拒
- **WHEN** 某岗 persona 没有上游文件出处（仓/路径/钉版 sha）或 provenance 缺 license/revision
- **THEN** 基线测试拒绝，不允许上架

#### Scenario: 改铸纪律在文本内
- **WHEN** 检视任一评审岗的 persona 文本
- **THEN** 它声明了读—判—说契约、职责边界、按严重度带证据的输出契约，且判据来自该上游角色的专业领域而非通用套话
