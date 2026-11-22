// ── Board (product card) spec (openspec: enrich-fleet-template-member-config) ──
//
// 团队包的 `board[]` 描述的是**产物**：谁在什么节奏上产出什么卡片。它与
// `console` 是两件事，必须一直分得开：
//
//   board   = 这支队**产出什么**（doc / dashboard / form / record-view）
//   console = owner **怎么看它**（team / stream / kpi / decisions / spend / orchestration）
//
// 混用是真实的失败模式：两者都是「owner 看的东西」，混了之后「这支队产出什么」
// 与「我怎么看它」会长期被同一批字段描述，改一处坏两处。所以两个闭集在这里
// 做**互斥**校验——`board` 里出现 console 块名就拒收，反之亦然。
//
// ZERO DEPENDENCIES ON PURPOSE：与 `console-blocks-spec.js` 同一姿态。网关进程
// 会 import 校验器，所以这里不能拉 express / DB / server 代码。

import { CONSOLE_BLOCK_IDS } from "./console-blocks-spec.js";

/** 产物类型闭集。四个字面量取自蓝图 schema v2（`blueprints/schema.md` 的 `board[].artifact`）。 */
export const BOARD_ARTIFACT_KINDS = Object.freeze(["doc", "dashboard", "form", "record-view"]);

export const BOARD_LIMITS = Object.freeze({
  // 运维上限，与 console 的 maxBlocks 同量级：一张卡要有人读，才值得占一行。
  maxCards: 12,
  maxTitleChars: 80,
  maxDisciplineChars: 400,
});

/**
 * 校验一份 `board[]`。
 *
 * 三条判据各自能红：
 *   1. `artifact` 不在四个字面量里（含 **写成 console 块名** 这种串门）；
 *   2. `title` 空或超长；
 *   3. `discipline` 空或超长——它是「这一轮怎么投稿」的纪律，缺了就等于一张
 *      没人知道该怎么填的卡。
 */
export function validateBoardSection(section) {
  const errors = [];
  const fail = (message, entry, code) => errors.push({ error: message, entry, ...(code ? { code } : {}) });
  if (!Array.isArray(section)) {
    fail(
      `board must be an array of product cards (got ${section === null ? "null" : typeof section})`,
      "board",
      "board_not_array",
    );
    return errors;
  }
  if (section.length > BOARD_LIMITS.maxCards) {
    fail(`board declares ${section.length} cards; at most ${BOARD_LIMITS.maxCards} are allowed`, "board", "board_too_many");
  }
  section.forEach((card, i) => {
    const at = `board[${i}]`;
    if (!card || typeof card !== "object" || Array.isArray(card)) {
      fail("each board entry must be an object", at, "board_entry_not_object");
      return;
    }
    const kind = card.artifact;
    if (typeof kind !== "string" || !BOARD_ARTIFACT_KINDS.includes(kind)) {
      // 存量误用：三份元线包把 `board` 写成了 KPI 磁贴（`{key,label,note}`）。
      // 那是一种真实的误读——`board` 不是磁贴列表，是**产物卡**。直接丢枚举列表
      // 会让人以为「补个 artifact 字段就行」，所以这里把它点破并给出改法。
      if (typeof card.key === "string" && typeof card.label === "string" && card.artifact === undefined) {
        fail(
          `board[${i}] looks like a KPI tile ({key,label,note}) — board describes product CARDS, ` +
            `not metric tiles. If these are what the owner should SEE, move them under "console" ` +
            `(a "kpi" block); if they are what the team PRODUCES, give each an artifact ` +
            `(${BOARD_ARTIFACT_KINDS.join("|")}), a title and a discipline`,
          `${at}.artifact`,
          "board_legacy_kpi_tile",
        );
        return;
      }
      // 串门是这里最常见的一种错，所以单独给一句：告诉作者「这是 console 块名，
      // 该写进 console 段」而不是只丢一个枚举列表。
      if (typeof kind === "string" && CONSOLE_BLOCK_IDS.includes(kind)) {
        fail(
          `board[${i}].artifact '${kind}' is a console BLOCK id, not a product kind — ` +
            `board describes what the team PRODUCES (${BOARD_ARTIFACT_KINDS.join(", ")}); ` +
            `console describes what the owner LOOKS AT (${CONSOLE_BLOCK_IDS.join(", ")})`,
          `${at}.artifact`,
          "board_artifact_is_console_block",
        );
      } else {
        fail(
          `board[${i}].artifact must be one of ${BOARD_ARTIFACT_KINDS.join(", ")} (got ${JSON.stringify(kind)})`,
          `${at}.artifact`,
          "board_artifact_unsupported",
        );
      }
    }
    const title = typeof card.title === "string" ? card.title.trim() : "";
    if (!title) {
      fail(`board[${i}] needs a title`, `${at}.title`, "board_title_missing");
    } else if (title.length > BOARD_LIMITS.maxTitleChars) {
      fail(`board[${i}].title is ${title.length} chars; at most ${BOARD_LIMITS.maxTitleChars}`, `${at}.title`);
    }
    const discipline = typeof card.discipline === "string" ? card.discipline.trim() : "";
    if (!discipline) {
      fail(
        `board[${i}] needs a discipline — a card nobody knows how to fill is a card nobody fills`,
        `${at}.discipline`,
        "board_discipline_missing",
      );
    } else if (discipline.length > BOARD_LIMITS.maxDisciplineChars) {
      fail(`board[${i}].discipline is ${discipline.length} chars; at most ${BOARD_LIMITS.maxDisciplineChars}`, `${at}.discipline`);
    }
  });
  return errors;
}
