import type { WorkOrder } from "./work-order";

export type WorkingLanguage = "English" | "Simplified Chinese";

const hanPattern = /\p{Script=Han}/gu;
const hanCharacterPattern = /\p{Script=Han}/u;
const latinWordPattern = /[A-Za-z]+/g;

function proseForLanguageDetection(value: string): string {
  return value
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`\n]+`/g, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/(?:^|\s)(?:\.{0,2}\/|~\/|\/)[^\s]+/g, " ");
}

export function inferWorkingLanguage(
  input: Pick<WorkOrder, "goal" | "acceptance" | "conversation">,
): WorkingLanguage {
  const userText = proseForLanguageDetection([
    input.goal,
    input.acceptance ?? "",
    ...input.conversation
      .filter((message) => message.role === "user")
      .map((message) => message.content),
  ].join("\n"));
  const han = userText.match(hanPattern)?.length ?? 0;
  const latinWords = userText.match(latinWordPattern)?.length ?? 0;
  const firstScript = userText.match(/[\p{Script=Han}A-Za-z]/u)?.[0] ?? "";
  const chineseLeadBonus = hanCharacterPattern.test(firstScript) ? 2 : 0;
  return han > 0 && han + chineseLeadBonus > latinWords
    ? "Simplified Chinese"
    : "English";
}

export function workingLanguageInstruction(
  input: Pick<WorkOrder, "goal" | "acceptance" | "conversation">,
): string {
  const language = inferWorkingLanguage(input);
  return `Write every new user-visible question, decision, plan field, summary, and result in ${language}. This working language is derived from the goal and user conversation, never from Teamline's interface language. Preserve quoted text, file names, commands, URLs, and imported history in their original language; do not translate or rewrite source history.`;
}
