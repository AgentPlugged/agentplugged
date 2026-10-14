# agentplugged

Installs the AgentPlugged method in a repository, then makes its agents callable by name from
Claude Code, Codex, Antigravity CLI / Gemini CLI and Cursor. No account, no server, no native
module: Node.js 24 or later is all it needs, on Windows, macOS and Linux.

## Quick start

```sh
npx agentplugged init      # install the method in .agentplugged/ and choose the product profile
npx agentplugged sync      # generate the files each AI tool reads (skills, agents, AGENTS.md…)
```

At a terminal, `init` looks at your machine first (Node, Git, the forge's tool, your AI tools, the
keychain), offers to repair what is missing (the exact command is shown, run after one key, the point
read again), asks its few questions in keyboard menus (arrows, space, Enter; Escape goes back; every
question has a recommended answer, so Enter all the way gives a correct installation), writes the
files of your AI tools (`sync`) and ends with « Open Claude Code in this folder and write: noah ? ».
Nothing is installed without you having seen the command, and a point that is not repaired never
stops the installation. In a script, `init` asks nothing: `--yes` takes the recommended answers (and
writes the tools' files), `--tools claude-code,cursor`, `--profile`, `--permissions`, `--no-sync` and the
other options set everything, and the exit code is 1 when a blocking point remains.

`init` never overwrites your `AGENTS.md`, `CLAUDE.md` or `GEMINI.md`: it adds a pointer to the
method once. Run it again to refresh the method; your documents, stories, settings and
`overrides/` are kept.

## Commands

| Command | What it does |
| --- | --- |
| `init` | Installs or refreshes the method, detects the AI tools, records the profile. |
| `doctor [--json] [--report]` | Looks at your machine: Node, Git (installed, a repository, name and e-mail), the forge's tool (installed, even outside the PATH; connected), your AI tools, the keychain, Windows Hello, and what the stack asks for (the `prerequisites` of the architecture: tools with a minimum version, free ports, memory). One line per point (✓ ready, ⚠ to improve, ✗ blocking); for each point it can repair, the exact command, then one key. A sign-in (`gh auth login`) runs in your terminal and browser; AgentPlugged never sees the token. Exit code 1 when a blocking point remains. The checks are data (`method/doctor.yaml`). `--report` prints the report to attach to a request for help (system, versions, result of every check, nothing personal: no account name, personal path, token or product content; the list of what it removes is at its end), and repairs nothing. |
| `profile` | Changes what the method does for this product (domains, phases, developer specialties and the ceiling of stories at once) and its validation level (`--validation chat\|auto\|strict`). |
| `sync` | Generates the AI tools' files from the method and your customisations. |
| `agent create\|edit\|enable\|disable <id>` | Manages your own agents and skills. |
| `mcp` | Runs the MCP server (stdio only) your agents report their status, progress, costs and results through. `sync` declares it in each AI tool's project configuration, pinned to your engine version. |
| `review [<G-id>]` | Answers a checkpoint your agents opened, in an interactive terminal only: its card, numbered actions, then your answer signed by your key (`locale`, or `presence` with Windows Hello). It also reopens a checkpoint applied automatically at the `auto` level. It is the way of the `strict` level; at the other levels you answer in the chat. |
| `key presence [--reset]` | Protects your validations with Windows Hello (Windows only; `init` proposes it). Without it, they keep the `locale` assurance. `--reset` creates the credential again when the stored one no longer works. |
| `key endorse [<human:…>]` | Lists the creator keys waiting for an endorsement, or endorses one you trust. |
| `key export [--out <file>]` | Exports the product key, encrypted with a passphrase you type twice (at least 12 characters), to use it on another machine. `--out` writes a new file outside the repository. |
| `key import [--in <file>]` | Imports the product key exported on another machine, after checking it is this product's and the one its journal announces. Without `--in`, you type the export (it is not shown): it never goes on the command line. |
| `key seal` | Encrypts the files of `.agentplugged/salle/` and `.agentplugged/memory/` still in clear. |
| `trust dismiss` | Interactive terminal only. When the journal holds a creator key that is not the root pinned on this machine (`SECURITY_ROOT_CHANGED`: no order is given), names the event, asks one question (default no), then publishes `trust.dismissed`, signed by your key. Nothing to do otherwise. |
| `history` | Lists your validations, most recent first (`--story`, `--since`, `--decision`; `--all` adds the answers the journal ignored, with their reason). `--export <file.json\|file.csv>` writes them to a file (`--force` replaces an existing one). |

### Answering in the chat: validation levels

By default you answer checkpoints in the chat of your AI tool, typed or dictated: the agent
presents the checkpoint (question, options, recommendation, risk), then records your answer with
the MCP tool `chat.answer`, quoting your whole message word for word. `validation.mode` in
`.agentplugged/method.yaml` (read from the main branch, set by `init` or `profile`, never by an
agent) chooses how:

- `chat` (the default): every checkpoint in the chat, with one answer (a word, a letter, a click
  or your own sentence), whatever its risk: never a second message, a sentence to copy or a terminal.
  An action that cannot be undone and acts outside the product (a deployment, a publication, a
  message sent, a payment) is named, with its effect, in the question itself. The journal keeps the
  trace of every answer: who, what, when, the proof and the channel.
- `auto`: a low-risk `decision` or `document` checkpoint with a recommended option takes it on
  its own (« applied automatically »); you reopen it in the chat or with `review`. The rest goes
  through the chat.
- `strict`: like `chat`, but a high-risk checkpoint is answered at the terminal only, with
  `review` and your key.

In Claude Code, `sync` writes a `UserPromptSubmit` hook of type `command`
(`.claude/hooks/agentplugged-prompt.mjs`): it records each message you send (normalised text,
digest, time, session) in `~/.agentplugged/chat/`, outside the repository and the journal, for
24 hours. The engine accepts a quote only when it is one of your messages of that session, sent
after the checkpoint opened, and not already used for another checkpoint; otherwise nothing is
written (`CHAT_QUOTE_NOT_FOUND`). In the other AI tools, answers are recorded « unverified »
(`chat_unverified`) and shown so everywhere. The deny rules `sync` writes keep agents from the
store and the script; they are best-effort: an agent that deliberately works around its
permission profile is out of reach of this check, and `strict` is there for that.

### Decisions to click

When your AI tool can show it, the engine asks a decision in a way you answer with a click, never
by typing « a » or « yes ». It uses, in this order, the form of the client (the MCP « elicitation »:
it works in the terminal of Claude Code), then the tool's question tool (`AskUserQuestion`: in the
VS Code extension of Claude Code, which refuses the form at once, the choices appear in the
conversation window), then the chat. In Claude Code, `sync` also writes a hook on that question tool
(`PostToolUse`, `.claude/hooks/agentplugged-decision.mjs`) that records your answer in
`~/.agentplugged/chat/`, for 24 hours; the engine reads your click from that record and accepts it
only when the questions are exactly the ones it dictated, for that checkpoint, once. A decision is
one question and one click, whatever its risk (an action that cannot be undone is named in it); at
the `strict` level a high risk stays at the terminal. `npx agentplugged history` shows the answer with its channel
(« choisie dans la fenêtre de questions (claude-code) »). Without the hook (`sync` not run), the
engine falls back to the chat and says so.

