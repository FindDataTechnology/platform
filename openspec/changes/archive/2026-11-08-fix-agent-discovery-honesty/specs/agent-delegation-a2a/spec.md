## MODIFIED Requirements

### Requirement: Discovery is two-level

The `delegate_task` tool description SHALL carry only a category summary of the market's online a2a agents (counts per category), never the full roster. A separate `search_agents` tool SHALL return, for a keyword query, a page of candidates (name, description, category, catalog id) from the currently online a2a entries — the delegating persona picks a ref from those results. That page SHALL be bounded (default 8, caller-settable up to 50) AND SHALL report the number of MATCHES together with whether the page was truncated; a capped page SHALL NOT be presented as the whole match set. The page order SHALL be deterministic (independent of the catalog's scan order), so the same query yields the same page. The summary and search results SHALL derive from the same catalog view that serves human a2a chats, with no separate discovery store.

#### Scenario: The tool description stays small

- **WHEN** the delegation tools are materialized into a cell
- **THEN** the delegate description carries category counts, not the individual agents

#### Scenario: Search returns ranked candidates

- **WHEN** the persona calls search_agents with a keyword
- **THEN** the result lists at most N online a2a agents matching the keyword with their names, descriptions, and catalog ids

#### Scenario: A ref must come from discovery or the roster

- **WHEN** a delegate call names an a2a ref that search or the catalog cannot resolve
- **THEN** the task is refused as an unknown target

#### Scenario: 截断时必须说出真实匹配数

- **WHEN** 关键词匹配到 12 个在线 a2a 条目而默认页只有 8 条
- **THEN** 结果携带匹配总数 12 与「已截断」标志，`search_agents` 的文本写明「showing 8 of 12 matches」并提示收窄关键词或提高 limit

#### Scenario: 页大小有上界且可放大

- **WHEN** 调用方要求 limit=20（或超出上界的 999）
- **THEN** 返回至多 20 条（999 时按 50 封顶），非法或非正的 limit 回落默认 8

#### Scenario: 同一查询得到同一页

- **WHEN** 同一批在线条目以不同内部顺序被搜索两次
- **THEN** 两次返回的候选页完全相同（按名称、再按 id 的确定性排序）

