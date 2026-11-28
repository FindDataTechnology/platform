# credential-file-format Specification

## Purpose
规定 child 凭据文件（`.credentials.yaml`）中凭据值的标量写出格式：必须单行且被引号包裹，
使任何只做单行文本处理的取值方式（`grep` / `sed` / 单行 `python -c`）都能可靠拿到完整值。

## Requirements

### Requirement: 凭据值必须以单行引号标量写出

写下（或重写）child 凭据文件时，SHALL 保证每个凭据值在文件里占据**单独一行的引号标量**：
不得因长度被序列化器折叠成块标量（`>-` / `|-` 等），也不得以裸露的多行形式出现。
引用风格（单引号或双引号）由序列化器决定，但必须明文加引号，避免以裸标量形式出现。

#### Scenario: 长 PAT 不折叠

- **WHEN** 平台写出一个 93 字符的 GitHub PAT 到凭据文件的某个 ref
- **THEN** 该 ref 在文件里是一行 `name: 'value'` 形式，值完整位于 `name:` 同一行，
  不存在续行缩进

#### Scenario: 既有凭据文件格式可迁移

- **WHEN** 任一凭据 ref 的值发生变化（触发重写）或文件缺失被重建
- **THEN** 重写后的文件全部 ref 均为单行引号标量

### Requirement: 值语义与既往格式等价

格式硬化 MUST 不改变解析后的值：同一凭据值以引号标量写出与被折叠成块标量写出，
经 YAML 解析器加载后 MUST 得到字节相同的字符串——不引入转义、截断或空白变化。

#### Scenario: 引号标量与块标量解析等价

- **WHEN** 同一 token 分别以新格式（单行引号）与旧格式（块标量）写入文件并加载
- **THEN** 两次解析出的值完全一致

### Requirement: 单行取值工具能拿到完整值

文件 MUST 满足：对任意 ref，用**只处理单行文本**的命令（如按键名 grep 后取分隔符右侧、
或单行 `python -c` 按 `:` 切分）都能取到完整值，不需要跨行拼接或 YAML 块语义知识。

#### Scenario: grep+sed 单行取值

- **WHEN** 对凭据文件执行针对某 ref 键名的单行 grep+sed 提取
- **THEN** 取到的是该凭据的完整值（非空串、无截断）

#### Scenario: 既有 YAML 加载不受影响

- **WHEN** 平台自身（或任何 YAML 解析器）加载新格式的文件
- **THEN** 解析成功且各 ref 值与其写出时一致
