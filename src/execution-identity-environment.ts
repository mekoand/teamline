import { createHash } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import type {
  ExecutionIdentity,
  ExecutionIdentityObservation,
} from "./execution-identity";

export interface ExecutionIdentityEnvironment {
  create(identityId: string): Promise<{ managedHomePath: string }>;
  remove(identityId: string): Promise<void>;
  inspect(identity: ExecutionIdentity): Promise<ExecutionIdentityObservation>;
}

export class LocalCodexIdentityEnvironment implements ExecutionIdentityEnvironment {
  private readonly root: string;
  private readonly executable: string;
  private readonly systemHome: string;
  private readonly timeoutMs: number;

  constructor(
    root: string,
    options: {
      executable?: string;
      systemHome: string;
      timeoutMs?: number;
    },
  ) {
    this.root = resolve(root);
    this.executable = options.executable ?? "codex";
    this.systemHome = resolve(options.systemHome);
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  async create(identityId: string): Promise<{ managedHomePath: string }> {
    const managedHomePath = this.identityPath(identityId);
    mkdirSync(managedHomePath, { recursive: true, mode: 0o700 });
    return { managedHomePath };
  }

  async remove(identityId: string): Promise<void> {
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
}

async function readCodexAccount(
  executable: string,
  codexHome: string,
  timeoutMs: number,
): Promise<Record<string, unknown> | null> {
  const subprocess = Bun.spawn([executable, "app-server"], {
    env: { ...process.env, CODEX_HOME: codexHome },
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
