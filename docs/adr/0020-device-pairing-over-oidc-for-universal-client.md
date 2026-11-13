# 通用客户端登录走设备配对，不走 OIDC

壹座 App 是连接任意自建实例的通用客户端，而实例的 AUTH_MODE 有 none / forward_auth / logto 三种——OIDC 授权码+PKCE 只在 logto 实例成立，且要求每个实例主人改自己的 IdP 配置去注册 App 的 redirect scheme。我们决定泛化小程序已验证的绑定码路径为设备配对：App 生成 Ed25519 密钥对（私钥只留设备 SecureStore），凭 web 会话铸造的绑定码把公钥与账户绑定，之后每次启动以私钥签名经单次 nonce 挑战静默换发平台 JWT。身份子系统全复用小程序那套（MP_TOKEN_SECRET、signMpJwt、同一绑定存储，key 以 `app:` 前缀分 namespace，claims 加 kind/did），不另起炉灶。

## Considered Options

- **OIDC 授权码 + PKCE**：mode=none / forward_auth 实例根本没有 Logto；自建用户须改 IdP 配置，摩擦落在最不该承担它的人身上。
- **对称 secret + HMAC**：服务器绑定文件泄露即可冒充任意设备；非对称密钥把泄露面收敛到设备本身。

## Consequences

- 配对/挑战/签名换发的线协议与绑定存储形状上线即锁——已发版 App 在野，改动即破坏性变更。
- web 端必须提供已配对设备列表与撤销：没有撤销能力的设备凭证不该上线。
