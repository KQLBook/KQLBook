import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const temporaryDirectory = await mkdtemp(
	join(tmpdir(), "kqlbook-audit-build-"),
);
const output = join(temporaryDirectory, "audit-corpus-quality.mjs");

try {
	await build({
		entryPoints: [
			fileURLToPath(
				new URL("./audit-corpus-quality.ts", import.meta.url),
			),
		],
		outfile: output,
		bundle: true,
		platform: "node",
		format: "esm",
		target: "node22",
		logLevel: "warning",
	});

	const exitCode = await new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [output, ...process.argv.slice(2)], {
			stdio: "inherit",
			env: {
				...process.env,
				KQL_CORPUS_AUDIT_CLI: "1",
			},
		});
		child.once("error", reject);
		child.once("exit", (code, signal) => {
			if (signal) {
				reject(new Error(`Audit stopped by ${signal}.`));
				return;
			}
			resolve(code ?? 2);
		});
	});
	process.exitCode = exitCode;
} finally {
	await rm(temporaryDirectory, { recursive: true, force: true });
}
