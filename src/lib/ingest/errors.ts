export type IngestionErrorCode =
	| "INVALID_REPOSITORY"
	| "LICENSE_MISSING"
	| "LICENSE_UNKNOWN"
	| "LICENSE_DISALLOWED"
	| "LICENSE_METADATA_MISMATCH"
	| "LICENSE_NOTICE_MISSING"
	| "TREE_TRUNCATED"
	| "GITHUB_HTTP_ERROR"
	| "GITHUB_RESPONSE_INVALID"
	| "INGESTION_LIMIT_EXCEEDED";

export class IngestionError extends Error {
	readonly code: IngestionErrorCode;
	readonly details: Record<string, unknown>;

	constructor(
		code: IngestionErrorCode,
		message: string,
		details: Record<string, unknown> = {},
	) {
		super(message);
		this.name = "IngestionError";
		this.code = code;
		this.details = details;
	}
}

