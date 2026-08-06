import { createHash } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import type {
  ExecutionIdentity,
  ExecutionIdentityObservation,
} from "./execution-identity";
import { codexProcessEnvironment } from "./codex-environment";

export interface ExecutionIdentityEnvironment {
  create(identityId: string): Promise<{ managedHomePath: string }>;
  remove(identityId: string): Promise<void>;
  inspect(identity: ExecutionIdentity): Promise<ExecutionIdentityObservation>;
  startLogin(identity: ExecutionIdentity): Promise<ExecutionIdentityLoginOperation>;
  getLoginStatus(identityId: string): ExecutionIdentityLoginOperation;
}

export type ExecutionIdentityLoginOperation =
  | { status: "idle" }
  | { status: "in_progress"; startedAt: string }
  | { status: "completed"; startedAt: string; finishedAt: string }
  | { status: "failed"; startedAt: string; finishedAt: string; error: string };

export class ExecutionIdentityLoginInProgressError extends Error {}

export class LocalCodexIdentityEnvironment implements ExecutionIdentityEnvironment {
  private readonly root: string;
  private readonly executable: string;
  private readonly systemHome: string;
  private readonly timeoutMs: number;
  private readonly loginTimeoutMs: number;
  private readonly loginOperations = new Map<
    string,
    ExecutionIdentityLoginOperation
  >();
  private readonly loginProcesses = new Map<
    string,
    {
      subprocess: ReturnType<typeof Bun.spawn>;
      cancelTimeout: () => void;
      timedOut: boolean;
    }
  >();

  constructor(
    root: string,
    options: {
      executable?: string;
      systemHome: string;
      timeoutMs?: number;
      loginTimeoutMs?: number;
    },
  ) {
    this.root = resolve(root);
    this.executable = options.executable ?? "codex";
    this.systemHome = resolve(options.systemHome);
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.loginTimeoutMs = options.loginTimeoutMs ?? 10 * 60_000;
  }

  async create(identityId: string): Promise<{ managedHomePath: string }> {
    const managedHomePath = this.identityPath(identityId);
    mkdirSync(managedHomePath, { recursive: true, mode: 0o700 });
    return { managedHomePath };
  }

  async remove(identityId: string): Promise<void> {
    await this.stopLogin(identityId);
    this.loginOperations.delete(identityId);
    rmSync(this.identityPath(identityId), { recursive: true, force: true });
  }

  async inspect(identity: ExecutionIdentity): Promise<ExecutionIdentityObservation> {
    if (identity.status === "removed") throw new Error("已移除的账号不能连接 Codex");
    const codexHome =
      identity.homeKind === "managed" ? identity.managedHomePath : this.systemHome;
    if (!codexHome) throw new Error("Codex 账号目录不可用");
    const account = await readCodexAccount(
      this.executable,
      codexHome,
      this.timeoutMs,
    );
    return {
      accountFingerprint: account
        ? createHash("sha256")
            .update(JSON.stringify(account))
            .digest("hex")
            .slice(0, 12)
        : null,
      loginState: account ? "ready" : "signed_out",
      capabilities: ["app-server", ...(account ? ["sessions"] : [])],
    };
  }

