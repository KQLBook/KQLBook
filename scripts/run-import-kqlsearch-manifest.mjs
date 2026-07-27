import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const temporaryDirectory = await mkdtemp(
	join(tmpdir(), "kqlbook-import-build-"),
);
const output = join(temporaryDirectory, "import-kqlsearch-manifest.mjs");

try {
	await build({
		entryPoints: [
			fileURLToPath(
				new URL("./import-kqlsearch-manifest.ts", import.meta.url),
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
			env: process.env,
		});
		child.once("error", reject);
		child.once("exit", (code, signal) => {
			if (signal) {
				reject(new Error(`Importer stopped by ${signal}.`));
				return;
			}
			resolve(code ?? 1);
		});
	});
	process.exitCode = exitCode;
} finally {
	await rm(temporaryDirectory, { recursive: true, force: true });
}
