const PARAM_NAME_RE = /^\/[A-Za-z0-9._\-/]+$/;
const SECRET_NAME_RE = /^[A-Za-z0-9._\-/]+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PARAM_TYPES = new Set(["String", "StringList", "SecureString"]);

export function validateParamName(name) {
  if (!name || !PARAM_NAME_RE.test(name) || name.includes("//")) {
    const e = new Error("Invalid parameter name (must match ^/[A-Za-z0-9._-/]+$)");
    e.status = 400;
    throw e;
  }
}

export function validateSecretName(name) {
  if (!name || !SECRET_NAME_RE.test(name) || name.includes("//") || name.length > 512) {
    const e = new Error("Invalid secret name (must match ^[A-Za-z0-9._-/]+$)");
    e.status = 400;
    throw e;
  }
}

export function validateParamType(type) {
  const t = type || "String";
  if (!PARAM_TYPES.has(t)) {
    const e = new Error("Invalid type (use String | StringList | SecureString)");
    e.status = 400;
    throw e;
  }
  return t;
}

export function validateVersionId(versionId) {
  if (versionId != null && !UUID_RE.test(versionId)) {
    const e = new Error("Invalid version ID format. Must be a valid UUID");
    e.status = 400;
    throw e;
  }
}

export function parseMaxResults(raw, def = 50) {
  if (raw == null || raw === "") return def;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) {
    const e = new Error("Invalid maxResults (must be 1..100)");
    e.status = 400;
    throw e;
  }
  return Math.min(n, 100);
}

export function validateTags(tags) {
  if (tags == null) return {};
  if (typeof tags !== "object" || Array.isArray(tags)) {
    const e = new Error("Invalid tags (must be an object)");
    e.status = 400;
    throw e;
  }
  for (const [k, v] of Object.entries(tags)) {
    if (typeof v !== "string") {
      const e = new Error("Invalid tags (values must be strings)");
      e.status = 400;
      throw e;
    }
    if (k.length > 128 || v.length > 256) {
      const e = new Error("Invalid tags (key<=128, value<=256 chars)");
      e.status = 400;
      throw e;
    }
  }
  return tags;
}
