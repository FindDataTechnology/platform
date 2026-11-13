# 组合根是可弃置的物化产物

dsh 的 `customSkillDirs` 是一层扁平的目录根列表，没有单技能粒度；角色级资源声明（add-persona-resource-sets）与覆盖偏好的技能增删都需要「按预设生效的技能根」。决定：persona 根放在 `custom-skills/packs/<packId>/personas/<agentId>/` 下，内容是指向包根内技能目录的符号链接集合（dsh-skill-filesystem 用 `stat` 跟随符号链接；一层扫描在全量模式把 `personas/` 当无 SKILL.md 的子目录静默忽略），每次写 skills patch 时从 DB 的 custom-skills 行重建，永不就地编辑。推论：根是可弃置物——删除或损坏都在下一次组合自愈；真源永远是 DB，符号链接只是零复制的物化手法（dsh 某路径不跟链接时可退化为副本，同样无漂移）。
