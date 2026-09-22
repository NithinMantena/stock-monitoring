import { mkdirSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { operations } from "../client/operations.ts";
import { CompanySchema } from "../supabase/functions/_shared/model.ts";
import { JobInput } from "../supabase/functions/_shared/job-queue.ts";
const paths: Record<string, any> = {};
for (const op of operations) {
  const schema: any = z.toJSONSchema(op.schema, {
    io: "input",
    unrepresentable: "any",
  });
  delete schema.$schema;
  const keys = [...op.path.matchAll(/\{([^}]+)\}/g)].map((x) => x[1]);
  const parameters: any[] = keys.map((name) => ({
    name,
    in: "path",
    required: true,
    schema: schema.properties[name],
  }));
  const body = structuredClone(schema);
  for (const name of [...keys, "requestKey"]) {
    delete body.properties[name];
    body.required = body.required?.filter((k: string) => k !== name);
  }
  if (op.method === "GET")
    for (const [name, value] of Object.entries(body.properties))
      parameters.push({
        name,
        in: "query",
        required: body.required?.includes(name) || false,
        schema: value,
      });
  else
    parameters.push({
      name: "Idempotency-Key",
      in: "header",
      required: true,
      schema: { type: "string", minLength: 1, maxLength: 200 },
      description:
        "Stable key for one logical write. Same body replays the response; changed body conflicts. Uncertain results must be inspected before another attempt.",
    });
  let requestSchema: any = body;
  if (op.path === "/jobs")
    requestSchema = {
      oneOf: [
        z.toJSONSchema(JobInput, { io: "input" }),
        {
          type: "object",
          required: ["type", "companyIds"],
          properties: {
            type: { const: "news" },
            companyIds: {
              type: "array",
              minItems: 1,
              maxItems: 1000,
              items: { type: "string" },
            },
            label: { type: "string", maxLength: 300 },
            lookbackDays: { enum: [1, 7, 30], default: 7 },
          },
          additionalProperties: false,
        },
      ],
    };
  if (/\/(watch-points|rules|feeds)$/.test(op.path)) {
    requestSchema.properties.id = requestSchema.properties.itemId;
    delete requestSchema.properties.itemId;
    requestSchema.required = requestSchema.required.map((k: string) =>
      k === "itemId" ? "id" : k,
    );
  }
  const entry = {
    operationId: op.name,
    summary: op.description,
    parameters,
    security: [{ bearerAuth: [] }],
    "x-required-scope": op.scope,
    ...(op.method !== "GET"
      ? {
          requestBody: {
            required: true,
            content: { "application/json": { schema: requestSchema } },
          },
        }
      : {}),
    responses: {
      "200": {
        description:
          "Successful result; list endpoints use items, nextCursor, total.",
      },
      "201": { description: "Created record" },
      "202": { description: "Queued job; fetch status separately" },
      "400": { description: "Validation error" },
      "401": { description: "Missing, expired or revoked credential" },
      "403": { description: "Insufficient scope" },
      "409": {
        description:
          "Version conflict, retry-key mismatch, or uncertain write result",
      },
    },
  };
  paths[op.path] ||= {};
  const prior = paths[op.path][op.method.toLowerCase()];
  if (prior && op.path !== "/jobs") {
    prior.requestBody.content["application/json"].schema = {
      anyOf: [
        prior.requestBody.content["application/json"].schema,
        requestSchema,
      ],
    };
    prior.summary += " " + op.description;
    prior["x-required-scope"] =
      "Depends on edited fields: research:write and/or monitoring:write";
  } else if (!prior) paths[op.path][op.method.toLowerCase()] = entry;
}
const admin = {
  security: [{ bearerAuth: [] }],
  "x-required-scope": "admin",
  responses: {
    "200": { description: "Successful owner operation" },
    "403": { description: "Owner session required" },
  },
};
paths["/integrations"] = {
  get: {
    ...admin,
    summary: "List integration metadata; secrets are never returned.",
  },
  post: {
    ...admin,
    summary:
      "Issue a scoped expiring credential. Plaintext is returned once; this endpoint is not replay-cached.",
    requestBody: {
      required: true,
      content: {
        "application/json": {
          schema: {
            type: "object",
            required: ["name", "channel", "scopes", "expiresAt"],
            properties: {
              name: { type: "string" },
              channel: { enum: ["mcp", "openclaw", "integration"] },
              scopes: { type: "array", items: { type: "string" } },
              expiresAt: { type: "string", format: "date-time" },
            },
          },
        },
      },
    },
  },
};
paths["/integrations/{id}/revoke"] = {
  post: {
    ...admin,
    summary: "Revoke one integration immediately.",
    parameters: [
      { name: "id", in: "path", required: true, schema: { type: "string" } },
    ],
  },
};
paths["/changes"] = {
  get: {
    security: [{ bearerAuth: [] }],
    summary: "Small incremental change metadata; no notes or article text",
    parameters: [
      {
        name: "since",
        in: "query",
        schema: { type: "string", format: "date-time" },
      },
    ],
    responses: {
      "200": { description: "items (kind,id,version,updatedAt) and cursor" },
    },
  },
};
paths["/audit"] = {
  get: {
    ...admin,
    summary: "Paginated actor/channel mutation audit metadata.",
    parameters: [
      {
        name: "limit",
        in: "query",
        schema: { type: "integer", minimum: 1, maximum: 100, default: 25 },
      },
      { name: "cursor", in: "query", schema: { type: "string" } },
    ],
  },
};
paths["/jobs/{id}/advance"] = {
  post: {
    ...admin,
    "x-required-scope": "jobs:start and jobs:control",
    summary: "Advance one bounded unit under a server lease.",
    parameters: [
      { name: "id", in: "path", required: true, schema: { type: "string" } },
      {
        name: "Idempotency-Key",
        in: "header",
        required: true,
        schema: { type: "string" },
      },
    ],
  },
};
paths["/restore"] = {
  post: {
    ...admin,
    summary:
      "Restore missing research records; existing IDs are preserved. Owner only; maximum 100 MB and 20,000 records.",
    parameters: [
      {
        name: "Idempotency-Key",
        in: "header",
        required: true,
        schema: { type: "string" },
      },
    ],
    requestBody: {
      required: true,
      content: {
        "application/json": {
          schema: {
            type: "object",
            required: ["format", "version", "records"],
            properties: {
              format: { const: "research-desk" },
              version: { const: 1 },
              records: {
                type: "array",
                maxItems: 20000,
                items: {
                  type: "object",
                  required: ["kind", "id", "data"],
                  properties: {
                    kind: {
                      enum: [
                        "company",
                        "event",
                        "revision",
                        "settings",
                        "import",
                      ],
                    },
                    id: { type: "string", maxLength: 200 },
                    data: { type: "object" },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
};
const spec = {
  openapi: "3.1.0",
  info: {
    title: "Research Desk API",
    version: "1.0.0",
    description:
      "One owner-scoped API for website, MCP and OpenClaw. Never provide a database service key to an integration.",
  },
  servers: [
    { url: "https://tcfricxifanwwzgxgexj.supabase.co/functions/v1/desk/v1" },
  ],
  components: {
    securitySchemes: {
      bearerAuth: {
        type: "http",
        scheme: "bearer",
        description: "Owner Supabase session or scoped smt_ integration token",
      },
    },
    schemas: { Company: z.toJSONSchema(CompanySchema, { io: "input" }) },
  },
  paths,
};
mkdirSync("public", { recursive: true });
writeFileSync("public/openapi.json", JSON.stringify(spec, null, 2) + "\n");
console.log(
  `Generated API contract for ${Object.keys(paths).length} paths and ${operations.length} integration operations.`,
);
