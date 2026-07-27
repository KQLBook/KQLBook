export class SearchServiceError extends Error {
	readonly code: string;
	readonly status: number;
	readonly recoverable: boolean;

	constructor(
		code: string,
		message: string,
		options: { status?: number; recoverable?: boolean; cause?: unknown } = {},
	) {
		super(message, { cause: options.cause });
		this.name = "SearchServiceError";
		this.code = code;
		this.status = options.status ?? 503;
		this.recoverable = options.recoverable ?? true;
	}
}

