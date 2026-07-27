import { OperationTimeoutError } from "./errors";

export async function runWithTimeout<T>(
	operation: (signal: AbortSignal) => Promise<T>,
	timeoutMs: number,
	externalSignal?: AbortSignal,
): Promise<T> {
	const controller = new AbortController();

	const onExternalAbort = () => {
		controller.abort(externalSignal?.reason);
	};
	if (externalSignal?.aborted) {
		onExternalAbort();
	} else {
		externalSignal?.addEventListener("abort", onExternalAbort, { once: true });
	}

	let timeout: ReturnType<typeof setTimeout>;
	const timeoutPromise = new Promise<never>((_, reject) => {
		timeout = setTimeout(() => {
			const error = new OperationTimeoutError();
			controller.abort(error);
			reject(error);
		}, timeoutMs);
	});

	try {
		return await Promise.race([
			operation(controller.signal),
			timeoutPromise,
		]);
	} finally {
		clearTimeout(timeout!);
		externalSignal?.removeEventListener("abort", onExternalAbort);
	}
}