### Your other decisions in the chat

The actions only you decide are taken in the chat too: accepting a story without its CI (with
your reason, recorded in the journal), closing a deferred item you own or dropping one, lifting a
deviation, changing the profile or the validation
level (`profile`), creating, setting, enabling or disabling an agent or a skill (`agent
create|edit|enable|disable`). Say it to your agent (« pass the CI of story 4-3, the runner is
down »): it asks for the action with the MCP tool `guard.creator_action`, which the engine
checks as the terminal command would, then opens a `creator_action` checkpoint whose risk the
engine sets. You answer it like any checkpoint, in the chat; once approved,
the engine carries the action out itself, in the same write as your answer
(`creator_action.executed`, with the source and your words), then writes the files and runs
`sync` for an agent or the profile. One answer is enough, a CI waiver included; at the `strict`
level only, a high-risk action (a CI waiver, dropping security work, lowering the validation
level) goes through the terminal. The terminal commands (`story ci --waive`, `deferred`,
`trace resolve`, `profile`, `agent`) still work.

A new agent or skill asked for in the chat arrives complete, never as a template to fill: the
request carries its whole definition (overview, what it produces, how it works, what it never does,
principles and menu for an agent; steps, outputs and rules for a skill), the engine rewrites it for
the agent to show you unchanged, `review` and the AI tool's form show it too (the form only up to
4 000 characters; beyond, your agent shows it in the chat), and once you approve, the engine writes
exactly that text, then runs `sync`. `agent_edit` completes a skeleton the same way and replaces
the whole body and menu of that agent. `npx agentplugged agent create` still writes a template to
fill.

