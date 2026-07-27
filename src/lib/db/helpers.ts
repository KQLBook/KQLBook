import type { KqlDialect } from "../search/types";

import { RepositoryError } from "./repository-error";

export type D1Client = Pick<D1Database, "prepare" | "batch">;

export const QUERY_DIALECTS: readonly KqlDialect[] = [
	"sentinel",
	"defender-xdr",
	"azure-data-explorer",
	"azure-resource-graph",
	"intune-device-query",
];

export function clampLimit(limit: number | undefined, fallback = 25): number {
	if (limit === undefined) {
		return fallback;
	}

	if (!Number.isSafeInteger(limit) || limit < 1) {
		throw new RepositoryError(
			400,
			"INVALID_LIMIT",
			"Limit must be a positive integer.",
		);
	}

	return Math.min(limit, 100);
}

export function parseJsonArray(value: string): string[] {
	try {
		const parsed: unknown = JSON.parse(value);
		return Array.isArray(parsed)
			? parsed.filter((item): item is string => typeof item === "string")
			: [];
	} catch {
		return [];
	}
}

export function parseJsonObject(value: string): Record<string, unknown> {
	try {
		const parsed: unknown = JSON.parse(value);
		return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: {};
	} catch {
		return {};
	}
}

export function cleanStringList(
	values: readonly string[] | undefined,
	maxItems: number,
	maxLength = 128,
): string[] {
	if (!values) {
		return [];
	}

	const seen = new Set<string>();
	const cleaned: string[] = [];

	for (const value of values) {
		const item = value.trim().slice(0, maxLength);
		const key = item.toLocaleLowerCase();
		if (!item || seen.has(key)) {
			continue;
		}

		seen.add(key);
		cleaned.push(item);
		if (cleaned.length === maxItems) {
			break;
		}
	}

	return cleaned;
}

export async function hashQueryContent(value: {
	title: string;
	kql: string;
	description: string;
	explanation: string;
	dialect: KqlDialect;
	tables: readonly string[];
	operators: readonly string[];
	tags: readonly string[];
	assumptions: readonly string[];
	validationWarnings: readonly string[];
}): Promise<string> {
	const canonical = JSON.stringify({
		...value,
		title: value.title.trim(),
		kql: value.kql.trim().replace(/\r\n?/g, "\n"),
		description: value.description.trim(),
		explanation: value.explanation.trim(),
		tables: [...value.tables],
		operators: [...value.operators],
		tags: [...value.tags],
		assumptions: [...value.assumptions],
		validationWarnings: [...value.validationWarnings],
	});
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(canonical),
	);

	return Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
}

export function makeListCursor(timestamp: string, id: string): string {
	return encodeURIComponent(`${timestamp}|${id}`);
}

export function readListCursor(
	cursor: string | undefined,
): { timestamp: string; id: string } | null {
	if (!cursor) {
		return null;
	}

	try {
		const decoded = decodeURIComponent(cursor);
		const separator = decoded.lastIndexOf("|");
		if (separator < 1 || separator === decoded.length - 1) {
			throw new Error("missing cursor fields");
		}

		return {
			timestamp: decoded.slice(0, separator),
			id: decoded.slice(separator + 1),
		};
	} catch {
		throw new RepositoryError(
			400,
			"INVALID_CURSOR",
			"The pagination cursor is invalid.",
		);
	}
}

export function makeRankedListCursor(
	starCount: number,
	timestamp: string,
	id: string,
): string {
	return encodeURIComponent(`${starCount}|${timestamp}|${id}`);
}

export function readRankedListCursor(
	cursor: string | undefined,
): { starCount: number; timestamp: string; id: string } | null {
	if (!cursor) {
		return null;
	}

	try {
		const [starCountValue, timestamp, id, ...extra] =
			decodeURIComponent(cursor).split("|");
		const starCount = Number(starCountValue);

		if (
			extra.length > 0 ||
			!Number.isSafeInteger(starCount) ||
			starCount < 0 ||
			!timestamp ||
			!id
		) {
			throw new Error("invalid ranked cursor fields");
		}

		return { starCount, timestamp, id };
	} catch {
		throw new RepositoryError(
			400,
			"INVALID_CURSOR",
			"The pagination cursor is invalid.",
		);
	}
}

export function newId(): string {
	return crypto.randomUUID();
}

export function asBoolean(value: number | boolean): boolean {
	return value === true || value === 1;
}

export function sqliteErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message.toLocaleLowerCase() : "";
}
