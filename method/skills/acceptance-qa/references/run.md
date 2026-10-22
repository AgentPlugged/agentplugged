# Pilots, the `browser-qa` command and the proofs

## The app must be running

The scenarios run against the application as it stands in the story's branch. If nothing answers, ask the
creator once to start it: you never start a server nor run a command not declared in
`.agentplugged/proofs.yaml` and accepted by the creator.

## Pilot 1: the browser of your host

Use your host's browser tools. Save each screenshot in `.agentplugged/.cache/qa/`, named
`AC-<story>-<n>-<what>.png` and a video when the pilot records one
(`.webm`). Verdict by criterion: `passed` when you saw the result the criterion states, `failed` when
you saw another (say what, in `observed`), `blocked` when you could not play it (say why). Your
verdicts are marked `reported`.

## Pilot 2: Playwright, played by the engine

Without a browser pilot, the engine plays each criterion with the command `browser-qa`. Declare
it once in `.agentplugged/proofs.yaml`, with `{criterion}` in the line, once in the output folder (each
criterion gets its own) and once in the filter, followed by a space inside quotes so that criterion
2 does not replay criterion 21:

```yaml
commands:
  - name: browser-qa
    run: npx playwright test -c playwright.qa.config.ts --grep "{criterion} " --output ../../<project>/.agentplugged/.cache/qa/{criterion}
    timeout: 300
```

The story's working copy sits beside the project. The committed
`playwright.qa.config.ts` turns on `video: 'on'` and `screenshot: 'on'`, titles its tests with the
criterion's id and a space (`test('AC-18-5-2 shows the total', ...)`) and starts the app in
`webServer` with `reuseExistingServer: true`. Ask the creator once to accept the line
(`guard.creator_action`, `kind: proof_commands`). Then `review.qa` with `{criterion, run: true}` per
scenario: the engine clears the earlier proofs, runs the line, reads the verdict from the exit code
(0 passed, another failed, a stop or failed start blocked) and keeps the files.
Playwright comes from the developers (`api-e2e-tests`); missing, use pilot 1.

## The proofs

Files in `.agentplugged/.cache/qa/` (ignored by Git): images (`png`, `jpg`, `webp`) and videos
(`webm`, `mp4`), six per criterion, each under 64 MB. The journal keeps each one's path,
size and a SHA-256, so a proof changed afterwards no longer matches. A file whose path lacks the
criterion's id, an empty one, a link, or one not beginning as the image or video its name says is not
a proof.
