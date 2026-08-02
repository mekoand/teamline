export type Phase = "ready" | "running" | "paused" | "interrupted";

export type ProcessState = "absent" | "running" | "unknown" | "stopped";

export type RecoveryPointKind =
  | "start_baseline"
  | "stage_checkpoint"
  | "pause_savepoint";

export type RecoveryMode = "none" | "safe" | "scene_continue";

export type ResiduePersistence =
  | "not_needed"
  | "pending"
  | "saved"
  | "failed";

export interface RecoveryPoint {
  sequence: number;
  kind: RecoveryPointKind;
  tree: string;
  stage: number;
  resumeStage: number;
  complete: boolean;
  provesStageCompletion: boolean;
}

export interface Lease {
  id: string;
  status: "active" | "expired";
}

export interface Residue {
  tree: string;
  afterRecoveryPoint: number;
}

export interface ValidationCandidate {
  tree: string;
  stage: number;
}

export interface PrototypeState {
  phase: Phase;
  stage: number;
  workingRevision: number;
  workingTree: string;
  lease: Lease | null;
  process: ProcessState;
  processFenced: boolean;
  recoveryMode: RecoveryMode;
  validationCandidate: ValidationCandidate | null;
  recoveryPoints: RecoveryPoint[];
  residue: Residue | null;
  residuePersistence: ResiduePersistence;
  preservedResidues: string[];
  leaseCounter: number;
  recoverySequence: number;
  notice: string;
  history: string[];
}

export type PrototypeAction =
  | { type: "start" }
  | { type: "write" }
  | { type: "begin_validation" }
  | { type: "complete_stage" }
  | { type: "pause_success" }
  | { type: "pause_save_failure" }
  | { type: "interrupt" }
  | { type: "old_process_write" }
  | { type: "fence_success" }
  | { type: "fence_failure" }
  | { type: "preserve_residue" }
  | { type: "preserve_residue_failure" }
  | { type: "safe_recover" }
  | { type: "scene_continue" }
  | { type: "resume_pause" };

export const actionLabels: Record<PrototypeAction["type"], string> = {
  start: "启动受控执行",
  write: "当前执行写入文件",
  begin_validation: "固定待验证工作树",
  complete_stage: "阶段验证通过",
  pause_success: "主动暂停并完整保存",
  pause_save_failure: "主动暂停但保存失败",
  interrupt: "执行失联",
  old_process_write: "旧进程继续写入",
  fence_success: "确认旧进程已围栏",
  fence_failure: "围栏失败",
  preserve_residue: "独立保存现场",
  preserve_residue_failure: "现场保存失败",
  safe_recover: "安全恢复",
  scene_continue: "现场接续",
  resume_pause: "从暂停保存点继续",
};

export function createInitialState(): PrototypeState {
  return {
    phase: "ready",
    stage: 1,
    workingRevision: 0,
    workingTree: "tree-0",
    lease: null,
    process: "absent",
    processFenced: true,
    recoveryMode: "none",
    validationCandidate: null,
    recoveryPoints: [
      {
        sequence: 0,
        kind: "start_baseline",
        tree: "tree-0",
        stage: 0,
        resumeStage: 1,
        complete: true,
        provesStageCompletion: false,
      },
    ],
    residue: null,
    residuePersistence: "not_needed",
    preservedResidues: [],
    leaseCounter: 0,
    recoverySequence: 0,
    notice: "已建立起始基线，可以启动受控执行。",
    history: ["#0 已建立起始基线 tree-0"],
  };
}

export function latestCompleteRecoveryPoint(
  state: PrototypeState,
): RecoveryPoint {
  return [...state.recoveryPoints]
    .reverse()
    .find((point) => point.complete)!;
}

function cloneState(state: PrototypeState): PrototypeState {
  return {
    ...state,
    lease: state.lease ? { ...state.lease } : null,
    validationCandidate: state.validationCandidate
      ? { ...state.validationCandidate }
      : null,
    recoveryPoints: state.recoveryPoints.map((point) => ({ ...point })),
    residue: state.residue ? { ...state.residue } : null,
    preservedResidues: [...state.preservedResidues],
    history: [...state.history],
  };
}

function appendEvent(
  state: PrototypeState,
  label: string,
  notice: string,
): PrototypeState {
  state.notice = notice;
  state.history.push(`${label}: ${notice}`);
  state.history = state.history.slice(-8);
  return state;
}

function reject(
  state: PrototypeState,
  action: PrototypeAction,
  reason: string,
): PrototypeState {
  return appendEvent(
    cloneState(state),
    `拒绝 ${actionLabels[action.type]}`,
    reason,
  );
}

function issueLease(state: PrototypeState): void {
  state.leaseCounter += 1;
  state.lease = { id: `lease-${state.leaseCounter}`, status: "active" };
  state.process = "running";
  state.processFenced = false;
}

function expireLease(state: PrototypeState): void {
  if (state.lease) {
    state.lease.status = "expired";
  }
}

