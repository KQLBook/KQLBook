export type AiErrorCode =
	| "configuration_error"
	| "timeout"
	| "rate_limited"
	| "credits_exhausted"
	| "content_blocked"
	| "service_unavailable"
	| "invalid_response"
	| "upstream_error";

export class AiServiceError extends Error {
	readonly code: AiErrorCode;
	readonly status: number;
	readonly retryable: boolean;
	readonly retryAfterSeconds?: number;

	constructor(
		code: AiErrorCode,
		message: string,
		options: {
			status?: number;
			retryable?: boolean;
			retryAfterSeconds?: number;
			cause?: unknown;
		} = {},
	) {
		super(message, { cause: options.cause });
		this.name = "AiServiceError";
		this.code = code;
		this.status = options.status ?? 503;
		this.retryable = options.retryable ?? false;
		this.retryAfterSeconds = options.retryAfterSeconds;
	}
}

export class OperationTimeoutError extends Error {
	constructor(message = "The operation timed out.") {
		super(message);
		this.name = "OperationTimeoutError";
	}
}

