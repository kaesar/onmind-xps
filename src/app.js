import { Hono } from "hono";
import { cors } from "hono/cors";
import { storageFromEnv } from "./store.js";
import { seal, open, isEnvelope } from "./crypto.js";
import {
  validateParamName,
  validateSecretName,
  validateParamType,
  validateVersionId,
  parseMaxResults,
  validateTags,
} from "./validate.js";
import { nowIso, newVersionId } from "./ids.js";

function paramNameFromPath(c) {
  const prefix = "/parameters";
  const p = c.req.path;
  if (!p.startsWith(prefix + "/")) return null;
  const raw = p.slice(prefix.length + 1);
  if (!raw) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

function secretIdFromPath(c) {
  const prefix = "/secrets";
  const p = c.req.path;
  if (!p.startsWith(prefix + "/")) return null;
  const raw = p.slice(prefix.length + 1);
  if (!raw) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

async function secretValueToClear(version, env) {
  const bytes = await open(version.value, env);
  if (version.binary) return { binary: Buffer.from(bytes).toString("base64") };
  return { string: new TextDecoder().decode(bytes) };
}

function pickSecretPayload(body) {
  const hasString = body.secretString !== undefined && body.secretString !== null;
  const hasBinary = body.secretBinary !== undefined && body.secretBinary !== null;
  if (hasString === hasBinary) {
    const e = new Error("Provide exactly one of secretString | secretBinary");
    e.status = 400;
    throw e;
  }
  if (hasString && typeof body.secretString !== "string") {
    const e = new Error("secretString must be a string");
    e.status = 400;
    throw e;
  }
  if (hasBinary) {
    if (typeof body.secretBinary !== "string" || !body.secretBinary.trim()) {
      const e = new Error("secretBinary must be base64");
      e.status = 400;
      throw e;
    }
    try {
      Buffer.from(body.secretBinary.trim(), "base64");
    } catch {
      const e = new Error("secretBinary must be base64");
      e.status = 400;
      throw e;
    }
  }
  return hasString ? { kind: "string", value: body.secretString } : { kind: "binary", value: body.secretBinary.trim() };
}

export function createApp(env = process.env, storage = null) {
  const app = new Hono();
  const store = storage ?? storageFromEnv(env);
  const API_KEY = env.XPS_API_KEY || "";

  const origins = (env.XPS_CORS_ORIGINS || "*").split(",").map((s) => s.trim()).filter(Boolean);
  app.use("*", cors({ origin: origins.includes("*") ? "*" : origins }));
  app.use("*", apiKeyGuard(API_KEY));

  app.onError((err, c) => {
    console.error("[OnMind-XPS] unhandled:", err);
    return c.json({ message: "Internal error" }, 500);
  });

  app.get("/health", (c) => c.json({ ok: true, env: env.XPS_ENV || "dev", storage: store.mode }));

  // ---- Parameters ----
  app.get("/parameters", async (c) => {
    try {
      const path = c.req.query("path") || "/";
      const maxResults = parseMaxResults(c.req.query("maxResults"));
      const nextToken = c.req.query("nextToken") || "";
      const { items, nextToken: nt } = await store.listParams(path, maxResults, nextToken);
      const out = [];
      for (const p of items) {
        if (p.type === "SecureString" && isEnvelope(p.value)) {
          out.push({ ...p, value: await open_to_string(p.value, env) });
        } else out.push(p);
      }
      return c.json({ items: out, count: out.length, ...(nt ? { nextToken: nt } : {}) });
    } catch (e) {
      return c.json({ message: e.message || "Bad request" }, e.status || 400);
    }
  });

  app.put("/parameters/*", async (c) => {
    try {
      const name = paramNameFromPath(c);
      if (!name) return c.json({ message: "Missing parameter name" }, 400);
      validateParamName(name);
      let body = {};
      try {
        body = await c.req.json();
      } catch {
        return c.json({ message: "Invalid JSON" }, 400);
      }
      if (typeof body.value !== "string") return c.json({ message: "Missing value (string)" }, 400);
      const type = validateParamType(body.type);
      const tags = validateTags(body.tags);
      const description = typeof body.description === "string" ? body.description : "";
      const value = type === "SecureString" ? await seal(body.value, env) : body.value;
      const saved = await store.putParam({ name, value, type, description, tags });
      const out = type === "SecureString" ? { ...saved, value: body.value } : saved;
      return c.json(out);
    } catch (e) {
      return c.json({ message: e.message || "Bad request" }, e.status || 400);
    }
  });

  app.get("/parameters/*", async (c) => {
    try {
      const name = paramNameFromPath(c);
      if (!name) return c.json({ message: "Missing parameter name" }, 400);
      validateParamName(name);
      const p = await store.getParam(name);
      if (!p) return c.json({ message: "Not found" }, 404);
      if (p.type === "SecureString" && isEnvelope(p.value)) {
        return c.json({ ...p, value: await open_to_string(p.value, env) });
      }
      return c.json(p);
    } catch (e) {
      return c.json({ message: e.message || "Bad request" }, e.status || 400);
    }
  });

  app.delete("/parameters/*", async (c) => {
    try {
      const name = paramNameFromPath(c);
      if (!name) return c.json({ message: "Missing parameter name" }, 400);
      validateParamName(name);
      const ok = await store.deleteParam(name);
      if (!ok) return c.json({ message: "Not found" }, 404);
      return c.body(null, 204);
    } catch (e) {
      return c.json({ message: e.message || "Bad request" }, e.status || 400);
    }
  });

  // ---- Secrets ----
  app.get("/secrets", async (c) => {
    try {
      const maxResults = parseMaxResults(c.req.query("maxResults"));
      const nextToken = c.req.query("nextToken") || "";
      const { items, nextToken: nt } = await store.listSecrets(maxResults, nextToken);
      const metas = items.map((s) => ({
        name: s.name,
        description: s.description || "",
        currentVersion: s.currentVersion,
        versionStages: s.versions?.[s.currentVersion]?.stages || ["AWSCURRENT"],
        versions: Object.keys(s.versions || {}).length,
        tags: s.tags || {},
        updatedAt: s.updatedAt,
      }));
      return c.json({ items: metas, count: metas.length, ...(nt ? { nextToken: nt } : {}) });
    } catch (e) {
      return c.json({ message: e.message || "Bad request" }, e.status || 400);
    }
  });

  app.post("/secrets", async (c) => {
    try {
      let body = {};
      try {
        body = await c.req.json();
      } catch {
        return c.json({ message: "Invalid JSON" }, 400);
      }
      if (!body.name) return c.json({ message: "Missing name" }, 400);
      validateSecretName(body.name);
      const payload = pickSecretPayload(body);
      const tags = validateTags(body.tags);
      const description = typeof body.description === "string" ? body.description : "";
      const versionId = newVersionId();
      const createdAt = nowIso();
      const envelope =
        payload.kind === "string" ? await seal(payload.value, env) : await seal(Buffer.from(payload.value, "base64"), env);
      const entry = {
        name: body.name,
        description,
        versions: { [versionId]: { value: envelope, stages: ["AWSCURRENT"], createdAt, binary: payload.kind === "binary" } },
        currentVersion: versionId,
        tags,
      };
      await store.createSecret(entry);
      return c.json({ name: body.name, versionId, versionStages: ["AWSCURRENT"] }, 201);
    } catch (e) {
      return c.json({ message: e.message || "Bad request" }, e.status || 400);
    }
  });

  app.get("/secrets/*", async (c) => {
    try {
      const id = secretIdFromPath(c);
      if (!id) return c.json({ message: "Missing secret id" }, 400);
      validateSecretName(id);
      const versionId = c.req.query("versionId") || undefined;
      validateVersionId(versionId);
      const s = await store.getSecret(id);
      if (!s) return c.json({ message: "Not found" }, 404);
      const target = versionId || s.currentVersion;
      const v = s.versions?.[target];
      if (!v) return c.json({ message: "Version not found" }, 404);
      const clear = await secretValueToClear(v, env);
      return c.json({
        name: s.name,
        versionId: target,
        ...(clear.string !== undefined ? { secretString: clear.string } : { secretBinary: clear.binary }),
        versionStages: v.stages,
        description: s.description || "",
        createdAt: v.createdAt,
      });
    } catch (e) {
      return c.json({ message: e.message || "Bad request" }, e.status || 400);
    }
  });

  app.put("/secrets/*", async (c) => {
    try {
      const id = secretIdFromPath(c);
      if (!id) return c.json({ message: "Missing secret id" }, 400);
      validateSecretName(id);
      let body = {};
      try {
        body = await c.req.json();
      } catch {
        return c.json({ message: "Invalid JSON" }, 400);
      }
      const payload = pickSecretPayload(body);
      const s = await store.getSecret(id);
      if (!s) return c.json({ message: "Not found" }, 404);
      const versionId = newVersionId();
      const createdAt = nowIso();
      const envelope =
        payload.kind === "string" ? await seal(payload.value, env) : await seal(Buffer.from(payload.value, "base64"), env);
      const versions = { ...s.versions };
      if (versions[s.currentVersion]) {
        versions[s.currentVersion] = { ...versions[s.currentVersion], stages: ["AWSPREVIOUS"] };
      }
      versions[versionId] = { value: envelope, stages: ["AWSCURRENT"], createdAt, binary: payload.kind === "binary" };
      const updated = {
        ...s,
        versions,
        currentVersion: versionId,
        ...(typeof body.description === "string" ? { description: body.description } : {}),
      };
      await store.putSecret(updated);
      return c.json({ name: id, versionId, versionStages: ["AWSCURRENT"] });
    } catch (e) {
      return c.json({ message: e.message || "Bad request" }, e.status || 400);
    }
  });

  app.delete("/secrets/*", async (c) => {
    try {
      const id = secretIdFromPath(c);
      if (!id) return c.json({ message: "Missing secret id" }, 400);
      validateSecretName(id);
      const ok = await store.deleteSecret(id);
      if (!ok) return c.json({ message: "Not found" }, 404);
      return c.body(null, 204);
    } catch (e) {
      return c.json({ message: e.message || "Bad request" }, e.status || 400);
    }
  });

  app.notFound((c) => c.json({ message: "Not found" }, 404));
  return app;
}

async function open_to_string(envelope, env) {
  const { openToString } = await import("./crypto.js");
  return openToString(envelope, env);
}

function apiKeyGuard(apiKey) {
  return async (c, next) => {
    if (!apiKey) return next();
    if (c.req.path === "/health") return next();
    const got = c.req.header("x-api-key") || "";
    if (got !== apiKey) return c.json({ message: "Forbidden" }, 403);
    return next();
  };
}