  async startLogin(
    identity: ExecutionIdentity,
  ): Promise<ExecutionIdentityLoginOperation> {
    if (identity.status !== "enabled") throw new Error("这个 Codex 账号当前不可用");
    if (identity.homeKind !== "managed") {
      throw new Error("系统 Codex 账号请使用 Codex 自身的登录状态");
    }
    if (identity.loginState !== "signed_out" && identity.loginState !== "expired") {
      throw new Error("这个 Codex 账号已有登录状态");
    }
    const managedHomePath = identity.managedHomePath;
    if (!managedHomePath || resolve(managedHomePath) !== this.identityPath(identity.id)) {
      throw new Error("Codex 账号目录不可用");
    }
    if (this.loginProcesses.has(identity.id)) {
      throw new ExecutionIdentityLoginInProgressError("Codex 登录正在进行中");
    }

    const startedAt = new Date().toISOString();
    let subprocess: ReturnType<typeof Bun.spawn>;
    try {
      subprocess = Bun.spawn([this.executable, "login"], {
        env: codexProcessEnvironment({ codexHome: managedHomePath }),
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      });
    } catch {
      const operation: ExecutionIdentityLoginOperation = {
        status: "failed",
        startedAt,
        finishedAt: new Date().toISOString(),
        error: "无法启动 Codex 登录流程",
      };
      this.loginOperations.set(identity.id, operation);
      throw new Error(operation.error);
    }

    const operation: ExecutionIdentityLoginOperation = {
      status: "in_progress",
      startedAt,
    };
    const activeLogin = {
      subprocess,
      cancelTimeout: () => undefined,
      timedOut: false,
    };
    const timeout = setTimeout(() => {
      if (this.loginProcesses.get(identity.id) !== activeLogin) return;
      activeLogin.timedOut = true;
      this.loginOperations.set(identity.id, {
        status: "failed",
        startedAt,
        finishedAt: new Date().toISOString(),
        error: "Codex 登录已超时，请重试",
      });
      void this.stopLogin(identity.id);
    }, this.loginTimeoutMs);
    timeout.unref?.();
    activeLogin.cancelTimeout = () => clearTimeout(timeout);
    this.loginOperations.set(identity.id, operation);
    this.loginProcesses.set(identity.id, activeLogin);
    void subprocess.exited.then(
      (exitCode) => {
        if (this.loginProcesses.get(identity.id) !== activeLogin) return;
        activeLogin.cancelTimeout();
        this.loginProcesses.delete(identity.id);
        if (activeLogin.timedOut) return;
        const finishedAt = new Date().toISOString();
        this.loginOperations.set(
          identity.id,
          exitCode === 0
            ? { status: "completed", startedAt, finishedAt }
            : {
                status: "failed",
                startedAt,
                finishedAt,
                error: "Codex 登录未成功完成，请重试",
              },
        );
      },
      () => {
        if (this.loginProcesses.get(identity.id) !== activeLogin) return;
        activeLogin.cancelTimeout();
        this.loginProcesses.delete(identity.id);
        this.loginOperations.set(identity.id, {
          status: "failed",
          startedAt,
          finishedAt: new Date().toISOString(),
          error: "Codex 登录进程状态不可用，请重试",
        });
      },
    );
    return operation;
  }

  getLoginStatus(identityId: string): ExecutionIdentityLoginOperation {
    return this.loginOperations.get(identityId) ?? { status: "idle" };
  }

  async close(): Promise<void> {
    await Promise.all(
      [...this.loginProcesses.keys()].map((identityId) =>
        this.stopLogin(identityId)
      ),
    );
  }

  private identityPath(identityId: string): string {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        identityId,
      )
    ) {
      throw new Error("Codex 账号标识无效");
    }
    return join(this.root, identityId);
  }

  private async stopLogin(identityId: string): Promise<void> {
    const activeLogin = this.loginProcesses.get(identityId);
    if (!activeLogin) return;
    activeLogin.cancelTimeout();
    const { subprocess } = activeLogin;
    try {
      subprocess.kill();
    } catch {
      // The exit observer owns final state cleanup if the process already exited.
    }
    try {
      await withTimeout(subprocess.exited, 1_000, "停止 Codex 登录流程超时");
    } catch {
      try {
        subprocess.kill(9);
      } catch {
        // Awaiting exited below still reaps a process that raced with SIGKILL.
      }
      await subprocess.exited;
    }
  }
}

async function readCodexAccount(
  executable: string,
  codexHome: string,
  timeoutMs: number,
): Promise<Record<string, unknown> | null> {
  const subprocess = Bun.spawn([executable, "app-server"], {
    env: codexProcessEnvironment({ codexHome }),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const writer = subprocess.stdin;
  writer.write(
    `${JSON.stringify({
      method: "initialize",
      id: 0,
      params: {
        clientInfo: {
          name: "teamline",
          title: "Teamline",
          version: "0.1.0",
        },
      },
    })}\n`,
  );
  writer.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);
  writer.write(
    `${JSON.stringify({
      method: "account/read",
      id: 2,
      params: { refreshToken: true },
    })}\n`,
  );
  writer.flush();

  try {
    const response = await withTimeout(
      readAccountResponse(subprocess.stdout),
      timeoutMs,
      "Codex 账号状态读取超时",
    );
    if (response.error) throw new Error("Codex 账号状态读取失败");
    const account = response.result?.account;
    return account && typeof account === "object"
      ? (account as Record<string, unknown>)
      : null;
  } finally {
    writer.end();
    subprocess.kill();
  }
}

async function readAccountResponse(stream: ReadableStream<Uint8Array>): Promise<{
  result?: { account?: unknown };
  error?: unknown;
}> {
  const reader = stream.pipeThrough(new TextDecoderStream()).getReader();
  let pending = "";
  while (true) {
    const { done, value } = await reader.read();
    pending += value ?? "";
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      const response = JSON.parse(line) as {
        id?: number;
        result?: { account?: unknown };
        error?: unknown;
      };
      if (response.id === 2) return response;
    }
    if (done) throw new Error("Codex 未返回账号状态");
  }
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
