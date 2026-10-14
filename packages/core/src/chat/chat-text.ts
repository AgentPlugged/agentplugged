import { sha256Hex } from "@agentplugged/crypto";

/**
 * The creator's messages as the hook records them and as a quote is compared. The
 * generated hook script (`prompt-hook.ts`) holds the same function in JavaScript: a test runs the
 * script and checks both agree.
 */

/** Characters dropped at both ends: blanks, quotation marks, brackets and closing punctuation. */
const EDGES = /^[\s"'`.,;:!…*_~()[\]{}<>«»-]+|[\s"'`.,;:!…*_~()[\]{}<>«»-]+$/gu;

/**
 * A message or a quote, normalised: Unicode compatibility form (NFKC), zero-width characters and
 * emoji variation selectors removed, typographic quotes and apostrophes (« », “ ”, ’, ʼ) and
 * dashes made plain, lowercase, control characters and runs of blanks made one space, then blanks, quotation
 * marks, brackets and punctuation trimmed at both ends, except `?` (« on valide ? » is a question,
 * not an answer).
 */
export function normalizeChatText(text: string): string {
  const plain = text
    .normalize("NFKC")
    .replace(/​|‌|‍|⁠|﻿|︎|️/g, "")
    .replace(/[‘’‚‛′ʼ]/g, "'")
    .replace(/[“”„‟″«»]/g, '"')
    .replace(/[‐-―−]/g, "-")
    .toLowerCase();
  return [...plain]
    .map((char) => {
      const code = char.charCodeAt(0);
      return code < 0x20 || (code >= 0x7f && code < 0xa0) ? " " : char;
    })
    .join("")
    .replace(/\s+/gu, " ")
    .replace(EDGES, "");
}

/** The digest of a normalised message: SHA-256 of its UTF-8 bytes, lowercase hexadecimal. */
export function messageDigest(normalized: string): string {
  return sha256Hex(normalized);
}

/** The digest of a quote: its normalised form's. */
export function quoteDigest(quote: string): string {
  return messageDigest(normalizeChatText(quote));
}
