import { execFile } from "node:child_process";

import type { GithubHttpClient } from "../../src/lib/ingest/github-http";
import { IngestionError } from "../../src/lib/ingest/errors";
import type {
	GithubCommit,
	GithubLicenseFile,
	GithubRepository,
	GithubSourcePort,
	GithubTreeEntry,
} from "../../src/lib/ingest/types";

const MAX_GIT_OUTPUT_BYTES = 64 * 1024 * 1024;

export async function cloneGithubRepository(
	repository: GithubRepository,
	destination: string,
): Promise<void> {
	await run(
		"git",
		[
			"clone",
			"--depth",
			"1",
			"--no-tags",
			"--single-branch",
			"--branch",
			repository.defaultBranch,
			`https://github.com/${repository.fullName}.git`,
			destination,
		],
		undefined,
		180_000,
	);
}

export class LocalGitGithubSource implements GithubSourcePort {
	constructor(
		private readonly api: GithubHttpClient,
		private readonly repository: GithubRepository,
		private readonly clonePath: string,
	) {}

	async getRepository(repository: string): Promise<GithubRepository> {
		if (
			repository.toLocaleLowerCase("en-US") !==
			this.repository.fullName.toLocaleLowerCase("en-US")
		) {
			throw new IngestionError(
				"INVALID_REPOSITORY",
				`The local clone contains ${this.repository.fullName}, not ${repository}.`,
			);
		}
		return this.repository;
	}

	getLicenseFile(
		repository: string,
		ref: string,
		signal?: AbortSignal,
	): Promise<GithubLicenseFile> {
		return this.api.getLicenseFile(repository, ref, signal);
	}

	async resolveCommit(
		_repository: string,
		ref: string,
	): Promise<GithubCommit> {
		if (ref !== this.repository.defaultBranch) {
			throw new IngestionError(
				"INVALID_REPOSITORY",
				`The local importer resolved ${this.repository.defaultBranch}, not ${ref}.`,
			);
		}
		const sha = (
			await run("git", ["rev-parse", "HEAD"], this.clonePath)
		).trim();
		const author =
			(
				await run(
					"git",
					["show", "-s", "--format=%aN", "HEAD"],
					this.clonePath,
				)
			).trim() || null;
		return { sha, author };
	}

	async listTree(): Promise<GithubTreeEntry[]> {
		const output = await run(
			"git",
			["ls-tree", "-r", "-l", "-z", "HEAD"],
			this.clonePath,
		);
		const entries: GithubTreeEntry[] = [];
		for (const record of output.split("\u0000")) {
			if (!record) {
				continue;
			}
			const separator = record.indexOf("\t");
			if (separator < 0) {
				continue;
			}
			const metadata = record.slice(0, separator).split(/\s+/);
			const path = record.slice(separator + 1);
			const type = metadata[1];
			const size = Number(metadata[3]);
			if (type !== "blob" && type !== "tree" && type !== "commit") {
				continue;
			}
			entries.push({
				path,
				type,
				sha: metadata[2],
				size: Number.isSafeInteger(size) ? size : undefined,
			});
		}
		return entries;
	}

	getBlobText(
		_repository: string,
		blobSha: string,
	): Promise<string> {
		return run(
			"git",
			["cat-file", "blob", blobSha],
			this.clonePath,
		);
	}

	async getPathAuthor(
		_repository: string,
		path: string,
	): Promise<string | null> {
		const author = (
			await run(
				"git",
				["log", "-1", "--format=%aN", "--", path],
				this.clonePath,
			)
		).trim();
		return author || null;
	}
}

function run(
	command: string,
	args: readonly string[],
	cwd?: string,
	timeout = 60_000,
): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(
			command,
			[...args],
			{
				cwd,
				encoding: "utf8",
				maxBuffer: MAX_GIT_OUTPUT_BYTES,
				timeout,
			},
			(error, stdout, stderr) => {
				if (error) {
					const detail = stderr.trim() || error.message;
					reject(new Error(`${command} failed: ${detail}`));
					return;
				}
				resolve(stdout);
			},
		);
	});
}
