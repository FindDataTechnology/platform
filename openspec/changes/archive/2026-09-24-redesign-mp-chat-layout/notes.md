# Verification notes: redesign-mp-chat-layout

Environment: WeChat devtools simulator (iPhone class), driven via wechatide
automation; miniapp built with `pnpm build:weapp` (clean compile, typecheck
clean). The simulator points at the local dev server on `localhost:3080`
(storage override) — the agent roster there is legitimately one entry: the
built-in agent ("Platform"; `ASSISTANT_NAME` unset, repo `agents.json` has
`agents: []`, registry/cloud catalog sources unconfigured locally). The
selection panel renders server truth faithfully; the same single row would
have shown in the old native Picker.

## Verified in devtools

- Header: three zones render (☰ / combined「智能体 · 模型」chip / ＋); old
  picker chips, text links, server row, and old welcome are gone from the
  compiled WXML; chip label = "Platform · DeepSeek V4.1 Flash".
- Panel: chip tap opens (slide-up + mask); sections render (智能体 with ✓ on
  current, 模型 roster); tapping the current row keeps the panel open with no
  mutation (no `pendingConfig`, chip unchanged); mask tap dismisses with no
  change. ⚠ Not exercised: an actual model/agent SWITCH ACK round-trip
  (avoided restarting the shared dev dsh runtime) — the send path is byte
  -for-byte the old picker's `set_model`/`set_agent` + `setPendingConfig`
  contract. The 模式 section's positive branch (presets listed on a blank
  session) could not render because this server serves zero presets; the
  gating expression is verbatim from the old picker (`turns.length === 0 &&
  presets.length > 0`) and the omission branch is verified.
- Welcome: 4 suggested-prompt cards render (texts match web zh-CN bundle);
  tapping a card prefills the draft (verified value = prompt text) and sends
  nothing; 查看历史 › / header ☰ navigate to the sessions page.
- Composer: one card holds textarea + attach + circular send; empty-draft
  tap is inert (no turn appended); while streaming the send slot becomes the
  ■ stop control and restores on completion; compiled CSS uses
  `calc(env(safe-area-inset-bottom) + …rpx)` and the card clears the home
  indicator in screenshots. ⚠ Not exercisable via automation: the keyboard
  -raised state superseding the safe-area pad (pre-existing inline-style
  path, unchanged). Attachment chips inside the card use the same JSX moved
  verbatim; not live-exercised (no file picker in automation).
- Reply actions: completed assistant turns show 复制 (both turns) and
  重新生成 (last turn only — counts asserted 2/1 across two assistant turns);
  复制 put the turn's text ("好的") on the clipboard (native weapp toast);
  重新生成 appended a new user+assistant turn pair, leaving prior turns
  untouched (honest regeneration contract).
- Sessions page: 服务器 row pinned at the bottom (safe-area padded) with the
  stored base URL prefilled; save/reconnect logic is the chat-header row
  moved verbatim (not re-exercised to avoid mutating the user's storage).
- Test artifacts left behind: two "只回复两个字：好的" turn pairs in the
  active dev session; devtools storage untouched.

## Build

- `pnpm typecheck` clean; `pnpm build:weapp` compiles successfully; all new
  classes present in `dist/app.wxss`; pxtransform emitted the intended
  `calc(env(safe-area-inset-bottom) + N rpx)` forms.
