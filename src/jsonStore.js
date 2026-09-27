import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { nowIso, decodeToken, encodeToken } from "./ids.js";

const FORMAT = "xsetup/v1";

function emptyDoc() {
  return { format: FORMAT, params: {}, secrets: {} };
}

export function jsonStore(path) {
  let chain = Promise.resolve();
  function atomic(fn) {
    const run = chain.then(fn);
    chain = run.catch(() => {});
    return run;
  }

  async function readDoc() {
    try {
      const raw = await readFile(path, "utf8");
      const doc = JSON.parse(raw);
      if (!doc || typeof doc !== "object" || !doc.params || !doc.secrets) return emptyDoc();
      return doc;
    } catch (e) {
      if (e.code === "ENOENT") return emptyDoc();
      throw e;
    }
  }

  async function writeDoc(doc) {
    const dir = dirname(path);
    await mkdir(dir === "" ? "." : dir, { recursive: true });
    const tmp = `${path}.tmp.${process.pid}`;
    await writeFile(tmp, JSON.stringify(doc, null, 2) + "\n", "utf8");
    const { rename } = await import("node:fs/promises");
    await rename(tmp, path);
  }

  return {
    mode: "json",
    path,

    async putParam(entry) {
      return atomic(async () => {
        const doc = await readDoc();
        const prev = doc.params[entry.name];
        const version = (prev?.version || 0) + 1;
        const saved = { ...entry, version, updatedAt: nowIso() };
        doc.params[entry.name] = saved;
        await writeDoc(doc);
        return saved;
      });
    },

    async getParam(name) {
      const doc = await readDoc();
      return doc.params[name] ?? null;
    },

    async deleteParam(name) {
      return atomic(async () => {
        const doc = await readDoc();
        if (!doc.params[name]) return false;
        delete doc.params[name];
        await writeDoc(doc);
        return true;
      });
    },

    async listParams(prefix = "/", maxResults = 50, nextToken = "") {
      const doc = await readDoc();
      const names = Object.keys(doc.params).filter((n) => n.startsWith(prefix)).sort();
      let offset = 0;
      if (nextToken) {
        const t = decodeToken(nextToken);
        offset = t && Number.isInteger(t.o) && t.o >= 0 ? t.o : 0;
      }
      const slice = names.slice(offset, offset + maxResults);
      const items = slice.map((n) => doc.params[n]);
      const newOffset = offset + slice.length;
      return { items, nextToken: newOffset < names.length ? encodeToken({ o: newOffset }) : null };
    },

    async createSecret(entry) {
      return atomic(async () => {
        const doc = await readDoc();
        if (doc.secrets[entry.name]) {
          const e = new Error(`Secret ${entry.name} already exists`);
          e.status = 400;
          throw e;
        }
        const saved = { ...entry, updatedAt: nowIso() };
        doc.secrets[entry.name] = saved;
        await writeDoc(doc);
        return saved;
      });
    },

    async getSecret(name) {
      const doc = await readDoc();
      return doc.secrets[name] ?? null;
    },

    async putSecret(entry) {
      return atomic(async () => {
        const doc = await readDoc();
        const saved = { ...entry, updatedAt: nowIso() };
        doc.secrets[entry.name] = saved;
        await writeDoc(doc);
        return saved;
      });
    },

    async deleteSecret(name) {
      return atomic(async () => {
        const doc = await readDoc();
        if (!doc.secrets[name]) return false;
        delete doc.secrets[name];
        await writeDoc(doc);
        return true;
      });
    },

    async listSecrets(maxResults = 50, nextToken = "") {
      const doc = await readDoc();
      const names = Object.keys(doc.secrets).sort();
      let offset = 0;
      if (nextToken) {
        const t = decodeToken(nextToken);
        offset = t && Number.isInteger(t.o) && t.o >= 0 ? t.o : 0;
      }
      const slice = names.slice(offset, offset + maxResults);
      const items = slice.map((n) => doc.secrets[n]);
      const newOffset = offset + slice.length;
      return { items, nextToken: newOffset < names.length ? encodeToken({ o: newOffset }) : null };
    },

    // Test helper: raw doc (to assert ciphertext-at-rest).
    async _raw() {
      return readDoc();
    },
  };
}
