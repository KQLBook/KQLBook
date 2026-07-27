import { getCloudflareContext } from "@opennextjs/cloudflare";
import { NextResponse } from "next/server";
import { z, type ZodType } from "zod";

import { AbuseControlError } from "../../../lib/ai/abuse-control";
import { AiServiceError } from "../../../lib/ai/errors";
import { isRepositoryError } from "../../../lib/db/repository-error";
import type { QueryRecord } from "../../../lib/db/types";
import { KqlSyntaxValidationError } from "../../../lib/kql/syntax-validation";
import { KQL_DIALECTS } from "../../../lib/search/types";

const MAX_JSON_BODY_BYTES = 150_000;

export const dialectSchema = z.enum(KQL_DIALECTS);

export const visibilitySchema = z.enum(["private", "public"]);

const tableListSchema = z
  .array(z.string().trim().min(1).max(128))
  .max(64);

const tagListSchema = z
  .array(z.string().trim().min(1).max(64))
  .max(32);

const operatorListSchema = z
  .array(z.string().trim().min(1).max(128))
  .max(64);

const assumptionListSchema = z
  .array(z.string().trim().min(1).max(500))
  .max(32);

export const createQuerySchema = z
  .object({
    title: z.string().trim().min(1).max(180),
    kql: z.string().trim().min(1).max(100_000),
    explanation: z.string().trim().max(20_000).default(""),
    visibility: visibilitySchema.default("private"),
    aiMetadataAcknowledged: z.literal(true),
    confirmedDialect: dialectSchema.optional(),
    turnstileToken: z.string().trim().min(1).max(4_096).optional(),
  })
  .strict();

export const updateQuerySchema = z
  .object({
    title: z.string().trim().min(1).max(180).optional(),
    kql: z.string().trim().min(1).max(100_000).optional(),
    description: z.string().trim().max(10_000).optional(),
    explanation: z.string().trim().max(20_000).optional(),
    dialect: dialectSchema.optional(),
    tables: tableListSchema.optional(),
    operators: operatorListSchema.optional(),
    tags: tagListSchema.optional(),
    assumptions: assumptionListSchema.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: "Provide at least one field to update.",
  });

export const updateVisibilitySchema = z
  .object({
    visibility: visibilitySchema,
  })
  .strict();

export const reportQuerySchema = z
  .object({
    reason: z.enum([
      "spam",
      "malicious-content",
      "copyright",
      "exposed-secret",
      "other",
    ]),
    details: z.string().trim().max(2_000).optional(),
  })
  .strict();

export const unpublishQuerySchema = z
  .object({
    reason: z.string().trim().min(1).max(2_000),
  })
  .strict();

export const queryIdSchema = z.union([
  z.string().uuid(),
  z.string().regex(/^imported_query_[a-f0-9]{32}$/),
]);

export const historyClickSchema = z
  .object({
    queryId: queryIdSchema,
  })
  .strict();

export const listQuerySchema = z.object({
  cursor: z.string().trim().min(1).max(512).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  visibility: visibilitySchema.optional(),
});

export const idSchema = z.string().uuid();

export type RouteContext = {
  params: Promise<{ id: string }>;
};

type ErrorBody = {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
};

export class ApiRouteError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiRouteError";
  }
}

export function getDatabase(): CloudflareEnv["DB"] {
  return getCloudflareContext().env.DB;
}

export async function getRouteId(context: RouteContext): Promise<string> {
  const { id } = await context.params;
  const parsed = queryIdSchema.safeParse(id);

  if (!parsed.success) {
    throw new ApiRouteError(
      400,
      "invalid_query_id",
      "Query ID is invalid.",
    );
  }

  return parsed.data;
}

export async function getHistoryId(context: RouteContext): Promise<string> {
  return getUuidParam(
    context,
    "invalid_history_id",
    "History ID must be a UUID.",
  );
}

async function getUuidParam(
  context: RouteContext,
  code: string,
  message: string,
): Promise<string> {
  const { id } = await context.params;
  const parsed = idSchema.safeParse(id);

  if (!parsed.success) {
    throw new ApiRouteError(400, code, message);
  }

  return parsed.data;
}

export async function parseJson<T>(
  request: Request,
  schema: ZodType<T>,
): Promise<T> {
  const contentType = request.headers.get("content-type");

  if (!contentType?.toLowerCase().startsWith("application/json")) {
    throw new ApiRouteError(
      415,
      "unsupported_media_type",
      "Use application/json for the request body.",
    );
  }

  const declaredLength = Number(request.headers.get("content-length"));
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > MAX_JSON_BODY_BYTES
  ) {
    throw new ApiRouteError(
      413,
      "payload_too_large",
      "The request body is too large.",
    );
  }

  let source: string;
  try {
    source = await request.text();
  } catch {
    throw new ApiRouteError(
      400,
      "invalid_json",
      "The request body must contain valid JSON.",
    );
  }
  if (new TextEncoder().encode(source).byteLength > MAX_JSON_BODY_BYTES) {
    throw new ApiRouteError(
      413,
      "payload_too_large",
      "The request body is too large.",
    );
  }

  let input: unknown;
  try {
    input = JSON.parse(source);
  } catch {
    throw new ApiRouteError(
      400,
      "invalid_json",
      "The request body must contain valid JSON.",
    );
  }

  const parsed = schema.safeParse(input);

  if (!parsed.success) {
    throw new ApiRouteError(
      422,
      "validation_error",
      "The request body is invalid.",
      parsed.error.flatten(),
    );
  }

  return parsed.data;
}

