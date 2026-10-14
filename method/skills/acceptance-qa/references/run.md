# Pilots, the `browser-qa` command and the proofs

## The app must be running

The scenarios run against the application as it stands in the story's branch. Its address comes from
the story, the architecture or the creator. If nothing answers, ask the creator once to start it:
you never start a server and never run a command that is not declared in
`.agentplugged/proofs.yaml` and accepted by the creator.

## Pilot 1: the browser of your host

On Claude Code, use the browser tools your host gives you (open a page, click, type, read the page,
take a screenshot). Save each screenshot in `.agentplugged/.cache/qa/`, named
`AC-<story>-<n>-<what>.png` (`AC-18-5-2-total-shown.png`), and a video when the pilot records one
(`.webm`). Verdict by criterion: `passed` when you saw the result the criterion states, `failed`
when you saw another (say what, in `observed`), `blocked` when you could not play it (the page did
not load, a step was missing: say why). Your verdicts are marked `reported`: your word, with the
proofs behind it.

## Pilot 2: Playwright, played by the engine

Without a browser pilot, the engine plays each criterion itself with a command named `browser-qa`.
Declare it once in `.agentplugged/proofs.yaml`, with `{criterion}` in the line, once in the output
folder (each criterion gets its own: Playwright empties the folder it writes to) and once in the
filter, followed by a space inside quotes so that criterion 2 does not replay criterion 21:

```yaml
commands:
  - name: browser-qa
    run: npx playwright test -c playwright.qa.config.ts --grep "{criterion} " --output ../../<project>/.agentplugged/.cache/qa/{criterion}
    timeout: 300
```

The story's working copy sits beside the project (`../<project>.worktrees/<story>`), hence the path
to the project. The configuration file `playwright.qa.config.ts` (committed in the story's branch,
so that the review reads it) turns on `video: 'on'` and `screenshot: 'on'`, titles its tests with
the criterion's id followed by a space (`test('AC-18-5-2 shows the total', ...)`) and starts the app
in `webServer` with the start command the creator knows, `reuseExistingServer: true`. Ask the creator
once to accept the line (`guard.creator_action`, `kind: proof_commands`); the engine runs nothing
before. Then `review.qa` with `{criterion, run: true}` for each scenario: the engine clears the
criterion's earlier proofs, runs the line in the working copy, reads the verdict from the exit code
(0 passed, another code failed, a stop or a start that failed blocked) and keeps the files the run
wrote under the criterion's id. Playwright is installed by the developers (`api-e2e-tests`); if it
is missing, say so and use pilot 1.

## The proofs

They are files in `.agentplugged/.cache/qa/` (ignored by Git, outside the journal): images
(`png`, `jpg`, `webp`) and videos (`webm`, `mp4`), at most six per criterion, each under 64 MB. The
journal keeps for each one its path, its size and a SHA-256, so that a proof changed afterwards no
longer matches. A file whose path does not carry the criterion's id is not that criterion's proof; a file that does
not begin as the image or video its name says, an empty one and a link are not proofs either. The
name uses letters, digits, dot, dash, underscore and `/` only.
The folder is local: when the creator wants to share proofs, they copy them from there.
