import { z } from "zod";

import { IngestionError } from "../../../../../lib/ingest/errors";
import type {
	RepositoryIngestionRequest,
	RepositoryIngestionResult,
} from "../../../../../lib/ingest/types";
import { jsonData, jsonError } from "../../../../../lib/search/http";
import { hasValidBearerSecret } from "../../../../../lib/search/internal-auth";
import { KQL_DIALECTS } from "../../../../../lib/search/types";

const MAX_BODY_BYTES = 64 * 1024;
const MAX_PATH_DIALECTS = 64;
const MAX_SOURCE_PATHS = 10_000;

const repositorySchema = z
	.string()
	.trim()
	.min(3)
	.max(140)
	.regex(
		/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/,
		'Use the GitHub "owner/name" form.',
	)
	.refine((repository) => !repository.endsWith(".git"), {
		message: 'Use the GitHub "owner/name" form without a .git suffix.',
	});

const refSchema = z
	.string()
	.trim()
	.min(1)
	.max(255)
	.refine(isSafeGitRef, {
		message: "The Git ref is invalid.",
	});

const pathPrefixSchema = z
	.string()
	.trim()
	.min(1)
	.max(512)
	.refine(isSafeRepositoryPathPrefix, {
		message: "Path prefixes must be safe repository-relative paths.",
	});

const pathDialectSchema = z
	.object({
		prefix: pathPrefixSchema,
		dialect: z.enum(KQL_DIALECTS),
	})
	.strict();

const ingestionRequestSchema = z
	.object({
		repository: repositorySchema,
		ref: refSchema.optional(),
		defaultDialect: z.enum(KQL_DIALECTS),
		pathDialects: z
			.array(pathDialectSchema)
			.max(MAX_PATH_DIALECTS)
			.refine(hasUniquePathPrefixes, {
				message: "Path dialect prefixes must be unique.",
			})
			.optional(),
		sourcePaths: z
			.array(pathPrefixSchema)
			.max(MAX_SOURCE_PATHS)
			.refine(hasUniqueSourcePaths, {
				message: "Source paths must be unique.",
			})
			.optional(),
		trusted: z.boolean().optional(),
	})
	.strict();

type GithubIngestionInput = z.infer<typeof ingestionRequestSchema>;

export interface GithubIngestionRouteDependencies {
	secret?: string;
	ingest(request: RepositoryIngestionRequest): Promise<RepositoryIngestionResult>;
}

export async function handleGithubIngestionRequest(
	request: Request,
	dependencies: GithubIngestionRouteDependencies,
): Promise<Response> {
	if (request.method.toUpperCase() !== "POST") {
		const response = jsonError(
			405,
			"method_not_allowed",
			"Use POST for this endpoint.",
		);
		response.headers.set("Allow", "POST");
		return response;
	}

	if (!dependencies.secret) {
		return jsonError(
			503,
			"service_unavailable",
			"GitHub ingestion is not configured.",
		);
	}

	const authorized = await hasValidBearerSecret(
		request.headers.get("authorization"),
		dependencies.secret,
	);
	if (!authorized) {
		return jsonError(401, "unauthorized", "Authentication required.");
	}

	try {
		const input = await parseIngestionBody(request);
		const result = await dependencies.ingest({
			...input,
			signal: request.signal,
		});
		return jsonData(result);
	} catch (error) {
		return ingestionErrorResponse(error);
	}
}

async function parseIngestionBody(
	request: Request,
): Promise<GithubIngestionInput> {
	const contentType = request.headers
		.get("content-type")
		?.split(";", 1)[0]
		.trim()
		.toLocaleLowerCase("en-US");
	if (contentType !== "application/json") {
		throw new IngestionRequestError(
			415,
			"unsupported_media_type",
			"Use application/json for the request body.",
		);
	}

	const declaredLength = request.headers.get("content-length");
	if (declaredLength && /^\d+$/.test(declaredLength)) {
		const bytes = Number(declaredLength);
		if (!Number.isSafeInteger(bytes) || bytes > MAX_BODY_BYTES) {
			throw payloadTooLarge();
		}
	}

	const body = await readBoundedBody(request);
	let value: unknown;
	try {
		value = JSON.parse(body);
	} catch {
		throw new IngestionRequestError(
			400,
			"invalid_json",
			"The request body must contain valid JSON.",
		);
	}

	const parsed = ingestionRequestSchema.safeParse(value);
	if (!parsed.success) {
		throw new IngestionRequestError(
			422,
			"validation_error",
			"The request body is invalid.",
			{
				issues: parsed.error.issues.map((issue) => ({
					path: issue.path.join("."),
					code: issue.code,
					message: issue.message,
				})),
			},
		);
	}
	return parsed.data;
}

