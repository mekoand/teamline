export function codexProcessEnvironment(options: {
  codexHome?: string;
  apiKey?: string;
} = {}): Record<string, string | undefined> {
  const environment = { ...process.env };
  delete environment.CODEX_API_KEY;
  delete environment.OPENAI_API_KEY;
  delete environment.OPENAI_ADMIN_KEY;
  if (options.codexHome) environment.CODEX_HOME = options.codexHome;
  if (options.apiKey) environment.CODEX_API_KEY = options.apiKey;
  return environment;
}
