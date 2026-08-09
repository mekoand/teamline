export function buildProjectGoalGraph(goals) {
  return (goals ?? []).map((goal) => {
    const plan = goal.plan?.confirmationRequired === true ? null : goal.plan;
    const stageIds = new Set((plan?.stages ?? []).map((stage) => stage.id));
    const stages = (plan?.stages ?? []).map((stage, index) => ({
      id: stage.id,
      index,
      outcome: stage.outcome,
      status: stage.status,
      statusReason: stage.statusReason,
      dependsOn: (stage.dependsOn ?? []).filter((dependencyId) => stageIds.has(dependencyId)),
    }));

    return {
      id: goal.id,
      title: goal.title ?? goal.name,
      currentSummary: goal.currentSummary ?? "",
      updatedAt: goal.updatedAt ?? null,
      planVersion: plan?.version ?? null,
      planConfirmed: Boolean(plan),
      stages,
      edges: stages.flatMap((stage) =>
        stage.dependsOn.map((from) => ({ from, to: stage.id })),
      ),
    };
  });
}

export function bindProjectCreationEntry(root, onCreate) {
  root.querySelector("#create-goal-in-project")?.addEventListener("click", onCreate);
}

export function bindProjectGoalGraphEvents(root, onSelect) {
  root.querySelectorAll("[data-project-goal-id]").forEach((button) => {
    button.addEventListener("click", () => {
      const selection = projectGoalSelection(button.dataset);
      if (selection) onSelect(selection.goalId, selection.stageId);
    });
  });
}

export function projectGoalSelection(dataset) {
  if (!dataset?.projectGoalId) return null;
  return {
    goalId: dataset.projectGoalId,
    stageId: dataset.projectGoalStageId || null,
  };
}

export function resolveCreationProjectId(currentProjectId, projects) {
  return currentProjectId && currentProjectId !== "unclassified" &&
    (projects ?? []).some((project) => project.id === currentProjectId)
    ? currentProjectId
    : "";
}

export function openGoalCreationDialog({
  dialog,
  projectSelect,
  currentProjectId,
  projects,
  populateProjectSelect,
  resetProjectMaterials,
  renderProjectMaterials,
  refreshProjectMaterials,
  focusTarget,
}) {
  const defaultProjectId = resolveCreationProjectId(currentProjectId, projects);
  populateProjectSelect(projectSelect, defaultProjectId);
  resetProjectMaterials();
  renderProjectMaterials();
  dialog.showModal();
  focusTarget?.focus();
  void refreshProjectMaterials?.();
}
