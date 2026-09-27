import { nowIso, decodeToken, encodeToken } from "./ids.js";

// DynamoDB backend: single table `xsetup` (pay-per-request).
// pk (S) = PARAM#<name> | SECRET#<name>, data (S) = full JSON,
// flat cols kind/name/version/updatedAt for debug + future begins_with.
function pkFor(kind, name) {
  return `${kind}#${name}`;
}

export function dynamoStore(env = process.env) {
  const table = env.XPS_TABLE || "xsetup";
  const endpoint = env.XPS_DYNAMO_ENDPOINT || undefined;
  const region = env.AWS_REGION || "us-east-1";
  let clientPromise = null;

  async function client() {
    if (!clientPromise) {
      clientPromise = import("@aws-sdk/client-dynamodb").then(
        ({ DynamoDBClient }) => new DynamoDBClient({ region, ...(endpoint ? { endpoint } : {}) })
      );
    }
    return clientPromise;
  }

  async function putEntry(kind, name, obj, version) {
    const { PutItemCommand } = await import("@aws-sdk/client-dynamodb");
    const db = await client();
    await db.send(
      new PutItemCommand({
        TableName: table,
        Item: {
          pk: { S: pkFor(kind, name) },
          kind: { S: kind },
          name: { S: name },
          data: { S: JSON.stringify(obj) },
          version: { N: String(version) },
          updatedAt: { S: obj.updatedAt || nowIso() },
        },
      })
    );
  }

  async function getEntry(kind, name) {
    const { GetItemCommand } = await import("@aws-sdk/client-dynamodb");
    const db = await client();
    const out = await db.send(new GetItemCommand({ TableName: table, Key: { pk: { S: pkFor(kind, name) } } }));
    if (!out.Item?.data?.S) return null;
    try {
      return JSON.parse(out.Item.data.S);
    } catch {
      return null;
    }
  }

  async function deleteEntry(kind, name) {
    const { DeleteItemCommand } = await import("@aws-sdk/client-dynamodb");
    const db = await client();
    const prev = await getEntry(kind, name);
    if (!prev) return false;
    await db.send(new DeleteItemCommand({ TableName: table, Key: { pk: { S: pkFor(kind, name) } } }));
    return true;
  }

  // Paginated scan filtered by kind prefix; token wraps LastEvaluatedKey.
  async function scanByKind(kind, maxResults, nextToken) {
    const { ScanCommand } = await import("@aws-sdk/client-dynamodb");
    const db = await client();
    let ExclusiveStartKey;
    if (nextToken) {
      const t = decodeToken(nextToken);
      if (t && t.lek) ExclusiveStartKey = t.lek;
    }
    const out = await db.send(
      new ScanCommand({
        TableName: table,
        FilterExpression: "begins_with(pk, :p)",
        ExpressionAttributeValues: { ":p": { S: `${kind}#` } },
        Limit: Math.min(maxResults, 100),
        ...(ExclusiveStartKey ? { ExclusiveStartKey } : {}),
      })
    );
    const items = (out.Items ?? [])
      .map((it) => {
        try {
          return JSON.parse(it.data?.S ?? "null");
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => (a.name < b.name ? -1 : 1));
    return {
      items,
      nextToken: out.LastEvaluatedKey ? encodeToken({ lek: out.LastEvaluatedKey }) : null,
    };
  }

  return {
    mode: "dynamodb",
    table,

    async putParam(entry) {
      const prev = await getEntry("PARAM", entry.name);
      const version = (prev?.version || 0) + 1;
      const saved = { ...entry, version, updatedAt: nowIso() };
      await putEntry("PARAM", entry.name, saved, version);
      return saved;
    },
    async getParam(name) {
      return getEntry("PARAM", name);
    },
    async deleteParam(name) {
      return deleteEntry("PARAM", name);
    },
    async listParams(prefix = "/", maxResults = 50, nextToken = "") {
      // Scan then filter by prefix (v1 simple; begins_with(PARAM#prefix) opt later).
      const all = [];
      let token = nextToken;
      do {
        const page = await scanByKind("PARAM", 100, token);
        all.push(...page.items.filter((p) => p.name.startsWith(prefix)));
        token = page.nextToken;
        if (all.length >= maxResults && page.nextToken) {
          return { items: all.slice(0, maxResults), nextToken: page.nextToken };
        }
      } while (token);
      return { items: all.slice(0, maxResults), nextToken: null };
    },

    async createSecret(entry) {
      const prev = await getEntry("SECRET", entry.name);
      if (prev) {
        const e = new Error(`Secret ${entry.name} already exists`);
        e.status = 400;
        throw e;
      }
      const saved = { ...entry, updatedAt: nowIso() };
      await putEntry("SECRET", entry.name, saved, 1);
      return saved;
    },
    async getSecret(name) {
      return getEntry("SECRET", name);
    },
    async putSecret(entry) {
      const saved = { ...entry, updatedAt: nowIso() };
      await putEntry("SECRET", entry.name, saved, Object.keys(entry.versions || {}).length);
      return saved;
    },
    async deleteSecret(name) {
      return deleteEntry("SECRET", name);
    },
    async listSecrets(maxResults = 50, nextToken = "") {
      return scanByKind("SECRET", maxResults, nextToken);
    },
  };
}
