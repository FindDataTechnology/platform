# tasks

- [x] 1. lib/pack-manifest.js：SERVING_KEYS 增 `toolFace` + 枚举校验（v1 仅 "chat"）
- [x] 2. lib/agent-serving.js：composeDescriptor 携带 `tool_face`
- [x] 3. dsh-profile.js：TOOL_FACE_DROPS.chat + writeToolFacePatch（disable 清单落
       tool-face.patch.yml；未知档位抛错）
- [x] 4. agent-runner/compose.js：descriptor.tool_face 门控挂载 + 单测三件
       （manifest 校验/物化挂载与内容/未声明零变化）
- [x] 5. 范例跟进：寻数分身 v5（reception 声明 chat 面）+ 工坊 v5（模板接待骨架加
       toolFace、硬约束清单补一条）双发布
- [x] 6. 上产：出片四面滚（runner 必滚）→ 重部署寻数分身 v5 → 生产验证：访客回合
       工具清单眼见（bash/grep/read/web_search 消失；skill/ask/bot_notify/matter 在）
- [ ] 7. 台账 §15.44；归档
