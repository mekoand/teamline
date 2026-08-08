import type { WorkOrder } from "./work-order";

export type WorkingLanguage = "English" | "Simplified Chinese";

const hanPattern = /\p{Script=Han}/gu;
const latinPattern = /[A-Za-z]/g;

export function inferWorkingLanguage(
  input: Pick<WorkOrder, "goal" | "acceptance" | "conversation">,
): WorkingLanguage {
  const userText = [
    input.goal,
    input.acceptance ?? "",
    ...input.conversation
      .filter((message) => message.role === "user")
      .map((message) => message.content),
  ].join("\n");
  const han = userText.match(hanPattern)?.length ?? 0;
  const latin = userText.match(latinPattern)?.length ?? 0;
  return han > 0 && han * 2 >= latin ? "Simplified Chinese" : "English";
}

export function workingLanguageInstruction(
  input: Pick<WorkOrder, "goal" | "acceptance" | "conversation">,
): string {
  const language = inferWorkingLanguage(input);
  return `Write every new user-visible question, decision, plan field, summary, and result in ${language}. This working language is derived from the goal and user conversation, never from Teamline's interface language. Preserve quoted text, file names, commands, URLs, and imported history in their original language; do not translate or rewrite source history.`;
}
