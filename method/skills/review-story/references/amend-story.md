# A finding whose cause is the story

The judge marks `cause: story` when the code is not what is wrong: the story is ambiguous, two
of its criteria contradict, or one cannot be met. The engine shows it in the stack as `(story)`
and counts them: "amend the story, do not patch the code around it".

For the reviewer: say it in your note, with the words of the story that fail and what each
reading would give. Never change the story yourself.

For the developer, on a finding the judge marked so: do not fix the code to fit a text that is
wrong. Sort it (`review.triage`, root cause "story") only once the story is settled:
1. Propose the amended text to the creator in a `document` checkpoint on the story: only the
   sections after its Intent change; the Intent is the creator's alone.
2. Once the creator approved it, rebuild from the amended story and keep what already holds
   (name those parts to yourself first), then send it back to review.
3. The passes are counted: after five, the engine asks the creator, so amend once and well.