### Validation history

- `history` only reads the journal: it writes nothing there and never touches the keychain.
- `--since 2026-10-03` means local midnight; a date and time needs its offset
  (`2026-10-03T12:00:00Z`, `2026-10-03T14:00:00+02:00`).
- **The JSON export is the exact one** (canonical JSON, English fields, UTC dates); with
  `--all` it is `{ "validations": [...], "ignored": [...] }`. **The CSV export is for
  spreadsheets**: UTF-8 with a byte order mark, and a cell that would start a formula (`=`, `+`,
  `-`, `@`, tab, CR) is prefixed with `'`; its `ignored_reason` column is empty for valid
  validations.
- The export never replaces a file without `--force`, and never goes into `.agentplugged/` or
  `.git/`; its folder must exist.

### Your validation key

- `init` creates your validation key (in the system keychain) on the first install on a machine,
  and now **writes to the journal** (branch `agentplugged/journal`) when the folder is a Git
  repository: the machine's key (`device.registered`), the product (`product.created`) and your
  key (`human.key_registered`).
- The first creator key registered in a product is its root key. Any later key (another
  machine, another person) is **pending**: its answers are ignored until a trusted creator runs
  `npx agentplugged key endorse <human:…>`. `review` lists the pending keys.
- `review` and `key` run in an interactive terminal only, and refuse otherwise. `sync` also
  writes deny rules so that agents never launch them (`npx`, `npm exec`, `pnpm dlx`, `pnpx`,
  `bunx`, `yarn dlx`, the installed binary): these rules are **best-effort**. The real guards are
  the interactive terminal and the endorsed creator key that must sign every answer.
- `AGENTPLUGGED_ENVIRONMENT=none` turns the look at the machine off (`doctor` and the first step of
  `init`), for a script that knows its machine and for the tests. `AGENTPLUGGED_MENUS=off` keeps the
  numbered questions even in a terminal.
- `AGENTPLUGGED_PRESENCE=none` turns Windows Hello off for the process (tests and CI): nothing
  ever prompts, and validations keep the `locale` assurance.
- On Windows, Windows Hello goes through the optional dependency `koffi`. Its install script
  (`cnoke --prebuild`) only checks for the prebuilt binary shipped by `@koromix/koffi-<platform>`;
  it never compiles anything. Without `koffi`, validations keep the `locale` assurance.

### The product key: encrypted sensitive content

Your repository may be public: costs, security notes, the Salle and the memory must not be
readable by everyone. They are encrypted with the **product key**.

- **What it is:** 32 random bytes, created by the product's first `init` and kept in the system
  keychain (service `agentplugged`, account `product:<product_id>`), **never in the
  repository**, the journal, a log or an agent's output. The journal only announces its public
  identifier (`product.key_created`, `pk:…`) with a proof that only a holder of the key can make
  and check; the first valid announcement is the product's key. The key itself never encrypts
  anything: one subkey per purpose is derived from it (identifier, proof, events, files).
- **What is encrypted (XChaCha20-Poly1305):** the content of the sensitive events (`cost.reported`,
  and the future `salle.*`, `security.*` and `memory.*`), bound to the rest of each event; and
  every file of `.agentplugged/salle/` and `.agentplugged/memory/`, bound to the product and to
  its path, which agents read and write through the `guard.read_sensitive` and `guard.write_sensitive` tools
  only. A file found there in clear is never served: run `npx agentplugged key seal` to encrypt
  it. Your documents (`docs/`, `epics/`, `stories/`) are never encrypted. Costs reported before
  the key was announced stay readable as they are; a sensitive event in clear after it is
  ignored.
- **Never in clear on disk:** `.agentplugged/.cache/state.json` (ignored by Git) holds the state
  without the decrypted content; `journal status` and `state.get` decrypt it in memory only.
- **Saved and shared by the engine itself:** the journal is sent to the remote a few seconds after
  each write and fetched before the state is read, without force, with no command and no setting;
  offline, the engine goes on locally and catches up when the connection returns. A public
  repository never receives it: the engine uses the private repository `agentplugged-journal`
  (Noah offers to create it, one « oui »). Only when the backup is impossible (no remote, access
  refused) does Noah say so, once. On a new machine, opening the product with the AI tool (or
  `init` in the clone) receives the journal; `journal sync` stays the manual gesture.
