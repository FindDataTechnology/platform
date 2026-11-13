## MODIFIED Requirements

### Requirement: 安装器预置 bundle 目录

桌面安装包 SHALL 在 `resources/bundles/` 下允许预置官方入门 bundle（可为零
个：目录缺失或为空时应用正常运行）。预置 bundle 与用户导入的 bundle SHALL
走完全相同的导入端点语义（同一管线、同一校验），不得存在优先/后门路径。
predist 烘焙 SHALL 幂等（重复构建不叠加、不重复条目）。

预置清单 SHALL 由包投影器（见 `pack-bundle-projection`）从 pack 的不可变版本
产出，SHALL NOT 由手工维护的列表充当来源；烘焙步骤 SHALL 使用该生成清单，并
SHALL 对每个候选包重新校验摘要后再落盘。生成清单与已评审清单不一致时，烘焙
SHALL 失败而不是静默采用新内容。

#### Scenario: 空目录可运行

- **WHEN** 安装包无任何预置 bundle
- **THEN** 应用正常启动，导入入口只等用户选择文件

#### Scenario: 预置包无后门

- **WHEN** 预置 bundle 被导入
- **THEN** 经历的校验、付费闸降级与出处标记与用户手工导入完全一致

#### Scenario: 手工改预置清单被拦

- **WHEN** 有人直接编辑生成清单新增一个未重新投影的条目并构建
- **THEN** 构建失败，错误指明该条目不在投影产物中
