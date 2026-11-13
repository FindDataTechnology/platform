## MODIFIED Requirements

### Requirement: 舰队操作经 REST API 暴露且鉴权与既有面一致

舰队与岗位的全生命周期操作 SHALL 以 REST API(/api/fleets 前缀)暴露,鉴权与身份语义 SHALL 与既有集群/定时任务面一致(auth-on 走 forward-auth 用户,auth-off 归机器主人);用户 SHALL 只能读写自己拥有的舰队。非法输入(缺岗位名、非法 cron、未知 targetRef 类别)SHALL 以结构化错误拒绝且不落库。

模型声明的写面:建岗与改岗 SHALL 接受可选 `model` 与 `fallbackModel`(`null` = 清除,回到继承);舰队设置面 SHALL 接受可选 `defaultModel`。校验 SHALL 复用既有三闸——标识符形状、宿主模型 roster、计费车道(已绑计费才校验)——失败 SHALL 以结构化错误如实拒绝并指名违反的是哪一闸。`fallbackModel` 仅在 `model` 非空时可设;清空 `model` 时 `fallbackModel` 仍非空 SHALL 拒绝并提示先清兜底。a2a 岗位与 cluster 岗位设置模型 SHALL 拒绝(a2a 的模型归该服务的部署配置,集群岗归各成员岗位)。所有返回岗位读面的接口 SHALL 带 `model`、`fallbackModel` 原值与 `effectiveModel`——由服务端按解析链与读时 roster 计算,标注 advisory(读时与回合时 roster 可能漂移)。

配置维度的写面:建岗 SHALL 与改岗接受同一组可选字段 `effort`、`contextBudget`、`carrier`、`packId`(`null`/`""` = 清除声明),校验 SHALL 复用与改岗逐条相同的闸——思考深度取已知模型声明档位的并集、上下文上限为正有限数、`carrier` 属枚举、`packId` 为非空串且不超长。合法请求 SHALL 把四项原值落到岗位行并在读面回显;任一门拒绝 SHALL 以结构化错误如实拒绝且 SHALL NOT 落库。服务端 SHALL NOT 接受一个字段却在建岗时静默丢弃它。

批量写面 SHALL 以 `POST /api/fleets/batch` 提供,请求体为 `{action, ids}`,`action` SHALL 限于 `pause`/`resume`/`archive`,`ids` SHALL 为舰队 id 数组且长度受运营策略上限约束(默认 50,超限以结构化错误拒绝整批且不执行任何一条)。服务端 SHALL 逐舰队串行执行既有单舰队语义并在 `results[]` 中逐条返回成功或结构化失败原因;单条失败 MUST NOT 中断其余执行;请求体合法时 HTTP 状态 SHALL 为 200。越权 id SHALL 以与「不存在」一致的失败呈现,不泄漏他舰队任何内容。

#### Scenario: 越权拒绝

- **WHEN** 用户 A 请求修改用户 B 的舰队
- **THEN** 请求被拒绝且不产生任何变更

#### Scenario: 非法 cron 拒绝

- **WHEN** 创建岗位时提交非法 cron 表达式
- **THEN** 返回结构化错误,无岗位与物化任务产生

#### Scenario: 建岗带模型回显

- **WHEN** 主人建岗时带 `model: "cheap-model"`,随后 PATCH 改为 `null`
- **THEN** 建岗后岗位读面回显 `model: "cheap-model"`,PATCH 后回显 `null` 且 `fallbackModel` 同样为 null

#### Scenario: 三闸拒绝指名

- **WHEN** 主人建岗时带不在宿主 roster 里的 `model: "ghost-model"`
- **THEN** 返回结构化错误且文案指名「不在宿主模型 roster」,岗位不落库

#### Scenario: 兜底缺首选拒绝

- **WHEN** 主人 PATCH 岗位只设 `fallbackModel` 而 `model` 为空,或置 `model: null` 时 `fallbackModel` 仍非空
- **THEN** 均以结构化错误拒绝并提示兜底依赖首选,岗位模型声明不变

#### Scenario: 非 persona 岗位设模型拒绝

- **WHEN** 主人给 targetRef 为 a2a 或 cluster 的岗位设置 `model`
- **THEN** 以结构化错误拒绝并说明模型归服务部署配置/各成员岗位

