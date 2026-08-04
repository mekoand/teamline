import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app";
import { buildResumePrompt } from "../src/codex-runner";
import { LocalStateTransfer } from "../src/local-state-transfer";
import { WorkOrderStore } from "../src/work-order-store";

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "teamline-project-page-"));
  const database = new Database(join(directory, "teamline.db"), { create: true });
  const store = new WorkOrderStore(database);
  const app = createApp({ store, dataDirectory: directory });
  return {
    directory,
    store,
    app,
    close() {
      database.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

describe("project page and project materials", () => {
  test("stores project materials and returns a lightweight project summary", async () => {
    const context = fixture();
    try {
      const project = context.store.createProject("Personal Beta");
      const goal = context.store.create({
        name: "整理发布说明",
        description: "整理 Personal Beta 的发布说明",
        projectId: project.id,
      });
      context.store.create({
        name: "已经完成的目标",
        description: "保留完成成果",
        projectId: project.id,
      });

      const createResponse = await context.app.fetch(
        new Request(`http://teamline.local/api/projects/${project.id}/materials`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            kind: "text",
            label: "发布口径",
            value: "保持简洁，不增加新概念。",
          }),
        }),
      );
      const detailResponse = await context.app.fetch(
        new Request(`http://teamline.local/api/projects/${project.id}`),
      );

      expect(createResponse.status).toBe(201);
      expect((await createResponse.json()).material).toMatchObject({
        projectId: project.id,
        kind: "text",
        label: "发布口径",
        value: "保持简洁，不增加新概念。",
      });
      expect(detailResponse.status).toBe(200);
      const detail = await detailResponse.json();
      expect(detail.project).toMatchObject({ id: project.id, name: project.name });
      expect(detail.summary).toEqual({ totalGoals: 2, completedGoals: 0 });
      expect(detail.goals.some((candidate: { id: string }) => candidate.id === goal.id)).toBe(true);
      expect(detail.materials[0]).toMatchObject({ label: "发布口径" });
      expect(detail.results).toEqual([]);
    } finally {
      context.close();
    }
  });

  test("copies an uploaded file into Teamline local project storage", async () => {
    const context = fixture();
    try {
      const project = context.store.createProject("产品资料");
      const form = new FormData();
      form.set("file", new File(["project brief"], "产品简报.md", { type: "text/markdown" }));
      const response = await context.app.fetch(
        new Request(`http://teamline.local/api/projects/${project.id}/uploads`, {
          method: "POST",
          body: form,
        }),
      );
      const { material } = await response.json();

      expect(response.status).toBe(201);
      expect(material).toMatchObject({
        projectId: project.id,
        kind: "file",
        label: "产品简报.md",
      });
      expect(material.value).toContain("project-files");
      expect(readFileSync(material.value, "utf8")).toBe("project brief");
    } finally {
      context.close();
    }
  });

  test("recommends a small explainable subset and saves only selected project materials", async () => {
    const context = fixture();
    try {
      const project = context.store.createProject("Teamline V2");
      const release = context.store.createProjectMaterial(project.id, {
        kind: "text",
        label: "移动端发布说明",
        value: "检查 390px 布局",
      });
      context.store.createProjectMaterial(project.id, {
        kind: "link",
        label: "品牌参考",
        value: "https://example.com/brand",
      });
      context.store.createProjectMaterial(project.id, {
        kind: "file",
        label: "旧版记录",
        value: "/tmp/old-notes.md",
      });
      context.store.createProjectMaterial(project.id, {
        kind: "folder",
        label: "服务端代码",
        value: "/tmp/server",
      });

      const recommendationResponse = await context.app.fetch(
        new Request(
          `http://teamline.local/api/projects/${project.id}/material-recommendations?name=${encodeURIComponent("移动端适配")}&description=${encodeURIComponent("完成 390px 页面")}`,
        ),
      );
      const recommendation = await recommendationResponse.json();
      expect(recommendation.recommendedIds).toEqual([release.id]);
      expect(recommendation.recommendedIds.length).toBeLessThan(
        recommendation.materials.length,
      );
      expect(
        context.store.recommendProjectMaterials(
          project.id,
          "财务报表",
          "核对本季度收入和费用",
        ).recommendedIds,
      ).toEqual([]);

      const createResponse = await context.app.fetch(
        new Request("http://teamline.local/api/work-orders", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: "完成移动端适配",
            description: "让项目页在 390px 可用",
            projectId: project.id,
            projectMaterialIds: [release.id],
          }),
        }),
      );
      const { workOrder } = await createResponse.json();
      expect(workOrder.materials).toEqual([
        expect.objectContaining({
          kind: "text",
          value: "检查 390px 布局",
          projectMaterialId: release.id,
        }),
      ]);
      expect(workOrder.projectMaterialSelectionConfirmed).toBe(true);

      const updateResponse = await context.app.fetch(
        new Request(`http://teamline.local/api/work-orders/${workOrder.id}/project-context`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ projectId: project.id, projectMaterialIds: [] }),
        }),
      );
      expect((await updateResponse.json()).workOrder.materials).toEqual([]);
    } finally {
      context.close();
    }
  });

  test("distinguishes an untouched existing goal from an intentionally empty selection", () => {
    const context = fixture();
    try {
      const project = context.store.createProject("已有项目");
      const workOrder = context.store.create({
        name: "继续已有目标",
        description: "首次打开时使用推荐素材",
        projectId: project.id,
      });
      expect(workOrder.projectMaterialSelectionConfirmed).toBe(false);

      const saved = context.store.saveProjectContext(workOrder.id, project.id, []);
      expect(saved.projectMaterialSelectionConfirmed).toBe(true);
      expect(saved.materials).toEqual([]);
    } finally {
      context.close();
    }
  });

  test("keeps selected project material provenance through clarification and removes it when moving projects", () => {
    const context = fixture();
    try {
      const projectA = context.store.createProject("项目 A");
      const projectB = context.store.createProject("项目 B");
      const material = context.store.createProjectMaterial(projectA.id, {
        kind: "text",
        label: "A 项目说明",
        value: "只属于 A 项目",
      });
      const workOrder = context.store.create({
        name: "整理项目说明",
        description: "整理项目说明",
        projectId: projectA.id,
        projectMaterialSelectionConfirmed: true,
        materials: [{
          kind: "text",
          value: material.value,
          projectMaterialId: material.id,
        }],
      });
      context.store.saveClarification(workOrder.id, [{
        id: "materials",
        prompt: "需要哪些素材？",
        reason: "确认素材范围",
        target: "materials",
      }]);

      const clarified = context.store.applyGeneratedPlan(
        workOrder.id,
        {
          stages: [{
            id: "summary",
            outcome: "项目说明已整理",
            scope: "说明文档",
            verification: "人工检查",
          }],
          materials: [{ kind: "text", value: material.value }],
        },
        false,
        "使用项目说明",
      );

      expect(clarified.materials).toEqual([
        expect.objectContaining({
          value: material.value,
          projectMaterialId: material.id,
        }),
      ]);
      expect(context.store.saveProjectContext(workOrder.id, projectB.id, []).materials).toEqual([]);
    } finally {
      context.close();
    }
  });

  test("includes the current selected materials when resuming Codex", () => {
    const context = fixture();
    try {
      const workOrder = context.store.create({
        name: "继续执行",
        description: "继续执行当前节点",
        materials: [{ kind: "text", value: "最新项目素材" }],
      });
      const ready = context.store.savePlan(workOrder.id, [{
        id: "continue",
        outcome: "继续完成",
        scope: "当前范围",
        verification: "人工检查",
      }]);
      expect(buildResumePrompt(ready)).toContain("- text: 最新项目素材");
    } finally {
      context.close();
    }
  });

  test("references another goal as a summary snapshot without copying its logs", async () => {
    const context = fixture();
    try {
      const project = context.store.createProject("发布项目");
      const sourceProject = context.store.createProject("原型项目");
      const source = context.store.create({
        name: "完成界面原型",
        description: "完成界面原型",
        projectId: sourceProject.id,
        projectMaterialSelectionConfirmed: true,
      });
      const reference = context.store.createProjectMaterial(project.id, {
        kind: "goal",
        label: "界面原型成果",
        value: source.id,
      });

      const response = await context.app.fetch(
        new Request("http://teamline.local/api/work-orders", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: "编写发布稿",
            description: "引用原型成果",
            projectId: project.id,
            projectMaterialIds: [reference.id],
          }),
        }),
      );
      const { workOrder } = await response.json();
      expect(workOrder.materials[0]).toMatchObject({
        kind: "text",
        projectMaterialId: reference.id,
      });
      expect(workOrder.materials[0].value).toContain("完成界面原型");
      expect(workOrder.materials[0].value).not.toContain("运行记录");
      expect(workOrder.materials[0].value).not.toContain("对话");
      expect(() =>
        new LocalStateTransfer(new WorkOrderStore(new Database(":memory:"))).preview(
          new LocalStateTransfer(context.store).export(),
        ),
      ).not.toThrow();
    } finally {
      context.close();
    }
  });

  test("serves project detail routes and project controls", async () => {
    const context = fixture();
    try {
      const [pageResponse, scriptResponse] = await Promise.all([
        context.app.fetch(new Request("http://teamline.local/projects/project-1")),
        context.app.fetch(new Request("http://teamline.local/app.js")),
      ]);
      const script = await scriptResponse.text();
      expect(pageResponse.status).toBe(200);
      expect(script).toContain("/material-recommendations");
      expect(script).toContain("project-context");
      expect(script).toContain("project-material-form");
      expect(script).toContain("project-upload-form");
    } finally {
      context.close();
    }
  });

  test("round-trips project materials in bundle v3 while keeping v2 compatible", () => {
    const source = fixture();
    const target = fixture();
    try {
      const project = source.store.createProject("迁移项目");
      const material = source.store.createProjectMaterial(project.id, {
        kind: "text",
        label: "项目说明",
        value: "只恢复摘要和引用。",
      });
      source.store.create({
        name: "迁移目标",
        description: "验证项目素材迁移",
        projectId: project.id,
        projectMaterialSelectionConfirmed: true,
        materials: [
          {
            kind: "text",
            value: material.value,
            projectMaterialId: material.id,
          },
        ],
      });

      const bundle = new LocalStateTransfer(source.store).export();
      expect(bundle.version).toBe(3);
      expect(bundle.projectMaterials).toEqual([material]);

      const transfer = new LocalStateTransfer(target.store);
      const preview = transfer.preview(bundle);
      expect(preview.workOrders[0]?.attention).toEqual([]);
      transfer.confirm({ previewId: preview.previewId });
      expect(target.store.listProjectMaterials(project.id)).toEqual([material]);
      expect(target.store.list()[0].materials[0]).toMatchObject({
        kind: "text",
        projectMaterialId: material.id,
      });
      expect(target.store.list()[0].projectMaterialSelectionConfirmed).toBe(true);

      const dangling = structuredClone(bundle);
      dangling.workOrders[0]!.materials[0]!.projectMaterialId = "missing-material";
      expect(() =>
        new LocalStateTransfer(new WorkOrderStore(new Database(":memory:"))).preview(dangling),
      ).toThrow(
        "不存在的项目素材",
      );

      const invalidGoalReference = structuredClone(bundle);
      invalidGoalReference.projectMaterials.push({
        ...material,
        id: "invalid-goal-reference",
        kind: "goal",
        value: "missing-goal",
        sourceGoalId: "different-goal",
      });
      expect(() =>
        new LocalStateTransfer(new WorkOrderStore(new Database(":memory:"))).preview(
          invalidGoalReference,
        ),
      ).toThrow(
        "无效的来源目标",
      );

      const invalidSource = structuredClone(bundle);
      invalidSource.projectMaterials[0]!.sourceGoalId = invalidSource.workOrders[0]!.id;
      expect(() =>
        new LocalStateTransfer(new WorkOrderStore(new Database(":memory:"))).preview(
          invalidSource,
        ),
      ).toThrow("非目标素材");

      const legacyV2 = {
        ...bundle,
        version: 2,
        workOrders: bundle.workOrders.map(({
          projectMaterialSelectionConfirmed: _projectMaterialSelectionConfirmed,
          importContext: _importContext,
          ...workOrder
        }) => ({
          ...workOrder,
          materials: workOrder.materials.map(({ projectMaterialId: _projectMaterialId, ...item }) => item),
        })),
        projectMaterials: undefined,
      };
      delete (legacyV2 as { projectMaterials?: unknown }).projectMaterials;
      const legacyTarget = fixture();
      try {
        const legacyPreview = new LocalStateTransfer(legacyTarget.store).preview(legacyV2);
        expect(legacyPreview.summary.total).toBe(1);
      } finally {
        legacyTarget.close();
      }
    } finally {
      source.close();
      target.close();
    }
  });

  test("round-trips a project material inherited from another goal", () => {
    const source = fixture();
    try {
      const project = source.store.createProject("共享已有素材");
      const owner = source.store.create({
        name: "整理需求",
        description: "整理需求",
        projectId: project.id,
        materials: [{ kind: "text", value: "现有需求摘要" }],
      });
      const inheritedId = `goal-material:${owner.id}:${owner.materials[0]!.id}`;
      source.store.create({
        name: "继续设计",
        description: "使用已有需求",
        projectId: project.id,
        projectMaterialSelectionConfirmed: true,
        materials: [{
          kind: "text",
          value: "现有需求摘要",
          projectMaterialId: inheritedId,
        }],
      });

      expect(() =>
        new LocalStateTransfer(new WorkOrderStore(new Database(":memory:"))).preview(
          new LocalStateTransfer(source.store).export(),
        ),
      ).not.toThrow();
    } finally {
      source.close();
    }
  });

  test("remaps goal material references when a conflicting source goal is restored as a copy", () => {
    const source = fixture();
    const target = fixture();
    try {
      const project = source.store.createProject("目标引用迁移");
      const sourceGoal = source.store.create({
        name: "Bundle 来源目标",
        description: "需要恢复为副本",
        projectId: project.id,
        materials: [{ kind: "text", value: "来源目标中的共享素材" }],
      });
      const goalMaterial = source.store.createProjectMaterial(project.id, {
        kind: "goal",
        label: "来源目标摘要",
        value: sourceGoal.id,
      });
      const inheritedMaterialId = `goal-material:${sourceGoal.id}:${sourceGoal.materials[0]!.id}`;
      const consumer = source.store.create({
        name: "引用派生素材",
        description: "验证派生素材引用一起迁移",
        projectId: project.id,
        projectMaterialSelectionConfirmed: true,
        materials: [{
          kind: "text",
          value: "来源目标中的共享素材",
          projectMaterialId: inheritedMaterialId,
        }],
      });
      const explicitConsumer = source.store.create({
        name: "引用目标摘要",
        description: "验证显式目标素材引用一起迁移",
        projectId: project.id,
        projectMaterialSelectionConfirmed: true,
        materials: source.store.resolveProjectMaterials(project.id, [goalMaterial.id]),
      });
      const bundle = new LocalStateTransfer(source.store).export();
      const exportedProject = bundle.projects.find((candidate) => candidate.id === project.id)!;

      const localConflict = target.store.create({
        name: "本机同 ID 目标",
        description: "不能被项目素材误引用",
      });
      target.store.database
        .query("UPDATE work_orders SET id = ? WHERE id = ?")
        .run(sourceGoal.id, localConflict.id);
      target.store.database
        .query("INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)")
        .run(
          exportedProject.id,
          exportedProject.name,
          exportedProject.createdAt,
          exportedProject.updatedAt,
        );
      target.store.database
        .query(`
          INSERT INTO project_materials (
            id, project_id, material_kind, label, value, source_goal_id,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          goalMaterial.id,
          goalMaterial.projectId,
          goalMaterial.kind,
          goalMaterial.label,
          goalMaterial.value,
          goalMaterial.sourceGoalId,
          goalMaterial.createdAt,
          goalMaterial.updatedAt,
        );

      const transfer = new LocalStateTransfer(target.store);
      const preview = transfer.preview(bundle);
      transfer.confirm({
        previewId: preview.previewId,
        resolutions: { [sourceGoal.id]: "import_copy" },
      });

      const restoredCopy = target.store.list().find((workOrder) =>
        workOrder.name.includes("恢复副本"),
      );
      const restoredReference = target.store
        .listProjectMaterials(project.id)
        .find((material) => material.sourceGoalId === restoredCopy?.id);
      const restoredConsumer = target.store.get(consumer.id);
      const restoredExplicitConsumer = target.store.get(explicitConsumer.id);
      expect(restoredCopy?.id).toBeTruthy();
      expect(restoredCopy?.id).not.toBe(sourceGoal.id);
      expect(restoredReference).toMatchObject({
        kind: "goal",
        value: restoredCopy!.id,
        sourceGoalId: restoredCopy!.id,
      });
      expect(restoredReference?.id).not.toBe(goalMaterial.id);
      expect(restoredConsumer?.materials[0]?.projectMaterialId).toBe(
        `goal-material:${restoredCopy!.id}:${sourceGoal.materials[0]!.id}`,
      );
      expect(restoredExplicitConsumer?.materials[0]?.projectMaterialId).toBe(
        restoredReference?.id,
      );
    } finally {
      source.close();
      target.close();
    }
  });
});
