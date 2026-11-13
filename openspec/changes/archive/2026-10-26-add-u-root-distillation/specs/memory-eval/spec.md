# memory-eval Specification

## ADDED Requirements

### Requirement: 老 note 深度场景度量蒸馏召回增量

续作评测场景集 SHALL 含不少于 2 个「老 note」场景：期望背景全部存于同 project 按新近排序排名 >3 的 note 页——现 digest 读面（L1 段至多 3 条）不可达、唯蒸馏后经 L2 检索可达的背景。harness SHALL 对该类场景先经真实蒸馏路径（与生产同契约的侧车 /distill 调用）准备种子根，再渲染 digest 臂，并以不经蒸馏的同根渲染为对照；老.note 场景子集上蒸馏臂对现 digest 臂 SHALL 保持不劣（重推导度均值差 ≥1 分），结果记入 continue-baseline。

#### Scenario: 老 note 背景唯蒸馏可达

- **WHEN** 对含老 note 场景的种子根先蒸馏后渲染 digest
- **THEN** 渲染块含经蒸馏产出的对应 L2 条目（背景可达），对照组（不蒸馏）不含

#### Scenario: 老.note 子集不劣门槛

- **WHEN** 以含老 note 场景的全集跑门
- **THEN** 老.note 子集蒸馏臂重推导度均值较现 digest 臂高 ≥1 分，结果入 continue-baseline

### Requirement: 胜率门按头部空间校准

续作评测的全集门 SHALL 承认「无头部空间场景」的存在：期望基线（none 臂）重推导度 ≥4 的场景本无背景需求，digest 臂至多打平，计入胜率分母只会度量场景集构成而非注入价值。重推导度胜率 SHALL 按有头部空间场景（none ≤3）计且 ≥70%；全集 SHALL 另计非劣率（digest ≥ none−1）且 ≥70%；重推导度 avg diff ≥0.5 与 first_step 双门照旧。老.note 深度场景子集门不受影响。基线记录 SHALL 同时保留旧口径（全集胜率）与新口径两套数字。

#### Scenario: 无头部空间场景不计入胜率分母

- **WHEN** 某场景 none 臂重推导度 = 5（任务无背景需求，digest 至多打平）
- **THEN** 该场景不计入胜率分母，但计入全集非劣率与 avg diff

#### Scenario: 门校准后判定

- **WHEN** 以含老 note 与深 note 场景的全集跑门（如 17 场景、其中 6 个 none ≥4 的构成）
- **THEN** 判定 = avg diff ≥0.5 且有空间场景胜率 ≥70% 且全集非劣率 ≥70% 且 note-depth 门过；两套口径数字均入 continue-baseline
