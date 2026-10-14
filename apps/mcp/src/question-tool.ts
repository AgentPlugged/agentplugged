import type {
  QuestionReader,
  QuestionScreen,
  QuestionToolAccess,
  ToolQuestion,
} from "@agentplugged/core";
import { createTranslator, type Translate } from "@agentplugged/i18n";
import {
  type DecisionChoice,
  type DecisionPrompt,
  QUESTION_TOOL_MAX_QUESTIONS,
  type StackPrompt,
  type StackPromptItem,
} from "@agentplugged/protocol";
import { actionText, type ChoiceKeys, choiceTitle, line, lines, recorded } from "./elicitation.js";

/**
 * The engine's decisions as the questions of the AI tool's question tool: the engine
 * dictates their exact text, the agent asks them with `AskUserQuestion`, and the creator answers by
 * clicking in the conversation window. This file only renders the decision object the engine built
 * (`DecisionPrompt`, `StackPrompt`) into questions and says how to read their answers; what counts as
 * an answer is decided by the engine (`readToolAnswer`, `readStackScreen`), from the record the
 * tool's hook wrote.
 */

/** The longest summary shown in a question: the question tool is no place for a whole document. */
const SUMMARY_MAX = 900;

/** The longest title shown in the question of a stack's point. */
const POINT_TITLE_MAX = 200;

/** The creator's words cut to `max` characters, without cutting a character in two. */
function cut(text: string, max: number): string {
  const characters = [...text];
  return characters.length <= max ? text : `${characters.slice(0, max - 1).join("")}…`;
}

const TOOL_KEYS: ChoiceKeys = {
  recommended: "question_tool.recommended",
  approve: "question_tool.choice.approve",
  reject: "question_tool.choice.reject",
  changes: "question_tool.choice.changes",
  changesNone: "question_tool.choice.changes_none",
};

const choiceLabel = (t: Translate, prompt: DecisionPrompt, choice: DecisionChoice) =>
  choiceTitle(t, prompt, choice, TOOL_KEYS);

/** What the engine says of one choice under its title: the consequence of an option, else its effect. */
function choiceDescription(t: Translate, prompt: DecisionPrompt, choice: DecisionChoice): string {
  if (choice.decision === "option_chosen") {
    const option = prompt.options.find((entry) => entry.id === choice.option);
    return cut(line(option?.consequence ?? ""), 300) || line(option?.label ?? choice.id);
  }
  if (choice.decision === "approved") {
    return t("question_tool.choice.approve.description", { title: cut(line(prompt.title), 120) });
  }
  if (choice.decision === "rejected") return t("question_tool.choice.reject.description");
  return t(
    prompt.options.length > 0
      ? "question_tool.choice.changes_none.description"
      : "question_tool.choice.changes.description",
  );
}

/**
 * The questions of a decision. The first one is the decision: its text says who asks (AgentPlugged,
 * the checkpoint and the agent that opened it), the engine's facts (risk, irreversibility, the
 * creator's action, documents) apart from the checkpoint's own words, quoted line by line so they can
 * never pass for the engine's; its options are the choices, the recommendation first and marked
 * « (Recommandé) » as the tool does, each with its consequence. One question, one click, whatever
 * the risk: an irreversible action with an effect outside the product is named, with
 * its effect, in that question itself; there is no second question. Undefined when the decision has more choices than the tool shows (four options at most).
 */
