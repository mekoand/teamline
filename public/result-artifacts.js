export function gitArtifactPaths(statusShort) {
  return String(statusShort ?? "")
    .split(/\r?\n/)
    .map(parseGitStatusLine)
    .filter(Boolean)
    .slice(0, 12);
}

function parseGitStatusLine(line) {
  if (line.length < 4 || line[2] !== " ") return null;
  const status = line.slice(0, 2);
  if (!/^[ MADRCUT?!]{2}$/.test(status) || status.includes("D") || status === "!!") {
    return null;
  }

  const value = line.slice(3);
  if (status.includes("R")) {
    const parts = value.split(" -> ");
    if (parts.length !== 2 || !isSafeRelativePath(parts[0])) return null;
    return isSafeRelativePath(parts[1]) ? parts[1] : null;
  }
  if (status.includes("C") || value.includes(" -> ")) return null;
  if (status !== "??" && !/[AMTU]/.test(status)) return null;
  return isSafeRelativePath(value) ? value : null;
}

function isSafeRelativePath(path) {
  if (!path || path !== path.trim() || path.startsWith("/") || path.startsWith('"')) {
    return false;
  }
  if (path.includes("\\") || /[\u0000-\u001f\u007f]/.test(path)) return false;
  const parts = path.split("/");
  return parts.every((part) => part && part !== "." && part !== "..");
}
