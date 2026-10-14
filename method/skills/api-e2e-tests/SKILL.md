---
name: api-e2e-tests
description: Set up the test framework from the validated stack, then write API and end-to-end tests from a story's criteria. Run by the developers.
metadata:
  agent: sam ethan hugo lina jade
  phase: build
---
# API and end-to-end tests

On the creator's ask ("set up the tests", "cover this feature end to end") or when a story's plan
puts a criterion at these levels. Two modes: **frame** (once for the product, or when a level has no
framework) and **cover** (the tests of a feature). Run under your own id (`agent: <your id>`), in
their language. Detail is read when needed: `references/frameworks.md` (choice, layout, data,
configuration), `references/generate.md` (levels, priorities, API and end-to-end tests, red then
green, what cannot be tested), `references/ci.md`.

1. **Start.** `agent.status` (`working`). `state.get`: `phase.current` is `build`, else say so and
   stop. The work lands in a story's branch: `story.start` on the story that asks for it (the first
   story of code, a story of its own that Izzy cuts, or the feature's own). No story: say so, hand
   back to Noah.
2. **Read what exists, and only that.** The validated stack: `.agentplugged/docs/architecture.md`
   or `spec.md` (language, framework, `dependencies`, services, data store), the test strategy
   when there is one (levels, data, thresholds), the conventions page of the knowledge base, the
   tests already there (runner, folders, names). In cover mode, the story and the journeys of the PRD
   and the UX specification; the feature's code only for names (routes, screens), never to decide
   what to test.
3. **Frame.** `npx agentplugged tests setup` reads the product's files: the runner of each level
   (found, asked or proposed), the one command that runs a criterion's tests, what to install; it
   writes `.agentplugged/proofs.yaml` as a proposal when the file does not exist, never over it. The
   validated stack wins: when a runner is only proposed and the architecture names another, run it
   again with `--runner` and `--e2e` (`none` for a product without a screen). Where it says an
   end-to-end runner cannot follow in the same line, report those runs as your word. A stack it
   does not know: `references/frameworks.md`. No language, no framework is imposed.
4. **Install.** The architecture normally plans the test tools in its `dependencies`. A framework
   it does not plan is a package that lasts: say so and hand back to Noah (the architecture is
   updated and approved again, never edit its `dependencies`). Then install as "Installing
   dependencies" says (one plain command, grouped, in the working copy): at the creator's
   `validate` mode it is one point of the stack, one gesture.
5. **Declare.** The command of `.agentplugged/proofs.yaml` runs a criterion's tests (the
   `{criterion}` line). Ask the creator once to accept it: `guard.creator_action`, `kind:
   proof_commands`. Never accept it yourself. Then one sample test per level in the layout of
   `references/frameworks.md`, run until it passes.
6. **Cover.** For each criterion and journey, follow `references/generate.md`: the lowest level that
   proves it, the scenario from the words of the criterion, the test named `AC-<story>-<n>`, seen
   red then green by `story.criterion` (`develop-story/references/acceptance-tests.md`). A journey
   that cannot be tested end to end: `story.criterion`, `seen: untestable`, the reason in `note`.
   A selector, a route or an endpoint not written yet: rate from 1 to 10 how sure you are of it;
   under 5, stop and ask the creator the one question that blocks most; from 5 to 6, write it and
   state the assumption in the result.
7. **CI.** `npx agentplugged ci setup` says which test scripts the product's CI does not run
   (`Not checked by the CI`); when there is none, `state.next` calls Omar. `references/ci.md`.
8. **Report.** `story.result`: the framework and what was installed, the tests per level, the trace
   line, the journeys not testable end to end and why, the tests run five times to check them.
   `agent.status` (`idle`).

## Never

- Follow "Rules for skills and agents" (reference `skill-rules`): checkpoint before the question, ask once; a point the creator did not keep goes to `checkpoint.decide`; in French say « tu »; start with `memory.read`.
- Never write a test from the code it checks, never weaken or skip a test to turn it green, never hide an unstable one behind a retry.
- Never install outside the rules above, never accept the commands yourself, never put a secret or a real person's data in a test.
- Never call, direct or wait for another agent: hand back to Noah.
