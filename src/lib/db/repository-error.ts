export class RepositoryError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		message: string,
	) {
		super(message);
		this.name = "RepositoryError";
	}
}

export function isRepositoryError(error: unknown): error is RepositoryError {
	return error instanceof RepositoryError;
}
