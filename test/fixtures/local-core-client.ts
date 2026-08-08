const [baseUrl, command, argument] = Bun.argv.slice(2);
if (!baseUrl || !command) throw new Error("client command is required");

async function request(path: string, init?: RequestInit): Promise<any> {
  const response = await fetch(`${baseUrl}${path}`, init);
  const body = await response.json();
  if (!response.ok) throw new Error(`${response.status}: ${JSON.stringify(body)}`);
  return body;
}

if (command === "start") {
  if (!argument) throw new Error("workspace path is required");
  const { project } = await request("/api/projects", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "持久化项目" }),
  });
  const { workOrder } = await request("/api/work-orders", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "断开后继续运行",
      projectId: project.id,
      workspacePath: argument,
      description: "验证 Local Core 独立于客户端",
    }),
  });
  const plan = await request(`/api/work-orders/${encodeURIComponent(workOrder.id)}/plan`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      stages: [{
        outcome: "保持目标运行",
        scope: "Local Core",
        verification: "读取最新状态",
      }],
    }),
  });
  const started = await request(`/api/work-orders/${encodeURIComponent(plan.workOrder.id)}/start`, {
    method: "POST",
  });
  console.log(JSON.stringify({
    projectId: project.id,
    goalId: started.workOrder.id,
  }));
} else if (command === "read") {
  if (!argument) throw new Error("goal id is required");
  const [{ projects }, { workOrders }] = await Promise.all([
    request("/api/projects"),
    request("/api/console"),
  ]);
  const workOrder = workOrders.find((candidate: { id: string }) => candidate.id === argument);
  if (!workOrder) throw new Error("goal was not restored");
  console.log(JSON.stringify({
    projectIds: projects.map((project: { id: string }) => project.id),
    workOrder,
  }));
} else {
  throw new Error(`unknown command: ${command}`);
}

process.exit(0);
