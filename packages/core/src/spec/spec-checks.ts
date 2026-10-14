import { ErrorCode } from "@agentplugged/protocol";
import type { DocsProblem } from "../docs/docs-base.js";
import type { ParsedDocument } from "../docs/parse-document.js";
import { choosePath, readScope } from "./path-rules.js";

/**
 * The problems of the `kind: spec` documents: the scope the header declares must be
 * readable, and a product with personal data, payments or accounts is on the short path only when
 * the creator asked for it (`asked: short`). A spec that outgrew the short path is not a problem
 * here: `next` says it, in one line, and proposes the full path.
 */
export function specScopeProblems(documents: readonly ParsedDocument[]): DocsProblem[] {
  const problems: DocsProblem[] = [];
  for (const document of documents) {
    if (document.kind?.value !== "spec" || document.header === undefined) continue;
    const problem = (reason: string, why: string): DocsProblem => ({
      code: ErrorCode.SPEC_SCOPE,
      message_key: "error.spec_scope",
      details: { path: document.path, line: document.idLine, reason, why },
    });
    const scope = readScope(document.header as Record<string, unknown>);
    if (!scope.ok) {
      problems.push(problem("scope", scope.reason));
      continue;
    }
    const choice = choosePath(scope.criteria);
    if (choice.risky && scope.criteria.asked !== "short") {
      problems.push(problem("risk_not_asked", scope.criteria.sensitive.join(", ")));
    }
  }
  return problems;
}
