## ADDED Requirements

### Requirement: 运行时镜像依赖预算

fd 谱系的 registry 运行时镜像（`mcp-registry`）SHALL 维持精简依赖闭包：本地 embedding 推理不得引入 torch 系依赖；运行时不可达的依赖（无任何 import 路径）不得进入镜像；镜像压缩后体积 MUST 不超过 1.6GB 预算线（基线 2.72GB，目标约 1.45GB），CI 在镜像发布前 SHALL 断言该预算。

语义搜索、注册去重检查、自定义实体索引的对外行为 MUST 不因推理引擎切换而退化：默认 embedding 模型保持 all-MiniLM-L6-v2、输出维度保持 384，既有索引无需强制重建即继续可用；embedding 引擎不可用时，搜索 SHALL 沿既有 latch 机制降级为关键词检索而非报错。

sentence-transformers（torch 后端）路径 MAY 作为可选安装保留，但在默认安装中缺席；当运营者显式选择该 provider 而其依赖未安装时，系统 SHALL 给出明确的加载失败日志并落入上述降级路径，不得崩溃。

#### Scenario: 镜像体积在预算内

- **WHEN** CI 构建出 mcp-registry 镜像并检视其体积
- **THEN** 压缩后体积不超过 1.6GB，且 torch、matplotlib、scikit-learn、scipy、awscli 均不在镜像的依赖闭包中

#### Scenario: 同模型切换引擎后既有索引继续可用

- **WHEN** 以 ONNX 推理镜像替换 torch 推理镜像上线，且不触发索引重建
- **THEN** 语义搜索对同一查询返回与切换前一致量级的结果，embedding 维度仍为 384，已注册条目的向量索引继续命中

#### Scenario: 引擎不可用时降级为关键词搜索

- **WHEN** 本地 embedding 引擎加载失败（如模型文件缺失或 provider 依赖未安装）
- **THEN** 搜索请求以关键词检索返回结果而非 5xx，且日志记录一次明确的加载失败原因，后续请求不再反复触发加载尝试

#### Scenario: 新增依赖须有 import 路径

- **WHEN** 后续变更向 registry 运行时依赖清单新增条目
- **THEN** 该依赖在运行时代码（含管理脚本）中存在实际 import 或调用路径，否则 CI 的体积断言或依赖审计 SHALL 拦截合入
