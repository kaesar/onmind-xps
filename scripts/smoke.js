import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.js";
import { storageFromEnv } from "../src/store.js";
import { getKey } from "../src/crypto.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let pass = 0;
let fail = 0;
function check(name, cond, extra = "") {
  if (cond) {
    pass++;
    console.log(`ok - ${name}`);
  } else {
    fail++;
    console.log(`FAIL - ${name} ${extra}`);
  }
}

const dir = await mkdtemp(join(tmpdir(), "xps-smoke-"));
const jsonPath = join(dir, "xsetup.json");
const store = storageFromEnv({ XPS_STORAGE: "json", XPS_JSON_PATH: jsonPath });
const app = createApp({ XPS_ENV: "dev", XPS_ENCRYPTION_KEY: "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff" }, store);
const req = (path, init) => app.request(path, init);
const J = (r) => r.json();

// 1 health
{
  const r = await req("/health");
  const j = await J(r);
  check("health 200 + storage json", r.status === 200 && j.ok && j.storage === "json", JSON.stringify(j));
}

// 2 parameters CRUD
{
  const put1 = await req("/parameters/%2Fapp%2Fdb%2Fhost", {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ value: "db.local", type: "String" }),
  });
  const j1 = await J(put1);
  check("PUT param v1", put1.status === 200 && j1.version === 1 && j1.value === "db.local", JSON.stringify(j1));

  const get1 = await req("/parameters/%2Fapp%2Fdb%2Fhost");
  const gj1 = await J(get1);
  check("GET param returns value", get1.status === 200 && gj1.value === "db.local", JSON.stringify(gj1));

  const put2 = await req("/parameters/%2Fapp%2Fdb%2Fhost", {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ value: "db.v2", type: "String" }),
  });
  const j2 = await J(put2);
  check("PUT param bumps to v2", put2.status === 200 && j2.version === 2, JSON.stringify(j2));

  await req("/parameters/%2Fapp%2Fother", {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ value: "x" }),
  });
  const list = await req("/parameters?path=/app/db");
  const lj = await J(list);
  check("GET /parameters?path filters", list.status === 200 && lj.count === 1, JSON.stringify(lj));

  const del = await req("/parameters/%2Fapp%2Fdb%2Fhost", { method: "DELETE" });
  check("DELETE param 204", del.status === 204);
  const gone = await req("/parameters/%2Fapp%2Fdb%2Fhost");
  check("GET deleted param 404", gone.status === 404);
}

// 3 validation
{
  const bad = await req("/parameters/no-leading-slash", {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ value: "x" }),
  });
  check("param without leading / -> 400", bad.status === 400);
  const noval = await req("/parameters/%2Fa", {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  check("PUT without value -> 400", noval.status === 400);
}

// 4 secrets
let v1 = "";
{
  const cr = await req("/secrets", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "api/stripe", secretString: "sk-test" }),
  });
  const cj = await J(cr);
  v1 = cj.versionId || "";
  check("POST /secrets 201 + UUID versionId", cr.status === 201 && UUID_RE.test(v1), JSON.stringify(cj));

  const g = await req("/secrets/api%2Fstripe");
  const gj = await J(g);
  check("GET secret returns clear + AWSCURRENT", g.status === 200 && gj.secretString === "sk-test" && gj.versionStages?.includes("AWSCURRENT"), JSON.stringify(gj));

  const raw = await readFile(jsonPath, "utf8");
  check("cleartext NOT on disk (envelope only)", !raw.includes("sk-test") && raw.includes("AES-256-GCM"), raw.slice(0, 120));

  const sec = await req("/secrets", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "bin/data", secretBinary: Buffer.from([1, 2, 3]).toString("base64") }),
  });
  check("POST secretBinary 201", sec.status === 201);
  const bg = await J(await req("/secrets/bin%2Fdata"));
  check("GET secretBinary roundtrips", bg.secretBinary === Buffer.from([1, 2, 3]).toString("base64"), JSON.stringify(bg));

  const up = await req("/secrets/api%2Fstripe", {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ secretString: "sk-test-2" }),
  });
  const uj = await J(up);
  check("PUT rotates (new UUID)", up.status === 200 && UUID_RE.test(uj.versionId) && uj.versionId !== v1, JSON.stringify(uj));

  const old = await J(await req(`/secrets/api%2Fstripe?versionId=${v1}`));
  check("GET ?versionId=old returns previous + AWSPREVIOUS", old.secretString === "sk-test" && old.versionStages?.includes("AWSPREVIOUS"), JSON.stringify(old));

  const badVer = await req(`/secrets/api%2Fstripe?versionId=v1`);
  check("GET ?versionId=v1 -> 400 (UUID required)", badVer.status === 400);

  const list = await J(await req("/secrets"));
  check("GET /secrets never leaks values", list.items?.every((m) => m.secretString === undefined && m.value === undefined), JSON.stringify(list).slice(0, 200));

  const del = await req("/secrets/api%2Fstripe", { method: "DELETE" });
  check("DELETE secret 204", del.status === 204);
  check("GET deleted secret 404", (await req("/secrets/api%2Fstripe")).status === 404);
}

// 5 SecureString param encrypted at rest
{
  await req("/parameters/%2Fapp%2Ftoken", {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ value: "s3cr3t", type: "SecureString" }),
  });
  const raw = await readFile(jsonPath, "utf8");
  check("SecureString encrypted at rest", !raw.includes("s3cr3t") && raw.includes("AES-256-GCM"));
  const g = await J(await req("/parameters/%2Fapp%2Ftoken"));
  check("SecureString GET decrypts", g.value === "s3cr3t", JSON.stringify(g).slice(0, 160));
}

// 6 auth
{
  const guarded = createApp(
    { XPS_API_KEY: "k123", XPS_ENCRYPTION_KEY: "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff" },
    store
  );
  const denied = await guarded.request("/secrets");
  const allowed = await guarded.request("/secrets", { headers: { "x-api-key": "k123" } });
  const healthOpen = await guarded.request("/health");
  check("API key: 403 without, 200 with, /health open", denied.status === 403 && allowed.status === 200 && healthOpen.status === 200);
}

// 7 storage + key fail-fast
{
  let threw = "";
  try {
    storageFromEnv({ XPS_STORAGE: "bogus" });
  } catch (e) {
    threw = String(e.message || e);
  }
  check("XPS_STORAGE=bogus throws", /unknown XPS_STORAGE/.test(threw), threw.slice(0, 80));

  let keyErr = "";
  try {
    await getKey({ XPS_ENV: "production" });
  } catch (e) {
    keyErr = String(e.message || e);
  }
  check("production without XPS_ENCRYPTION_KEY fails fast", /required in production/.test(keyErr), keyErr.slice(0, 80));
}

await rm(dir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
