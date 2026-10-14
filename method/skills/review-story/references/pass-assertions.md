# Pass: assertions

Run this one last. Your lenses went through the code before you looked at what the change says of
itself, so that its own account could not tilt them. Now read that account: the story's criteria
and intent, the comments the change adds and, when `review.start` gave a `statements` file, the
commit messages. It records what the author hopes is true. Saying it twice, in a comment too, adds
nothing.

Pick every sentence that makes a promise you can test: it does this, it keeps that, this happens
before that, the total is such, it behaves like the other piece of code. For each, look for the
line that would make it false, using what you already walked through. If that is not enough, read
the code that decides: the thing it is compared with, the function really called, the state the
sentence takes for granted. A promise that holds gets no line.

A broken promise is a finding, in your `verification_gaps` report: the title says the promise in a
few words, the evidence what the code does instead, the recommendation what to change, the code or
the sentence. Answer shape: `format.md`.
