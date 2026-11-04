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

export type SolveRequest = {
  image: string;
  mode: Mode;
  language: Language;
  // Optional note to adjust the current answer for the same photo.
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
