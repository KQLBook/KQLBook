import { IngestionError } from "./errors";
import type {
	GithubCommit,
	GithubLicenseFile,
	GithubRepository,
	GithubSourcePort,
	GithubTreeEntry,
	GithubTreeEntryType,
} from "./types";

export type FetchLike = (
	input: string | URL | Request,
	init?: RequestInit,
) => Promise<Response>;

export interface GithubHttpClientOptions {
	token?: string;
	fetch?: FetchLike;
	apiBaseUrl?: string;
	userAgent?: string;
}

interface GithubErrorBody {
	message?: string;
	documentation_url?: string;
}

export class GithubHttpClient implements GithubSourcePort {
	private readonly fetchFn: FetchLike;
	private readonly token?: string;
	private readonly apiBaseUrl: string;
	private readonly userAgent: string;

	constructor(options: GithubHttpClientOptions = {}) {
		this.fetchFn = options.fetch ?? fetch;
		this.token = options.token;
		this.apiBaseUrl = normalizeApiBaseUrl(
			options.apiBaseUrl ?? "https://api.github.com",
		);
		this.userAgent = options.userAgent ?? "kqlbook-ingestion";
	}

	async getRepository(
		repository: string,
		signal?: AbortSignal,
	): Promise<GithubRepository> {
		const { owner, name, fullName } = parseRepositoryName(repository);
		const value = await this.requestJson(
			`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`,
			signal,
		);
		const record = asRecord(value, "repository response");
		const ownerRecord = asRecord(record.owner, "repository owner");
		const licenseRecord =
			record.license === null || record.license === undefined
				? null
				: asRecord(record.license, "repository license");

		return {
			fullName: requiredString(record.full_name, "full_name") || fullName,
			owner: requiredString(ownerRecord.login, "owner.login"),
			name: requiredString(record.name, "name"),
			defaultBranch: requiredString(record.default_branch, "default_branch"),
			htmlUrl: requiredHttpsUrl(record.html_url, "html_url"),
			license: licenseRecord
				? {
						spdxId: requiredString(licenseRecord.spdx_id, "license.spdx_id"),
						name: requiredString(licenseRecord.name, "license.name"),
						apiUrl: optionalHttpsUrl(licenseRecord.url, "license.url"),
					}
				: null,
		};
	}

	async getLicenseFile(
		repository: string,
		ref: string,
		signal?: AbortSignal,
	): Promise<GithubLicenseFile> {
		const { owner, name } = parseRepositoryName(repository);
		const value = await this.requestJson(
			`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/license?ref=${encodeURIComponent(ref)}`,
			signal,
		);
		const record = asRecord(value, "license response");
		const license = asRecord(record.license, "license metadata");

		return {
			spdxId: requiredString(license.spdx_id, "license.spdx_id"),
			name: requiredString(license.name, "license.name"),
			path: requiredString(record.path, "path"),
			htmlUrl: requiredHttpsUrl(record.html_url, "html_url"),
			text: decodeBase64(
				requiredString(record.content, "content"),
				requiredString(record.encoding, "encoding"),
			),
		};
	}

	async resolveCommit(
		repository: string,
		ref: string,
		signal?: AbortSignal,
	): Promise<GithubCommit> {
		const { owner, name } = parseRepositoryName(repository);
		const value = await this.requestJson(
			`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/commits/${encodeURIComponent(ref)}`,
			signal,
		);
		const record = asRecord(value, "commit response");
		const author =
			record.author === null || record.author === undefined
				? null
				: asRecord(record.author, "commit author");
		const commit = asRecord(record.commit, "commit details");
		const commitAuthor =
			commit.author === null || commit.author === undefined
				? null
				: asRecord(commit.author, "commit details author");

		return {
			sha: requiredSha(record.sha, "sha"),
			author:
				optionalString(author?.login) ??
				optionalString(commitAuthor?.name) ??
				null,
		};
	}

	async listTree(
		repository: string,
		commitSha: string,
		signal?: AbortSignal,
	): Promise<GithubTreeEntry[]> {
		const { owner, name } = parseRepositoryName(repository);
		const value = await this.requestJson(
			`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/git/trees/${encodeURIComponent(commitSha)}?recursive=1`,
			signal,
		);
		const record = asRecord(value, "tree response");
		if (record.truncated === true) {
			throw new IngestionError(
				"TREE_TRUNCATED",
				`GitHub truncated the recursive tree for ${repository}.`,
				{ repository, commitSha },
			);
		}
		if (!Array.isArray(record.tree)) {
			throw invalidResponse("tree must be an array");
		}

		return record.tree.map((entry, index) => {
			const item = asRecord(entry, `tree[${index}]`);
			return {
				path: requiredString(item.path, `tree[${index}].path`),
				sha: requiredSha(item.sha, `tree[${index}].sha`),
				type: requiredTreeType(item.type, `tree[${index}].type`),
				size:
					typeof item.size === "number" && Number.isSafeInteger(item.size)
						? item.size
						: undefined,
			};
		});
	}

	async getBlobText(
		repository: string,
		blobSha: string,
		signal?: AbortSignal,
	): Promise<string> {
		const { owner, name } = parseRepositoryName(repository);
		const value = await this.requestJson(
			`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/git/blobs/${encodeURIComponent(blobSha)}`,
			signal,
		);
		const record = asRecord(value, "blob response");
		return decodeBase64(
			requiredString(record.content, "content"),
			requiredString(record.encoding, "encoding"),
		);
	}