function recordResidue(state: PrototypeState): void {
  const recoveryPoint = latestCompleteRecoveryPoint(state);
  const nextResidue =
    state.workingTree === recoveryPoint.tree
      ? null
      : {
          tree: state.workingTree,
          afterRecoveryPoint: recoveryPoint.sequence,
        };

  if (!nextResidue) {
    state.residue = null;
    state.residuePersistence = "not_needed";
    return;
  }

  const isSameResidue =
    state.residue?.tree === nextResidue.tree &&
    state.residue.afterRecoveryPoint === nextResidue.afterRecoveryPoint;
  state.residue = nextResidue;
  if (!isSameResidue) {
    state.residuePersistence = "pending";
  }
}

function addRecoveryPoint(
  state: PrototypeState,
  point: Omit<RecoveryPoint, "sequence">,
): RecoveryPoint {
  state.recoverySequence += 1;
  const recoveryPoint = {
    ...point,
    sequence: state.recoverySequence,
  };
  state.recoveryPoints.push(recoveryPoint);
  return recoveryPoint;
}

export function reducePrototype(
  current: PrototypeState,
  action: PrototypeAction,
): PrototypeState {
  const state = cloneState(current);

  switch (action.type) {
    case "start": {
      if (state.phase !== "ready") {
        return reject(current, action, "只有 ready 状态可以首次启动。");
      }
      issueLease(state);
      state.phase = "running";
      state.recoveryMode = "none";
      return appendEvent(state, "启动", `已签发 ${state.lease!.id}。`);
    }

    case "write": {
      if (state.phase !== "running" || state.process !== "running") {
        return reject(current, action, "只有受控运行中的进程可以写入。");
      }
      state.workingRevision += 1;
      state.workingTree = `tree-${state.workingRevision}`;
      return appendEvent(
        state,
        "写入",
        `工作树变为 ${state.workingTree}，尚未形成恢复记录。`,
      );
    }

    case "begin_validation": {
      if (state.phase !== "running" || state.process !== "running") {
        return reject(current, action, "只有运行中的阶段可以固定待验证工作树。");
      }
      state.validationCandidate = {
        tree: state.workingTree,
        stage: state.stage,
      };
      return appendEvent(
        state,
        "开始验证",
        `已固定阶段 ${state.stage} 的待验证工作树 ${state.workingTree}。`,
      );
    }

    case "complete_stage": {
      if (state.phase !== "running" || state.process !== "running") {
        return reject(current, action, "只有运行中的阶段可以完成验证。");
      }
      if (!state.validationCandidate) {
        return reject(current, action, "尚未固定待验证工作树，不能创建阶段检查点。");
      }
      if (
        state.validationCandidate.stage !== state.stage ||
        state.validationCandidate.tree !== state.workingTree
      ) {
        return reject(
          current,
          action,
          "工作树在验证期间发生变化；必须重新固定并验证最新工作树。",
        );
      }
      const completedStage = state.stage;
      const point = addRecoveryPoint(state, {
        kind: "stage_checkpoint",
        tree: state.validationCandidate.tree,
        stage: completedStage,
        resumeStage: completedStage + 1,
        complete: true,
        provesStageCompletion: true,
      });
      state.stage += 1;
      state.validationCandidate = null;
      state.residue = null;
      state.residuePersistence = "not_needed";
      return appendEvent(
        state,
        "阶段完成",
        `阶段 ${completedStage} 验证通过，创建阶段检查点 #${point.sequence}。`,
      );
    }

    case "pause_success": {
      if (state.phase !== "running" || state.process !== "running") {
        return reject(current, action, "只有运行中的执行可以主动暂停。");
      }
      state.process = "stopped";
      state.processFenced = true;
      expireLease(state);
      state.validationCandidate = null;
      const point = addRecoveryPoint(state, {
        kind: "pause_savepoint",
        tree: state.workingTree,
        stage: state.stage,
        resumeStage: state.stage,
        complete: true,
        provesStageCompletion: false,
      });
      state.phase = "paused";
      state.residue = null;
      state.residuePersistence = "not_needed";
      return appendEvent(
        state,
        "暂停",
        `进程已停稳，创建暂停保存点 #${point.sequence}；阶段 ${state.stage} 未完成。`,
      );
    }

    case "pause_save_failure": {
      if (state.phase !== "running" || state.process !== "running") {
        return reject(current, action, "只有运行中的执行可以模拟暂停保存失败。");
      }
      state.process = "stopped";
      state.processFenced = true;
      expireLease(state);
      state.phase = "interrupted";
      state.validationCandidate = null;
      recordResidue(state);
      return appendEvent(
        state,
        "暂停失败",
        "旧进程已停止，但保存点不完整；保留现场并退回此前完整恢复位置。",
      );
    }

    case "interrupt": {
      if (state.phase !== "running") {
        return reject(current, action, "只有运行中的执行可以模拟失联。");
      }
      expireLease(state);
      state.phase = "interrupted";
      state.process = "unknown";
      state.processFenced = false;
      state.validationCandidate = null;
      recordResidue(state);
      return appendEvent(
        state,
        "执行失联",
        "租约已失效，但旧进程状态未知；签发新租约前必须完成围栏。",
      );
    }

    case "old_process_write": {
      if (state.phase !== "interrupted" || state.processFenced) {
        return reject(current, action, "只有未围栏的旧进程可能继续写入。");
      }
      state.process = "running";
      state.workingRevision += 1;
      state.workingTree = `tree-${state.workingRevision}`;
      recordResidue(state);
      return appendEvent(
        state,
        "旧进程写入",
        `租约已失效，但旧进程仍把工作树改为 ${state.workingTree}。`,
      );
    }

    case "fence_success": {
      if (state.phase !== "interrupted" || state.processFenced) {
        return reject(current, action, "当前没有需要围栏的旧执行。");
      }
      state.process = "stopped";
      state.processFenced = true;
      recordResidue(state);
      return appendEvent(
        state,
        "围栏完成",
        "已确认旧进程树不能继续写入，可以选择恢复路径。",
      );
    }

    case "fence_failure": {
      if (state.phase !== "interrupted" || state.processFenced) {
        return reject(current, action, "当前没有需要围栏的旧执行。");
      }
      return appendEvent(
        state,
        "围栏失败",
        "旧进程仍可能写入；委托保持已中断，安全恢复不可用。",
      );
    }

    case "preserve_residue": {
      if (state.phase !== "interrupted" || !state.processFenced) {
        return reject(current, action, "只有旧进程完成围栏后才能独立保存现场。");
      }
      if (!state.residue) {
        return reject(current, action, "当前没有待保存的现场。");
      }
      if (state.residuePersistence === "saved") {
        return reject(current, action, "当前现场已经独立保存。");
      }
      const reference = `${state.residue.tree} (after #${state.residue.afterRecoveryPoint})`;
      state.preservedResidues.push(reference);
      state.residuePersistence = "saved";
      return appendEvent(
        state,
        "现场已保存",
        `已独立保存 ${reference}，恢复或接续不会丢失该引用。`,
      );
    }

    case "preserve_residue_failure": {
      if (state.phase !== "interrupted" || !state.processFenced) {
        return reject(current, action, "只有旧进程完成围栏后才能模拟现场保存失败。");
      }
      if (!state.residue) {
        return reject(current, action, "当前没有待保存的现场。");
      }
      state.residuePersistence = "failed";
      return appendEvent(
        state,
        "现场保存失败",
        "待处理现场仍在原工作树中；禁止恢复或接续，直到独立保存成功。",
      );
    }

    case "safe_recover": {
      if (state.phase !== "interrupted") {
        return reject(current, action, "只有已中断委托可以安全恢复。");
      }
      if (!state.processFenced) {
        return reject(current, action, "旧进程尚未围栏，禁止签发新租约。");
      }
      if (state.residue && state.residuePersistence !== "saved") {
        return reject(current, action, "待处理现场尚未独立保存，禁止重置工作树。");
      }
      const point = latestCompleteRecoveryPoint(state);
      state.workingTree = point.tree;
      state.stage = point.resumeStage;
      state.residue = null;
      state.residuePersistence = "not_needed";
      state.validationCandidate = null;
      issueLease(state);
      state.phase = "running";
      state.recoveryMode = "safe";
      return appendEvent(
        state,
        "安全恢复",
        `从 ${point.kind} #${point.sequence} 恢复到 ${point.tree}，并签发 ${state.lease!.id}。`,
      );
    }

    case "scene_continue": {
      if (state.phase !== "interrupted") {
        return reject(current, action, "只有已中断委托可以选择现场接续。");
      }
      if (!state.processFenced) {
        return reject(current, action, "旧进程尚未围栏，禁止现场接续。");
      }
      if (!state.residue) {
        return reject(current, action, "当前没有待处理现场可供接续。");
      }
      if (state.residuePersistence !== "saved") {
        return reject(current, action, "待处理现场尚未独立保存，禁止现场接续。");
      }
      const continuedTree = state.residue.tree;
      state.residue = null;
      state.residuePersistence = "not_needed";
      state.validationCandidate = null;
      issueLease(state);
      state.phase = "running";
      state.recoveryMode = "scene_continue";
      return appendEvent(
        state,
        "现场接续",
        `从未验证现场 ${continuedTree} 继续并签发 ${state.lease!.id}；该路径不保证可靠恢复。`,
      );
    }

    case "resume_pause": {
      if (state.phase !== "paused" || !state.processFenced) {
        return reject(current, action, "只有完整暂停且旧进程停稳后可以继续。");
      }
      const point = latestCompleteRecoveryPoint(state);
      if (point.kind !== "pause_savepoint") {
        return reject(current, action, "最新完整恢复位置不是暂停保存点。");
      }
      state.stage = point.resumeStage;
      state.workingTree = point.tree;
      issueLease(state);
      state.phase = "running";
      state.recoveryMode = "safe";
      return appendEvent(
        state,
        "继续",
        `从暂停保存点 #${point.sequence} 继续阶段 ${state.stage}。`,
      );
    }
  }
}