- **Another machine:** after a clone, `init` first receives the journal from the remote (or run `npx agentplugged journal sync` yourself); it creates no
  key in a clone that has not received the journal (or when the remote does not answer), and
  none when the journal announces one: it tells you to import it. On a machine that has it, run
  `npx agentplugged key export`: it asks a passphrase twice and prints `apk1:…`, the key
  encrypted by Argon2id and XChaCha20-Poly1305 and bound to this product; `--out <file>` writes
  it instead to a new file outside the repository (never replaced; readable by your account only
  on macOS and Linux; on Windows no access rule is set, the file inherits its folder's). On the
  new machine, run `npx agentplugged key import --in <file>`, or `key import` and type the
  export (it is not shown, and never goes on the command line), then the passphrase. A different
  key held there is replaced only once you type « je confirme », and kept in the keychain under
  `product:<product_id>:previous:<key_id>`. These commands run in an interactive terminal only.
- **Without the key**, a machine still computes the state of the product: the encrypted events
  are counted and chained, but their content is missing (`journal status` warns that they cannot
  be read here), and any sensitive write is refused (`PRODUCT_KEY_MISSING`).
- **A lost product key makes the encrypted content unreadable for ever.** Keep an export, and its
  passphrase, somewhere safe.
- **Known limits:** an older version of an encrypted file, taken from the Git history, still
  decrypts (no protection against going back to an earlier version); the product key cannot be
  rotated yet.

`npx agentplugged --help` lists every option; `npx agentplugged --version` prints the version.
Set `AGENTPLUGGED_LANG=fr` for French messages.

## The MCP server

`sync` declares the `agentplugged` MCP server in each targeted tool's project configuration:
`.mcp.json` (Claude Code), `[mcp_servers.agentplugged]` in `.codex/config.toml` (Codex),
`.agents/mcp_config.json` (Antigravity CLI), `.cursor/mcp.json` (Cursor), and
`.gemini/settings.json` (older Gemini CLI installations) only when that file already exists.
By default the tools start it with `npx -y agentplugged@<engine_version> mcp`.

- **Windows:** AI tools cannot start `npx` directly there, so `sync` run on Windows declares
  `cmd /c npx -y agentplugged@<engine_version> mcp`. In a team that mixes Windows with macOS or
  Linux, these files change each time someone on another system runs `sync`.
- **Your own launch:** while the pinned engine is not on npm (or to work offline), set `mcp` in
  `.agentplugged/method.yaml`; it replaces the declaration in every tool, then run `sync`:

  ```yaml
  mcp:
    command: node
    args: ["/path/to/agentplugged/apps/cli/dist/bin.js", "mcp"]
  ```
- **Approval and trust:** Claude Code asks you to approve a project MCP server the first time
  (or run `claude mcp reset-project-choices` to be asked again); Cursor asks too (the Cursor CLI
  has `--approve-mcps`). Codex reads `.codex/config.toml` only in a project you marked as
  trusted, and Gemini CLI connects project servers only in a trusted folder (`gemini trust`).
- **Agent identity:** the agent id each call gives is declared, not proven. The journal records
  the machine that signed each event, not which agent sent it: any session can report as any
  active agent. The tool's main session, which is not an agent of the method, uses the reserved
  id `main`.

## Pinned engine version

`.agentplugged/method.yaml` pins the version of agentplugged the product was installed with
(`engine_version`). Every command checks it before writing anything:

- another version stops with `ENGINE_VERSION_MISMATCH` and tells you how to run the pinned one,
  for example `npx agentplugged@0.1.0 sync`;
- `npx agentplugged init --upgrade-engine` pins the version you run and refreshes the method;
  an engine older than the pinned one refuses to do so;
- `--engine-any` runs anyway, with a warning;
- a `format_version` newer than this engine knows stops with `UPGRADE_REQUIRED`.

## License

The engine (this package) is under the [Functional Source License, Version 1.1, MIT Future
License](LICENSE) (SPDX: `FSL-1.1-MIT`), copyright 2026 Innovel Studio SASU. You can use it, read
it and modify it, but not use it for a competing product or service. Each version becomes MIT two
years after its publication.

The method it ships (the agents, skills and templates in `dist/method/`) is under the MIT license
([LICENSE-METHOD](LICENSE-METHOD), also `dist/method/LICENSE`), so that it spreads freely.
