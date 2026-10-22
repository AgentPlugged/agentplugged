# A finding whose cause is the story

The judge marks `cause: story` when the story is ambiguous, contradicts itself or cannot be met:
"amend the story, do not patch the code around it".

- Reviewer: say it in your note, with the words that fail and what each reading gives. Never
  change the story yourself.
- Developer: never fit the code to a wrong text. Propose the amended text in a `document`
  checkpoint on the story (only the sections after its Intent, which is the creator's alone);
  once approved, rebuild from it, keep what holds, send it back to review, then sort the finding
  (`review.triage`, root cause "story"). After two passes the engine asks the creator: amend once.