async function readBoundedBody(request: Request): Promise<string> {
	if (!request.body) {
		return "";
	}

	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let totalBytes = 0;

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			totalBytes += value.byteLength;
			if (totalBytes > MAX_BODY_BYTES) {
				await reader.cancel().catch(() => undefined);
				throw payloadTooLarge();
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}

	const bytes = new Uint8Array(totalBytes);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}

	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		throw new IngestionRequestError(
			400,
			"invalid_json",
			"The request body must contain valid UTF-8 JSON.",
		);
	}
}

function ingestionErrorResponse(error: unknown): Response {
	if (error instanceof IngestionRequestError) {
		return jsonError(error.status, error.code, error.message, error.details);
	}
	if (error instanceof IngestionError) {
		switch (error.code) {
			case "INVALID_REPOSITORY":
				return jsonError(422, "invalid_repository", error.message);
			case "LICENSE_MISSING":
			case "LICENSE_UNKNOWN":
			case "LICENSE_DISALLOWED":
			case "LICENSE_METADATA_MISMATCH":
			case "LICENSE_NOTICE_MISSING":
				return jsonError(
					422,
					"repository_not_eligible",
					error.message,
					{ reason: error.code },
				);
			case "INGESTION_LIMIT_EXCEEDED":
				return jsonError(
					413,
					"ingestion_limit_exceeded",
					error.message,
				);
			case "TREE_TRUNCATED":
			case "GITHUB_HTTP_ERROR":
			case "GITHUB_RESPONSE_INVALID":
				return jsonError(
					502,
					"github_ingestion_failed",
					"GitHub could not provide a complete ingestion source.",
					{ reason: error.code, retryable: true },
				);
		}
	}

	console.error("Unhandled GitHub ingestion API error", error);
	return jsonError(
		503,
		"service_unavailable",
		"GitHub ingestion is temporarily unavailable.",
	);
}

function payloadTooLarge(): IngestionRequestError {
	return new IngestionRequestError(
		413,
		"payload_too_large",
		`The request body must not exceed ${MAX_BODY_BYTES} bytes.`,
	);
}

function isSafeGitRef(ref: string): boolean {
	if (
		/[\u0000-\u0020\u007f~^:?*[\]\\]/u.test(ref) ||
		ref.startsWith("-") ||
		ref.startsWith("/") ||
		ref.endsWith("/") ||
		ref.endsWith(".") ||
		ref.includes("//") ||
		ref.includes("..") ||
		ref.includes("@{")
	) {
		return false;
	}
	return ref
		.split("/")
		.every((segment) => Boolean(segment) && !segment.endsWith(".lock"));
}

function isSafeRepositoryPathPrefix(prefix: string): boolean {
	if (
		prefix.startsWith("/") ||
		prefix.endsWith("/") ||
		prefix.includes("\\") ||
		/[\u0000-\u001f\u007f]/u.test(prefix)
	) {
		return false;
	}
	return prefix
		.split("/")
		.every(
			(segment) => Boolean(segment) && segment !== "." && segment !== "..",
		);
}

function hasUniquePathPrefixes(
	rules: readonly { prefix: string }[],
): boolean {
	const prefixes = new Set<string>();
	for (const rule of rules) {
		const normalized = rule.prefix.toLocaleLowerCase("en-US");
		if (prefixes.has(normalized)) {
			return false;
		}
		prefixes.add(normalized);
	}
	return true;
}

function hasUniqueSourcePaths(paths: readonly string[]): boolean {
	const normalized = paths.map((path) =>
		path.toLocaleLowerCase("en-US"),
	);
	return new Set(normalized).size === normalized.length;
}

class IngestionRequestError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		message: string,
		readonly details?: Record<string, unknown>,
	) {
		super(message);
		this.name = "IngestionRequestError";
	}
}
