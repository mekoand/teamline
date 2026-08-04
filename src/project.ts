export type Project = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
};

export const projectMaterialKinds = [
  "text",
  "repository",
  "folder",
  "file",
  "image",
  "link",
  "goal",
] as const;

export type ProjectMaterialKind = (typeof projectMaterialKinds)[number];

export type ProjectMaterial = {
  id: string;
  projectId: string;
  kind: ProjectMaterialKind;
  label: string;
  value: string;
  sourceGoalId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CreateProjectMaterialInput = {
  kind: ProjectMaterialKind;
  label: string;
  value: string;
};

export function createProject(name: string): Project {
  const normalizedName = name.trim();
  if (!normalizedName) throw new Error("请填写项目名称");
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    name: normalizedName,
    createdAt: now,
    updatedAt: now,
  };
}

export function createProjectMaterial(
  projectId: string,
  input: CreateProjectMaterialInput,
): ProjectMaterial {
  const label = input.label.trim();
  const value = input.value.trim();
  if (!label) throw new Error("请填写素材名称");
  if (!value) throw new Error("请填写素材内容或位置");
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    projectId,
    kind: input.kind,
    label,
    value,
    sourceGoalId: input.kind === "goal" ? value : null,
    createdAt: now,
    updatedAt: now,
  };
}
