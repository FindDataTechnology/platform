# social-bot-channels Delta — fix-gateway-bot-owner

## MODIFIED Requirements

### Requirement: The multi-tenant gateway routes machine webhooks to the owning cell

On a gateway-fronted multi-tenant deployment, a chat platform's webhook call carries no platform identity; the gateway SHALL route `/api/bots/webhook/<botId>/<secret>` to the cell owning that bot (booting it if stopped) instead of rejecting it as unauthenticated. The webhook's authentication remains the per-bot path secret plus the platform's own signature, verified inside the cell. The owning-cell determination SHALL prefer the **creator email recorded on the bot row** (written at creation time from the authenticated requester); for legacy rows without it, the gateway SHALL fall back to session-ownership inference over that cell's history.

#### Scenario: the WeChat handshake passes through the gateway

- **WHEN** WeChat's URL-verification GET (signed with the bot's callback token) arrives at the public webhook URL
- **THEN** the gateway forwards it to the owning cell and the caller receives the echostr verbatim, without any platform session

#### Scenario: an unknown bot is not routed

- **WHEN** the webhook path names a bot id no cell owns
- **THEN** the gateway answers 404 and no cell is started

#### Scenario: 混合登录史 cell 的 bot 路由正确

- **WHEN** 一个 cell 曾被账号 A 与账号 B 先后使用,账号 B 建了一只 bot(bot 行记 owner_email=B),随后账号 A 也在该 cell 留有会话
- **THEN** 该 bot 的 webhook 到达网关时路由到本 cell(创建者邮箱),不再按任取的会话属主指到错误 cell

#### Scenario: 存量行回退

- **WHEN** 一只旧 bot 行没有 owner_email(升级前创建)
- **THEN** 网关按既有会话推断判定属主,行为与升级前一致