export function requireSameOrigin(request: Request) {
  const requestOrigin = new URL(request.url).origin;
  const origin = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site");

  if (
    (origin !== null && origin !== requestOrigin) ||
    (origin === null && fetchSite === "cross-site")
  ) {
    throw new ApiRouteError(
      403,
      "cross_origin_request",
      "Cross-origin state changes are not allowed.",
    );
  }
}

export function parseListOptions(request: Request) {
  const url = new URL(request.url);
  const parsed = listQuerySchema.safeParse({
    cursor: url.searchParams.get("cursor") ?? undefined,
    limit: url.searchParams.get("limit") ?? undefined,
    visibility: url.searchParams.get("visibility") ?? undefined,
  });

  if (!parsed.success) {
    throw new ApiRouteError(
      422,
      "validation_error",
      "The query parameters are invalid.",
      parsed.error.flatten(),
    );
  }

  return parsed.data;
}

export function apiJson<T>(data: T, status = 200) {
  return NextResponse.json(
    { data },
    {
      status,
      headers: {
        "Cache-Control": "private, no-store",
      },
    },
  );
}

export function publicApiJson<T>(data: T, status = 200) {
  return NextResponse.json(
    { data },
    {
      status,
      headers: {
        "Cache-Control":
          "public, max-age=60, s-maxage=300, stale-while-revalidate=900",
      },
    },
  );
}

export function queryResponse(query: QueryRecord) {
  const version = query.currentVersion;

  return {
    ...query,
    title: version.title,
    kql: version.kql,
    description: version.description,
    explanation: version.explanation,
    dialect: version.dialect,
    tables: version.tables,
    operators: version.operators,
    tags: version.tags,
    assumptions: version.assumptions,
    validationWarnings: version.validationWarnings,
    aiGenerated: version.aiGenerated,
    generationModel: version.generationModel,
    versionNumber: version.versionNumber,
    versionCreatedAt: version.createdAt,
  };
}

export function apiNoContent() {
  return new Response(null, {
    status: 204,
    headers: {
      "Cache-Control": "private, no-store",
    },
  });
}

export function handleApiError(error: unknown): NextResponse<ErrorBody> {
  if (error instanceof ApiRouteError) {
    return errorResponse(
      error.status,
      error.code,
      error.message,
      error.details,
    );
  }

  if (error instanceof KqlSyntaxValidationError) {
    return errorResponse(
      422,
      "invalid_kql",
      "Fix the KQL errors and try again.",
      { diagnostics: error.diagnostics },
    );
  }

  if (isAuthRouteError(error)) {
    return errorResponse(error.status, error.code, error.message);
  }

  if (isRepositoryError(error)) {
    return errorResponse(error.status, error.code, error.message);
  }

  if (error instanceof AiServiceError) {
    return errorResponse(
      error.status,
      `ai_metadata_${error.code}`,
      "AI metadata could not be generated. Your query was not saved. Try again.",
      {
        retryable: error.retryable,
        ...(error.retryAfterSeconds
          ? { retryAfterSeconds: error.retryAfterSeconds }
          : {}),
      },
    );
  }

  if (error instanceof AbuseControlError) {
    return errorResponse(
      error.status,
      `ai_metadata_${error.code}`,
      "AI metadata is temporarily unavailable. Try again shortly.",
      {
        retryable: error.status >= 429,
        challengeRequired: error.challengeRequired,
      },
    );
  }

  console.error("Unhandled API route error", error);
  return errorResponse(
    500,
    "internal_error",
    "The request could not be completed.",
  );
}

function isAuthRouteError(
  error: unknown,
): error is Error & {
  status: 401 | 403;
  code: "AUTH_REQUIRED" | "ADMIN_REQUIRED";
} {
  if (!(error instanceof Error)) {
    return false;
  }

  const candidate = error as Error & {
    status?: unknown;
    code?: unknown;
  };

  return (
    (candidate.status === 401 || candidate.status === 403) &&
    (candidate.code === "AUTH_REQUIRED" ||
      candidate.code === "ADMIN_REQUIRED")
  );
}

function errorResponse(
  status: number,
  code: string,
  message: string,
  details?: unknown,
) {
  return NextResponse.json<ErrorBody>(
    {
      error: {
        code,
        message,
        ...(details === undefined ? {} : { details }),
      },
    },
    {
      status,
      headers: {
        "Cache-Control": "private, no-store",
      },
    },
  );
}
