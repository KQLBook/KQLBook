import type { KqlDialect } from "../search/types";

const textEncoder = new TextEncoder();

export function normalizeKql(value: string): string {
	const lines = value
		.replace(/^\uFEFF/, "")
		.replace(/\r\n?/g, "\n")
		.split("\n")
		.map((line) => line.replace(/[ \t]+$/g, ""));

	while (lines[0]?.trim() === "") {
		lines.shift();
	}
	while (lines.at(-1)?.trim() === "") {
		lines.pop();
	}

	const compacted: string[] = [];
	let previousBlank = false;
	for (const line of lines) {
		const blank = line.trim() === "";
		if (blank && previousBlank) {
			continue;
		}
		compacted.push(blank ? "" : line);
		previousBlank = blank;
	}

	return compacted.join("\n");
}

export function makeSourceIdentity(
	repository: string,
	path: string,
	blockIndex: number,
): string {
	return `${repository.toLocaleLowerCase("en-US")}:${path}:${blockIndex}`;
}

export async function makeDedupeKey(
	kql: string,
	dialect: KqlDialect,
	sourceIdentity: string,
): Promise<string> {
	return sha256Hex(`${normalizeKql(kql)}\u0000${dialect}\u0000${sourceIdentity}`);
}

export async function makeContentHash(kql: string): Promise<string> {
	return sha256Hex(normalizeKql(kql));
}

export async function stableId(prefix: string, value: string): Promise<string> {
	const digest = await sha256Hex(value);
	return `${prefix}_${digest.slice(0, 32)}`;
}

async function sha256Hex(value: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", textEncoder.encode(value));
	return Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
}

