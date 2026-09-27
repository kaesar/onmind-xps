import { handle } from "hono/aws-lambda";
import { createApp } from "./app.js";

// AWS Lambda (Node.js 24): handler `src/lambda.handler`.
// Env: XPS_TABLE=xsetup, XPS_STORAGE=dynamodb, XPS_API_KEY (behind API Gateway),
// XPS_ENCRYPTION_KEY (required in production), AWS_REGION. HTTP API only.
const app = createApp(process.env);
export const handler = handle(app);
