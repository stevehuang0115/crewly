/**
 * Take internal decision and ticket ids out of a post the owner reads
 * (crewly#1427): agents kept writing "（决策卡 D-919 批准后…）" and
 * "It shipped with D-897" to the owner, though cards and tickets are
 * internal. The prompt rule alone did not hold, so the harness removes them
 * from agent posts into the owner's conversations.
 *
 * Posts addressed to an agent (`@Name …`) keep their ids: colleagues need them.
 *
 * @module utils/owner-text-ids.utils
 */

import { OWNER_TEXT_IDS_CONSTANTS } from '../constants.js';

const C = OWNER_TEXT_IDS_CONSTANTS;
const MARK = '\u0000';
/** "和 ⟨mark⟩" → "和⟨mark⟩" */
const CJK_SPACE_BEFORE_MARK = /([\u4e00-\u9fff])[ \t]+(?=\u0000)/g;
/** "⟨mark⟩ 是" → "⟨mark⟩是" */
const CJK_SPACE_AFTER_MARK = /(?<=\u0000)[ \t]+(?=[\u4e00-\u9fff])/g;
/** "text ⟨mark⟩," → "text⟨mark⟩," */
const SPACE_BEFORE_PUNCT_AT_MARK = /[ \t]+(?=\u0000[ \t]*[,，。.:：;；)）])/g;

/**
 * The text with internal ids removed, or the text unchanged when it is
 * addressed to an agent. Code spans and links are left alone.
 *
 * - "决策卡 D-919" / "card D-7" → the noun alone
 * - "(D-897)" / "（D-851 / TKT-537）" → removed
 * - any other id → "那张卡" / "that card" (by the text's language)
 *
 * @param text - The post
 * @returns The text without internal ids
 *
 * @example
 * stripOwnerTextIds('这一项已随另一张卡(D-897)一起上线') // '这一项已随另一张卡一起上线'
 */
export function stripOwnerTextIds(text: string): string {
  if (!text || C.AGENT_MENTION_PATTERN.test(text)) return text;
  const chinese = C.CJK_PATTERN.test(text);
  const fallback = chinese ? C.FALLBACK_ZH : C.FALLBACK_EN;
  return text
    .split(C.PROTECTED_PATTERN)
    .map((part, i) => {
      // Odd parts are code spans and links (the split keeps the captured separators).
      if (i % 2 === 1) return part;
      // Each change leaves a mark, so the spaces that stood around an id can
      // go where it sat between Chinese characters, and nowhere else.
      return part
        .replace(C.PAREN_ONLY_IDS_PATTERN, MARK)
        .replace(C.NOUN_THEN_ID_PATTERN, `$1${MARK}`)
        .replace(C.ID_PATTERN, `${MARK}${fallback}${MARK}`)
        .replace(CJK_SPACE_BEFORE_MARK, '$1')
        .replace(CJK_SPACE_AFTER_MARK, '')
        .replace(SPACE_BEFORE_PUNCT_AT_MARK, '')
        .replace(/\u0000/g, '');
    })
    .join('');
}
