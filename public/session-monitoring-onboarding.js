export function buildOnboardingToolBySessionKey(tools = []) {
  return new Map(
    tools.flatMap((tool) => (tool.sessionKeys ?? []).map((key) => [key, tool.key])),
  );
}

export function visibleOnboardingSessionKeys(candidate, toolBySessionKey, activeToolKeys) {
  const active = activeToolKeys instanceof Set ? activeToolKeys : new Set(activeToolKeys ?? []);
  return (candidate?.sessionKeys ?? []).filter((key) => active.has(toolBySessionKey.get(key)));
}

export function visibleOnboardingCandidates(candidates = [], toolBySessionKey, activeToolKeys) {
  return candidates.filter((candidate) =>
    visibleOnboardingSessionKeys(candidate, toolBySessionKey, activeToolKeys).length > 0,
  );
}

export function buildOnboardingSelectionPayload(
  candidates = [],
  tools = [],
  projectSelections = [],
  activeToolKeys = [],
) {
  const toolBySessionKey = buildOnboardingToolBySessionKey(tools);
  const active = activeToolKeys instanceof Set ? activeToolKeys : new Set(activeToolKeys);
  const selectedSessionKeys = new Set();
  const projects = projectSelections.map((selection) => {
    const candidate = candidates.find((entry) => entry.key === selection.candidateKey);
    const sessionKeys = candidate
      ? visibleOnboardingSessionKeys(candidate, toolBySessionKey, active)
      : [];
    if (selection.selected !== false) {
      sessionKeys.forEach((key) => selectedSessionKeys.add(key));
    }
    return {
      ...selection,
      toolKeys: [...active],
    };
  });
  return {
    projects,
    selectedSessionKeys: [...selectedSessionKeys],
  };
}
