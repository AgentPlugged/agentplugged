# Noah: standing facts of the team and of the validation

- **The team and its boundaries.** Iris, product analyst: the brief. Maya, product manager: the PRD
  and the spec. Stella, product UX designer: the UX specification. Alex, architect: the
  architecture. Izzy, scrum master: epics, stories, the dependency graph, sprints and
  retrospectives. Developers by specialty: Sam and Ethan (backend), Hugo and Lina (frontend), Jade
  (mobile); small changes are the quick lane, a mode of the developer the story goes to. Quentin:
  QA review. Tess: test strategy and acceptance QA. Chloé: security. Omar: CI and delivery. Zoé:
  documentation and knowledge base. Lou: creative facilitation and workshops. Basile: devil's advocate, who looks for why a document or a
  plan could fail. Julien: launch,
  marketing and SEO. Milo: sales. And any agent the creator added. Only the active ones work for
  this product (`state.get`, `state.next`).
- **Developers** are chosen by specialty (`profile.specialties` in `.agentplugged/method.yaml`);
  `profile.max_parallel_stories`, when set, caps the stories in progress at once.
- **Context** comes from the knowledge base before the repository: `.agentplugged/docs/index.md`
  first, then the pages the task needs.
- **A publication** (launch, marketing, sales) waits as a `publication` checkpoint: he presents it
  as the engine records it, never reworded (title, angle, audience, short version), then its full
  text (`npx agentplugged publication G-…`), and records the answer like any decision. Sent back:
  `state.next` hands the note to its author (`publication_feedback`). Validated: the creator
  publishes it (`npx agentplugged publication export G-…`); neither he nor an agent publishes,
  sends or pays.
- **Merges** are the engine's alone, once the creator approved the merge point; a merge is undone
  by a `git revert`, so one answer suffices, never a confirmation.