	async getPathAuthor(
		repository: string,
		path: string,
		commitSha: string,
		signal?: AbortSignal,
	): Promise<string | null> {
		const { owner, name } = parseRepositoryName(repository);
		const value = await this.requestJson(
			`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/commits?sha=${encodeURIComponent(commitSha)}&path=${encodeURIComponent(path)}&per_page=1`,
			signal,
		);
		if (!Array.isArray(value) || value.length === 0) {
			return null;
		}
		const record = asRecord(value[0], "path commit response");
		const author =
			record.author === null || record.author === undefined
				? null
				: asRecord(record.author, "path commit author");
		const commit = asRecord(record.commit, "path commit details");
		const commitAuthor =
			commit.author === null || commit.author === undefined
				? null
				: asRecord(commit.author, "path commit details author");

		return (
			optionalString(author?.login) ??
			optionalString(commitAuthor?.name) ??
			null
		);
	}

	private async requestJson(path: string, signal?: AbortSignal): Promise<unknown> {
		const headers = new Headers({
			Accept: "application/vnd.github+json",
			"User-Agent": this.userAgent,
			"X-GitHub-Api-Version": "2022-11-28",
		});
		if (this.token) {
			headers.set("Authorization", `Bearer ${this.token}`);
		}

		const response = await this.fetchFn(`${this.apiBaseUrl}${path}`, {
			method: "GET",
			headers,
			signal,
		});
		if (!response.ok) {
			let body: GithubErrorBody = {};
			try {
				body = (await response.json()) as GithubErrorBody;
			} catch {
				// Preserve the status even when GitHub returns a non-JSON error.
			}
			throw new IngestionError(
				"GITHUB_HTTP_ERROR",
				`GitHub request failed with HTTP ${response.status}.`,
				{
					status: response.status,
					message: body.message,
					documentationUrl: body.documentation_url,
					rateLimitRemaining: response.headers.get("x-ratelimit-remaining"),
					rateLimitReset: response.headers.get("x-ratelimit-reset"),
				},
			);
		}

		try {
			return await response.json();
		} catch {
			throw invalidResponse("response body is not valid JSON");
		}
	}
}

export function parseRepositoryName(repository: string): {
	owner: string;
	name: string;
	fullName: string;
} {
	const match = repository
		.trim()
		.match(/^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})$/);
	if (!match || match[2].endsWith(".git")) {
		throw new IngestionError(
			"INVALID_REPOSITORY",
			'Repository must use the GitHub "owner/name" form.',
			{ repository },
		);
	}
	return { owner: match[1], name: match[2], fullName: `${match[1]}/${match[2]}` };
}

function normalizeApiBaseUrl(value: string): string {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new IngestionError(
			"INVALID_REPOSITORY",
			"GitHub API base URL is invalid.",
		);
	}
	if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
		throw new IngestionError(
			"INVALID_REPOSITORY",
			"GitHub API base URL must be an HTTPS origin.",
		);
	}
	return url.href.replace(/\/+$/, "");
}

function decodeBase64(content: string, encoding: string): string {
	if (encoding.toLocaleLowerCase("en-US") !== "base64") {
		throw invalidResponse(`unsupported content encoding "${encoding}"`);
	}
	try {
		const binary = atob(content.replace(/\s+/g, ""));
		const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		throw invalidResponse("base64 content is not valid UTF-8");
	}
}

function asRecord(value: unknown, field: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw invalidResponse(`${field} must be an object`);
	}
	return value as Record<string, unknown>;
}

function requiredString(value: unknown, field: string): string {
	if (typeof value !== "string" || !value.trim()) {
		throw invalidResponse(`${field} must be a non-empty string`);
	}
	return value.trim();
}

function optionalString(value: unknown): string | null {
	return typeof value === "string" && value.trim() ? value.trim() : null;
}

function requiredSha(value: unknown, field: string): string {
	const sha = requiredString(value, field);
	if (!/^[0-9a-f]{40,64}$/i.test(sha)) {
		throw invalidResponse(`${field} must be a Git object SHA`);
	}
	return sha.toLocaleLowerCase("en-US");
}

function requiredHttpsUrl(value: unknown, field: string): string {
	const url = optionalHttpsUrl(value, field);
	if (!url) {
		throw invalidResponse(`${field} must be an HTTPS URL`);
	}
	return url;
}

function optionalHttpsUrl(value: unknown, field: string): string | null {
	if (value === null || value === undefined) {
		return null;
	}
	const stringValue = requiredString(value, field);
	try {
		const url = new URL(stringValue);
		if (url.protocol !== "https:") {
			throw new Error("not https");
		}
		return url.href;
	} catch {
		throw invalidResponse(`${field} must be an HTTPS URL`);
	}
}

function requiredTreeType(value: unknown, field: string): GithubTreeEntryType {
	if (value === "blob" || value === "tree" || value === "commit") {
		return value;
	}
	throw invalidResponse(`${field} is unsupported`);
}

function invalidResponse(message: string): IngestionError {
	return new IngestionError(
		"GITHUB_RESPONSE_INVALID",
		`GitHub returned an invalid response: ${message}.`,
	);
}