#### Scenario: 读面带生效模型

- **WHEN** 岗位未声明模型而舰队设了 `defaultModel`,主人读取舰队详情
- **THEN** 岗位读面 `model` 为 null、`effectiveModel` 为舰队默认(该模型在读时 roster 中命中)

#### Scenario: 建岗带全配置维度回显

- **WHEN** 主人建岗时带 `effort`、`contextBudget`、`carrier`、`packId` 四个合法值
- **THEN** 该请求返回 201,且岗位读面逐项回显这四个值(与随后用 PATCH 写同样的值等价)

#### Scenario: 建岗非法思考深度拒绝且不落库

- **WHEN** 主人建岗时带一个任何已知模型都不声明的 `effort` 档位
- **THEN** 返回结构化错误并列出可选档位,岗位不被创建

#### Scenario: 建岗未知 carrier 拒绝

- **WHEN** 主人建岗时带不在枚举内的 `carrier`
- **THEN** 返回结构化错误并列出可选值,岗位不被创建

#### Scenario: 建岗超长 packId 拒绝

- **WHEN** 主人建岗时带超过长度上限的 `packId`
- **THEN** 返回结构化错误,岗位不被创建

#### Scenario: 批量端点越权 id 逐条拒绝

- **WHEN** 批量请求的 ids 含一个不属于当前主人的舰队 id
- **THEN** 该 id 在 `results[]` 中以失败返回,同批其余属于该主人的舰队照常执行,响应不泄漏该舰队任何内容

#### Scenario: 批量 ids 超上限整批拒绝

- **WHEN** 批量请求的 ids 数超过上限
- **THEN** 端点以结构化错误拒绝整批,不执行其中任何一条

### Requirement: 岗位可声明思考深度并按回合生效

舰队岗位 SHALL 可声明思考深度(effort),与模型声明同形的覆盖语义:岗位声明优先于舰队默认,舰队默认优先于 cell 默认;三者皆无声明时 SHALL 沿用既有的 provider 级全局思考深度,行为与本次变更前逐字节等价。声明的值 SHALL 在写面校验为该 cell 已知模型所支持档位的并集内,非法值 SHALL 被结构化拒绝并提示可选值。回合执行时 SHALL 按解析出的生效值切换运行时思考深度,且该切换 SHALL NOT 重启运行时进程;生效值与运行中值相同时 SHALL 跳过切换。声明了却被当前模型不支持时 SHALL 回落上一层声明并留下可读提示,回合 SHALL NOT 因此失败。

声明被清除(写面收到 `null` 或空串)后,该岗位下一回合的运行中思考深度 SHALL 切回 provider 级全局值,SHALL NOT 沿用上一回合或上一岗位遗留的活体档位。判据 SHALL 是「目标档位与运行中档位是否不同」,而非「目标档位是否有值」。

#### Scenario: 岗位声明生效

- **WHEN** 某岗位声明思考深度为 high 且其生效模型支持该档
- **THEN** 该岗位回合在 high 档执行,且执行期间运行时进程未重启

#### Scenario: 未声明零变化

- **WHEN** 岗位与舰队均未声明思考深度
- **THEN** 回合沿用 provider 级全局思考深度,行为与变更前一致

#### Scenario: 不支持的档位回落

- **WHEN** 岗位声明 high 但其生效模型只支持 low 与 medium
- **THEN** 回合按上一层声明(或全局值)执行,并在回合记录中留下该声明不可用的提示,回合不失败

#### Scenario: 非法值写面拒绝

- **WHEN** 以任何已知模型都不支持的档位更新岗位
- **THEN** 写面返回结构化错误并列出可选档位

#### Scenario: 清除声明后回到全局档位

- **WHEN** 岗位原声明 high 且运行中档位为 high,主人把该岗位 effort 置为 `null`,随后该岗位触发一个回合
- **THEN** 该回合在 provider 级全局档位执行,不再沿用 high;切换走 live `model/set` 路径,运行时未重启

#### Scenario: 档位未变不切换

- **WHEN** 岗位无声明且运行中档位已是 provider 级全局值
- **THEN** 该回合不发起思考深度切换调用,回合行为与变更前逐字节等价
