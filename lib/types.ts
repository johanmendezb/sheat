export type Mode = "programming" | "general";

export const LANGUAGES = [
  "JavaScript",
  "TypeScript",
  "React",
  "Python",
  "Java",
  "C++",
  "C#",
] as const;

export type Language = (typeof LANGUAGES)[number];

// Max photos per exercise: a tall exercise can be captured in several parts.
export const MAX_IMAGES = 6;

// Max characters of a question asked by voice (or typed in the dictation panel).
export const MAX_QUESTION_CHARACTERS = 2000;

// At least one of images or question is required.
export type SolveRequest = {
  // 1 to MAX_IMAGES data URLs, in order from top to bottom of the same exercise.
  images?: string[];
  // The exercise as text, usually dictated by voice.
  question?: string;
  mode: Mode;
  language: Language;
  // Optional note to adjust the current answer for the same photos or question.
  refinement?: string;
  // The current answer serialized with JSON.stringify, sent with a refinement.
  previousAnswer?: string;
  // Programming only: ask for a systematic edge-case review at a higher effort.
  deepReview?: boolean;
};

export type ProgrammingAnswer = {
  type: "programming";
  exercise: string;
  language: string;
  code: string;
  explanation: string;
  expectedOutput: string | null;
  needsNewPhoto: boolean;
  message?: string;
  // Only present when deepReview was requested.
  edgeCases?: string[];
};

export type GeneralAnswer = {
  type: "general";
  answer: string;
  explanation: string | null;
  needsNewPhoto: boolean;
  message?: string;
};

export type SolveResponse = ProgrammingAnswer | GeneralAnswer;

export type ErrorResponse = {
  error: string;
};
