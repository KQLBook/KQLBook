import { AiServiceError } from "../ai/errors";
import { AbuseControlError } from "../ai/abuse-control";
import { SearchServiceError } from "./errors";
import { SearchInputError } from "./normalize";

interface ErrorDetails {
	field?: string;
	retryable?: boolean;
	retryAfterSeconds?: number;
	challengeRequired?: boolean;
	[key: string]: unknown;
}

export function jsonData<T>(data: T, status = 200): Response {
	return Response.json(
		{ data },
		{
			status,
			headers: {
				"Cache-Control": "private, no-store",
				"Content-Type": "application/json",
			},
		},
	);
}

export function jsonError(
	status: number,
	code: string,
	message: string,
	details?: ErrorDetails,
): Response {
	const headers = new Headers({
		"Cache-Control": "private, no-store",
		"Content-Type": "application/json",
	});
	if (details?.retryAfterSeconds) {
		headers.set("Retry-After", String(details.retryAfterSeconds));
	}

	return Response.json(
		{
			error: {
				code,
				message,
				...(details ? { details } : {}),
			},
		},
		{ status, headers },
	);
}

export function apiErrorResponse(error: unknown): Response {
	if (error instanceof SearchInputError) {
		return jsonError(error.status, error.code, error.message, {
			...(error.field ? { field: error.field } : {}),
		});
	}
	if (error instanceof SearchServiceError) {
		return jsonError(error.status, error.code, error.message, {
			retryable: error.recoverable,
		});
	}
	if (error instanceof AiServiceError) {
		return jsonError(error.status, error.code, error.message, {
			retryable: error.retryable,
			...(error.retryAfterSeconds
				? { retryAfterSeconds: error.retryAfterSeconds }
				: {}),
		});
	}
	if (error instanceof AbuseControlError) {
		return jsonError(error.status, error.code, error.message, {
			challengeRequired: error.challengeRequired,
		});
	}

	console.error("Unhandled search API error", error);
	return jsonError(500, "internal_error", "The request could not be completed.");
}

export async function readJsonBody(request: Request): Promise<unknown> {
	const contentType = request.headers.get("content-type")?.toLocaleLowerCase("en-US");
	if (!contentType?.startsWith("application/json")) {
		throw new SearchInputError(
			"unsupported_media_type",
			"Use application/json for the request body.",
			undefined,
			415,
		);
	}
	try {
		return await request.json();
	} catch {
		throw new SearchInputError(
			"invalid_json",
			"The request body must contain valid JSON.",
			undefined,
			400,
		);
	}
}

export function requireSameOrigin(request: Request): void {
	const origin = request.headers.get("origin");
	const fetchSite = request.headers.get("sec-fetch-site");
	if (
		(origin !== null && origin !== new URL(request.url).origin) ||
		(origin === null && fetchSite === "cross-site")
	) {
		throw new SearchInputError(
			"cross_origin_request",
			"Cross-origin state changes are not allowed.",
			undefined,
			403,
		);
	}
}
