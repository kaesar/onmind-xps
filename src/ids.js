export function nowIso() {
  return new Date().toISOString();
}

// Secret versionId: UUID v4, AWS/SPI-compatible (see PLAN §7 + decision log).
// Native in Bun + Node 24, zero deps — same value space as SPI's UUID.randomUUID().
export function newVersionId() {
  return crypto.randomUUID();
}

// Opaque pagination token shared by both backends (decision: unified token).
// JSON backend: {o: offset}. DynamoDB backend: {lek: LastEvaluatedKey}.
export function encodeToken(obj) {
  return Buffer.from(JSON.stringify(obj), "utf8").toString("base64url");
}

export function decodeToken(raw) {
  if (!raw) return null;
  try {
    const j = JSON.parse(Buffer.from(String(raw), "base64url").toString("utf8"));
    if (j && typeof j === "object") return j;
    return null;
  } catch {
    return null;
  }
}
