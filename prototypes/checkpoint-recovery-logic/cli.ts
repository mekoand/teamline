import {
  actionLabels,
  createInitialState,
  latestCompleteRecoveryPoint,
  reducePrototype,
  type PrototypeAction,
  type PrototypeState,
  type RecoveryPointKind,
} from "./model";

const bold = "\x1b[1m";
const dim = "\x1b[2m";
const cyan = "\x1b[36m";
const yellow = "\x1b[33m";
const reset = "\x1b[0m";

const keyActions: Record<string, PrototypeAction> = {
  s: { type: "start" },
  w: { type: "write" },
  b: { type: "begin_validation" },
  v: { type: "complete_stage" },
  p: { type: "pause_success" },
  i: { type: "pause_save_failure" },
  x: { type: "interrupt" },
  o: { type: "old_process_write" },
  f: { type: "fence_success" },
  z: { type: "fence_failure" },
  a: { type: "preserve_residue" },
  d: { type: "preserve_residue_failure" },
  r: { type: "safe_recover" },
  c: { type: "scene_continue" },
  u: { type: "resume_pause" },
};

const kindLabels: Record<RecoveryPointKind, string> = {
  start_baseline: "起始基线",
  stage_checkpoint: "阶段检查点",
  pause_savepoint: "暂停保存点",
};

function value(value: unknown): string {
  return `${cyan}${String(value)}${reset}`;
}

function render(state: PrototypeState): void {
  console.clear();
  const latest = latestCompleteRecoveryPoint(state);
  const lease = state.lease
    ? `${state.lease.id} / ${state.lease.status}`
    : "none";

  console.log(`${bold}Teamline 恢复逻辑原型${reset} ${dim}(内存状态，不接真实 Git/Codex)${reset}`);
  console.log(`${bold}问题${reset}  围栏 + 两类恢复位置能否避免双写并保留现场？\n`);

  console.log(`${bold}当前状态${reset}`);
  console.log(`  phase             ${value(state.phase)}`);
  console.log(`  stage             ${value(state.stage)}`);
  console.log(`  workingTree       ${value(state.workingTree)}`);
  console.log(`  lease             ${value(lease)}`);
  console.log(`  process           ${value(state.process)}`);
  console.log(`  processFenced     ${value(state.processFenced)}`);
  console.log(`  recoveryMode      ${value(state.recoveryMode)}`);
  console.log(
    `  validationTree    ${value(state.validationCandidate ? `${state.validationCandidate.tree} / stage ${state.validationCandidate.stage}` : "none")}`,
  );
  console.log(
    `  latestRecovery    ${value(`#${latest.sequence} ${kindLabels[latest.kind]} ${latest.tree}`)}`,
  );
  console.log(
    `  residue           ${value(state.residue ? `${state.residue.tree} after #${state.residue.afterRecoveryPoint}` : "none")}`,
  );
  console.log(`  residueSave       ${value(state.residuePersistence)}`);
  console.log(
    `  preservedResidue  ${value(state.preservedResidues.join(", ") || "none")}`,
  );
  console.log(`  notice            ${yellow}${state.notice}${reset}\n`);

  console.log(`${bold}恢复记录${reset}`);
  for (const point of state.recoveryPoints.slice(-4)) {
    const proof = point.provesStageCompletion ? "证明阶段完成" : "仅可恢复";
    console.log(
      `  #${point.sequence} ${kindLabels[point.kind]}  ${dim}${point.tree} · resume stage ${point.resumeStage} · ${proof}${reset}`,
    );
  }

  console.log(`\n${bold}最近事件${reset}`);
  for (const event of state.history.slice(-4)) {
    console.log(`  ${dim}${event}${reset}`);
  }

  console.log(`\n${bold}操作${reset}`);
  console.log(`  ${bold}s${reset} 启动   ${bold}w${reset} 写入   ${bold}b${reset} 固定验证树   ${bold}v${reset} 阶段通过   ${bold}p${reset} 暂停保存   ${bold}i${reset} 暂停保存失败`);
  console.log(`  ${bold}x${reset} 执行失联   ${bold}o${reset} 旧进程写入   ${bold}f${reset} 围栏成功   ${bold}z${reset} 围栏失败`);
  console.log(`  ${bold}a${reset} 保存现场   ${bold}d${reset} 保存失败   ${bold}r${reset} 安全恢复   ${bold}c${reset} 现场接续   ${bold}u${reset} 继续暂停   ${bold}0${reset} 新演示   ${bold}q${reset} 退出`);
  console.log(`\n${dim}0 只重启内存演示，不属于产品状态机；其余按键对应 ${Object.values(actionLabels).length} 个状态事件。${reset}`);
}

let state = createInitialState();
render(state);

if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
}
process.stdin.setEncoding("utf8");
process.stdin.resume();

process.stdin.on("data", (key: string) => {
  if (key === "q" || key === "\u0003") {
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }
    console.clear();
    process.exit(0);
  }

  if (key === "0") {
    state = createInitialState();
    render(state);
    return;
  }

  const action = keyActions[key];
  if (!action) {
    return;
  }

  state = reducePrototype(state, action);
  render(state);
});
