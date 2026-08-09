import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

const bindingVersion = 1;
const bindingFileName = "client-binding.json";

export class DataDirectoryChoiceRequiredError extends Error {
  constructor(details) {
    super("请选择 Teamline 要使用的现有数据目录，或确认新建本地数据目录");
    this.name = "DataDirectoryChoiceRequiredError";
    this.code = "DATA_DIRECTORY_CHOICE_REQUIRED";
    this.details = details;
  }
}

export class DataDirectoryBindingError extends Error {
  constructor(message) {
    super(message);
    this.name = "DataDirectoryBindingError";
    this.code = "DATA_DIRECTORY_BINDING_INVALID";
  }
}

export async function resolveClientDataDirectory(options = {}) {
  const environment = options.environment ?? process.env;
  const projectRoot = resolve(options.projectRoot ?? process.cwd());
  const explicit = environment.TEAMLINE_DATA_DIR?.trim();
  if (explicit) {
    return {
      dataDirectory: resolve(explicit),
      source: "explicit",
      bindingPath: null,
    };
  }

  if (!options.packaged) {
    return {
      dataDirectory: join(projectRoot, ".teamline"),
      source: "source",
      bindingPath: null,
    };
  }

  const userDataPath = options.userDataPath?.trim();
  if (!userDataPath) {
    throw new DataDirectoryBindingError("打包客户端缺少 Electron userData 路径");
  }
  const canonicalDirectory = resolve(userDataPath, "Teamline");
  const bindingPath = join(canonicalDirectory, bindingFileName);
  const binding = readBinding(bindingPath);

  if (binding) {
    if (!isBoundDirectory(binding)) {
      throw new DataDirectoryBindingError(
        `已记住的 Teamline 数据目录不存在或不可用：${binding.dataDirectory}`,
      );
    }
    return {
      dataDirectory: binding.dataDirectory,
      source: "binding",
      bindingPath,
      canonicalDirectory,
      binding,
    };
  }

  if (isDataDirectory(canonicalDirectory)) {
    const saved = persistBinding(bindingPath, canonicalDirectory, "canonical");
    return {
      dataDirectory: canonicalDirectory,
      source: "canonical",
      bindingPath,
      canonicalDirectory,
      binding: saved,
    };
  }

  const legacyDirectories = uniquePaths(
    options.legacyDirectories ?? [join(projectRoot, ".teamline")],
  ).filter((directory) => isDataDirectory(directory));
  const chooseDataDirectory = options.chooseDataDirectory;
  if (typeof chooseDataDirectory !== "function") {
    throw new DataDirectoryChoiceRequiredError({
      canonicalDirectory,
      candidates: legacyDirectories,
    });
  }

  const choice = await chooseDataDirectory({
    canonicalDirectory,
    candidates: legacyDirectories,
  });
  if (!choice || choice.action === "cancel") {
    throw new DataDirectoryChoiceRequiredError({
      canonicalDirectory,
      candidates: legacyDirectories,
    });
  }

  if (choice.action === "use") {
    const selected = resolve(choice.dataDirectory ?? "");
    if (!isDataDirectory(selected)) {
      throw new DataDirectoryBindingError(
        "所选目录不是可识别的 Teamline 数据目录",
      );
    }
    const saved = persistBinding(bindingPath, selected, "legacy");
    return {
      dataDirectory: selected,
      source: "legacy",
      bindingPath,
      canonicalDirectory,
      binding: saved,
    };
  }

  if (choice.action === "create") {
    mkdirSync(canonicalDirectory, { recursive: true });
    const saved = persistBinding(bindingPath, canonicalDirectory, "canonical");
    return {
      dataDirectory: canonicalDirectory,
      source: "canonical-created",
      bindingPath,
      canonicalDirectory,
      binding: saved,
    };
  }

  throw new DataDirectoryChoiceRequiredError({
    canonicalDirectory,
    candidates: legacyDirectories,
  });
}

export function isDataDirectory(directory) {
  try {
    return statSync(directory).isDirectory() && existsSync(join(directory, "teamline.db"));
  } catch {
    return false;
  }
}

export function readBinding(bindingPath) {
  if (!existsSync(bindingPath)) return null;
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(bindingPath, "utf8"));
  } catch {
    throw new DataDirectoryBindingError(`无法读取 Teamline 数据目录绑定：${bindingPath}`);
  }
  if (
    !parsed ||
    parsed.version !== bindingVersion ||
    typeof parsed.dataDirectory !== "string" ||
    !parsed.dataDirectory.trim() ||
    !["canonical", "legacy"].includes(parsed.kind)
  ) {
    throw new DataDirectoryBindingError(`Teamline 数据目录绑定格式无效：${bindingPath}`);
  }
  return {
    version: bindingVersion,
    kind: parsed.kind,
    dataDirectory: resolve(parsed.dataDirectory),
    boundAt: typeof parsed.boundAt === "string" ? parsed.boundAt : null,
  };
}

export function persistBinding(bindingPath, dataDirectory, kind) {
  const binding = {
    version: bindingVersion,
    kind,
    dataDirectory: resolve(dataDirectory),
    boundAt: new Date().toISOString(),
  };
  mkdirSync(dirname(bindingPath), { recursive: true });
  const temporaryPath = `${bindingPath}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(temporaryPath, `${JSON.stringify(binding)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  renameSync(temporaryPath, bindingPath);
  return binding;
}

function uniquePaths(paths) {
  return [...new Set(paths.map((path) => resolve(path)))];
}

function isBoundDirectory(binding) {
  if (binding.kind === "canonical") {
    try {
      return statSync(binding.dataDirectory).isDirectory();
    } catch {
      return false;
    }
  }
  return isDataDirectory(binding.dataDirectory);
}
