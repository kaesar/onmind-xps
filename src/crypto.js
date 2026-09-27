const ALG = "AES-256-GCM";
const HEX64_RE = /^[0-9a-fA-F]{64}$/;

let cachedKey = null;
let cachedRaw = "";

function b64encode(bytes) {
  return Buffer.from(bytes).toString("base64");
}

function b64decode(s) {
  return new Uint8Array(Buffer.from(String(s), "base64"));
}

// Same parsing as SPI XSetupImportService.parseKey: 64-char hex
// (openssl rand -hex 32) or base64 of 32 bytes. Anything else fails loud.
export function parseKey(raw) {
  const trimmed = String(raw || "").trim();
  if (!trimmed) throw new Error("Empty XPS key");
  let bytes;
  if (HEX64_RE.test(trimmed)) {
    bytes = new Uint8Array(Buffer.from(trimmed, "hex"));
  } else {
    try {
      bytes = new Uint8Array(Buffer.from(trimmed, "base64"));
    } catch {
      throw new Error("Invalid XPS key: expected 64-char hex or base64 of 32 bytes");
    }
  }
  if (bytes.length !== 32) {
    throw new Error(`Invalid XPS key length: expected 32 bytes, got ${bytes.length}`);
  }
  return bytes;
}

function ephemeralKey() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  console.warn("[xps] XPS_ENCRYPTION_KEY not set — using ephemeral key (secrets unreadable after restart). Set it with: openssl rand -hex 32");
  return bytes;
}

export async function getKey(env = process.env) {
  const raw = env.XPS_ENCRYPTION_KEY || "";
  const isProd = (env.XPS_ENV || "dev") === "production";
  if (!raw) {
    if (isProd) throw new Error("xps: XPS_ENCRYPTION_KEY is required in production");
    if (!cachedKey || cachedRaw !== "") {
      cachedKey = await crypto.subtle.importKey("raw", ephemeralKey(), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
      cachedRaw = "";
    }
    return cachedKey;
  }
  if (cachedKey && cachedRaw === raw.trim()) return cachedKey;
  const bytes = parseKey(raw);
  cachedKey = await crypto.subtle.importKey("raw", bytes, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
  cachedRaw = raw.trim();
  bytes.fill(0);
  return cachedKey;
}

// Seal bytes|string -> envelope {alg, iv, ct} (base64). iv 12B random.
// ct is raw AES-GCM output (ciphertext || 16B tag), identical to JCE.
export async function seal(input, env = process.env) {
  const key = await getKey(env);
  const plain = typeof input === "string" ? new TextEncoder().encode(input) : input;
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plain));
  return { alg: ALG, iv: b64encode(iv), ct: b64encode(ct) };
}

export async function open(envelope, env = process.env) {
  if (!envelope || envelope.alg !== ALG) throw new Error("Unsupported algorithm (expected AES-256-GCM)");
  const key = await getKey(env);
  const iv = b64decode(envelope.iv);
  const ct = b64decode(envelope.ct);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
  return new Uint8Array(plain);
}

export async function openToString(envelope, env = process.env) {
  return new TextDecoder().decode(await open(envelope, env));
}

export function isEnvelope(v) {
  return !!v && typeof v === "object" && v.alg === ALG && typeof v.iv === "string" && typeof v.ct === "string";
}
