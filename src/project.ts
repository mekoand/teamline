export type Project = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
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
