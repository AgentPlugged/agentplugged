import { promoteLessonCommand, proposePromotionCommand } from "./promotion.js";
import { proposeRetrospectiveCommand } from "./propose-retrospective.js";
import { readMemoryCommand } from "./read-memory.js";
import { recordLessonsCommand } from "./record-lessons.js";

/** The retrospective and memory tools exposed to agents, in the order they are used. */
export const memoryCommands = [
  readMemoryCommand,
  proposeRetrospectiveCommand,
  recordLessonsCommand,
  proposePromotionCommand,
  promoteLessonCommand,
] as const;