export function renderQuestions(prompt: DecisionPrompt, t: Translate): QuestionScreen | undefined {
  const agent = prompt.opened_by === null ? "-" : line(prompt.opened_by);
  const text = [
    t("question_tool.intro"),
    t("question_tool.checkpoint", {
      checkpoint: prompt.checkpoint,
      agent,
      risk: t(`elicitation.risk.${prompt.risk}`),
    }),
  ];
  if (prompt.irreversible) {
    text.push(
      t("question_tool.irreversible", {
        action: cut(line(prompt.external_action?.action ?? prompt.title), 200),
      }),
    );
  }
  if (prompt.creator_action !== null) {
    text.push(t("question_tool.action", { action: actionText(prompt.creator_action) }));
  }
  for (const document of prompt.documents) {
    text.push(
      t("question_tool.document", { path: line(document.path), branch: line(document.branch) }),
    );
  }
  text.push(t("question_tool.written_by", { agent }));
  const words = [line(prompt.title), ...lines(prompt.summary)].join("\n");
  for (const entry of cut(words, SUMMARY_MAX).split("\n")) text.push(`> ${entry}`);
  // A deliverable: angle, audience and short version in the agent's words, quoted, then
  // the command for the full text, which is what the creator validates.
  const publication = prompt.publication ?? null;
  if (publication !== null) {
    text.push(
      t("elicitation.message.publication.angle", { angle: publication.angle }),
      t("elicitation.message.publication.audience", { audience: publication.audience }),
      t("elicitation.message.publication.short", { agent }),
    );
    for (const entry of recorded(publication.short_version)) text.push(`> ${entry}`);
    text.push(t("elicitation.message.publication.full", { agent }));
  }
  // The recommendation first, as the tool does; the others in the order the agent gave them.
  const ordered = [
    ...prompt.choices.filter((choice) => choice.recommended),
    ...prompt.choices.filter((choice) => !choice.recommended),
  ];
  const first: ToolQuestion = {
    question: text.join("\n"),
    header: prompt.checkpoint,
    multiSelect: false,
    options: ordered.map((choice) => ({
      label: choiceLabel(t, prompt, choice),
      description: choiceDescription(t, prompt, choice),
    })),
  };
  const choices: QuestionReader = {
    kind: "choice",
    choices: ordered.map((choice, index) => ({
      label: (first.options[index] as { label: string }).label,
      choice: choice.id,
    })),
  };
  return { questions: [first], readers: [choices] };
}

/** The question of one point of a stack. */
function pointQuestion(item: StackPromptItem, stack: string, t: Translate): ToolQuestion {
  const agent = item.opened_by === null ? "-" : line(item.opened_by);
  const text = [
    t("question_tool.stack.question", {
      stack,
      n: item.n,
      checkpoint: item.checkpoint,
      risk: t(`elicitation.risk.${item.risk}`),
      agent,
    }),
  ];
  if (item.recommendation !== null) {
    text.push(
      t("elicitation.stack.recommendation", {
        label: line(item.recommendation.label),
        consequence: line(item.recommendation.consequence),
      }),
    );
  }
  for (const document of item.documents) {
    text.push(
      t("question_tool.document", { path: line(document.path), branch: line(document.branch) }),
    );
  }
  text.push(t("question_tool.written_by", { agent }));
  const words = [cut(line(item.title), POINT_TITLE_MAX), ...lines(item.summary)].join("\n");
  for (const entry of cut(words, SUMMARY_MAX / 2).split("\n")) text.push(`> ${entry}`);
  return {
    question: text.join("\n"),
    header: t("question_tool.stack.header", { n: item.n }),
    multiSelect: false,
    options: [
      {
        label: t("question_tool.stack.yes"),
        description: t("question_tool.stack.yes.description"),
      },
      {
        label: t("question_tool.stack.no"),
        description: t("question_tool.stack.no.description"),
      },
    ],
  };
}

/**
 * The screens of a stack: one question a point (approve, or not now), four points at most a screen,
 * so a stack of more than four points is split in several screens, asked one after the other.
 */
export function renderStackScreens(prompt: StackPrompt, t: Translate): QuestionScreen[] {
  const screens: QuestionScreen[] = [];
  for (let start = 0; start < prompt.items.length; start += QUESTION_TOOL_MAX_QUESTIONS) {
    const items = prompt.items.slice(start, start + QUESTION_TOOL_MAX_QUESTIONS);
    const yes = t("question_tool.stack.yes");
    screens.push({
      questions: items.map((item) => pointQuestion(item, prompt.stack, t)),
      readers: items.map((item): QuestionReader => ({ kind: "point", n: item.n, yes })),
    });
  }
  return screens;
}

/**
 * What the engine gets to render its decisions in the question tool: the questions in the creator's
 * language, with the engine's command on this machine in place of `npx agentplugged`.
 * `available`: the AI tool has the question tool here (Claude Code with a person at it).
 */
export function questionToolOf(options: {
  readonly available: boolean;
  readonly text?: Translate;
  readonly localize?: (text: string) => string;
}): QuestionToolAccess {
  const t = options.text ?? createTranslator("en");
  const localize = options.localize;
  const local = (screen: QuestionScreen): QuestionScreen =>
    localize === undefined
      ? screen
      : {
          readers: screen.readers,
          questions: screen.questions.map((question) => ({
            ...question,
            question: localize(question.question),
          })),
        };
  return {
    available: options.available,
    render: (prompt) => {
      const screen = renderQuestions(prompt, t);
      return screen === undefined ? undefined : local(screen);
    },
    renderStack: (prompt) => renderStackScreens(prompt, t).map(local),
  };
}
