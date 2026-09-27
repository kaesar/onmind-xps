import { jsonStore } from "./jsonStore.js";
import { dynamoStore } from "./dynamoStore.js";

// Mirror of xin/src/storage.js: auto dynamodb when XPS_TABLE is set,
// fail loud on typo (never silently sink prod secrets to local JSON).
export function storageFromEnv(env = process.env) {
  const raw = env.XPS_STORAGE || (env.XPS_TABLE ? "dynamodb" : "json");
  const mode = String(raw).toLowerCase();
  if (mode === "dynamodb") return dynamoStore(env);
  if (mode === "json") return jsonStore(env.XPS_JSON_PATH || "./xsetup.json");
  throw new Error(`xps: unknown XPS_STORAGE=${JSON.stringify(raw)} (use "json" or "dynamodb")`);
}
