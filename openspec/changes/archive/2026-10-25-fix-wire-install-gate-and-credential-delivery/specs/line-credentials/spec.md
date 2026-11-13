# line-credentials Delta

## ADDED Requirements

### Requirement: Pack installs honor the server's declared line credential ref

wire-customer / lex 条目的 pack 安装与市场卡安装 SHALL 以该线凭据自身的连接状态为闸：
凭据连接则安装，未连接则以 credential-required 拒装——409 文案 SHALL 指名缺的是哪条线
的凭据（不再出现「connect the MCP market first」类误导），connectPath SHALL 指向该线的
连接卡。安装闸 SHALL NOT 将线凭据 ref fall-through 到 registry 凭据判活：没有 registry
（市场）凭据但持有活线凭据的账号 SHALL 能装对应线的 pack；持有 registry 凭据但线凭据
未连接的账号 SHALL 被拒。派发表登记的其余线系 ref（wanxing-caller）SHALL 同理按其凭据
模块判活；registry / facet-market / chatwoot / paper-trading 四既有 ref 的闸行为 SHALL
与本 change 之前完全一致。

#### Scenario: 仅 wire-customer 凭据的账号装 wire pack 成功

- WHEN 一个没有任何 registry 凭据、仅持有活的 wire-customer 凭据的账号安装引用
  wire 线服务器条目的 pack
- THEN 安装成功，该服务器状态 installed，注入的是其 wire-customer 凭据

#### Scenario: 线凭据断开后重装被拒且指向正确入口

- WHEN 该账号断开 wire-customer 凭据后再次安装同一 pack
- THEN 以 credential-required 拒装，文案指名 wire 线凭据缺失，connectPath 指向
  wire-customer 连接卡

#### Scenario: lex 同形

- WHEN 上述两测以 lex 线条目与 lex 凭据重演
- THEN 结果同形（仅凭 lex 凭据可装、断开被拒且指向 lex 连接卡）

#### Scenario: registry 凭据替代不了线凭据

- WHEN 一个仅有活 registry 凭据、无 wire-customer 凭据的账号安装 wire 线 pack
- THEN 以 credential-required 拒装（其 registry 凭据不满足线凭据闸）

#### Scenario: 四既有 ref 闸行为零变化

- WHEN registry / facet-market / chatwoot / paper-trading 四类 ref 的条目在有/无对应
  凭据时分别安装
- THEN 拒装与放行行为与本 change 之前完全一致（含既有文案与 connectPath）
