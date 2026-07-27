import { KQL_DIALECTS, type KqlDialect, type SearchRequest } from "./types";

const MAX_QUERY_LENGTH = 2_000;
const MAX_FILTER_LENGTH = 120;
const MAX_FILTER_VALUES = 20;
const MAX_CURSOR_LENGTH = 512;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

const DIALECT_ALIASES: Readonly<Record<string, KqlDialect>> = {
	sentinel: "sentinel",
	"log-analytics": "sentinel",
	loganalytics: "sentinel",
	"microsoft-sentinel": "sentinel",
	"defender-xdr": "defender-xdr",
	"advanced-hunting": "defender-xdr",
	"microsoft-defender-xdr": "defender-xdr",
	adx: "azure-data-explorer",
	kusto: "azure-data-explorer",
	"azure-data-explorer": "azure-data-explorer",
	fabric: "azure-data-explorer",
	arg: "azure-resource-graph",
	"resource-graph": "azure-resource-graph",
	"azure-resource-graph": "azure-resource-graph",
	intune: "intune-device-query",
	"device-query": "intune-device-query",
	"intune-device-query": "intune-device-query",
};

export class SearchInputError extends Error {
	readonly code: string;
	readonly field?: string;
	readonly status: number;

	constructor(code: string, message: string, field?: string, status = 422) {
		super(message);
		this.name = "SearchInputError";
		this.code = code;
		this.field = field;
		this.status = status;
	}
}

export function normalizeSearchText(input: string): string {
	return input.normalize("NFKC").replace(/\s+/g, " ").trim();
}

export function comparableSearchText(input: string): string {
	return normalizeSearchText(input)
		.toLocaleLowerCase("en-US")
		.replace(/[^\p{L}\p{N}_]+/gu, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function splitValues(values: readonly string[]): string[] {
	return values.flatMap((value) => value.split(","));
}

function normalizeFilterValues(values: readonly string[], field: string): string[] {
	const unique = new Map<string, string>();

	for (const rawValue of splitValues(values)) {
		const value = normalizeSearchText(rawValue);
		if (!value) {
			continue;
		}
		if (value.length > MAX_FILTER_LENGTH) {
			throw new SearchInputError(
				"filter_too_long",
				`${field} values must be ${MAX_FILTER_LENGTH} characters or fewer.`,
				field,
			);
		}
		const key = value.toLocaleLowerCase("en-US");
		if (!unique.has(key)) {
			unique.set(key, value);
		}
	}

	if (unique.size > MAX_FILTER_VALUES) {
		throw new SearchInputError(
			"too_many_filters",
			`${field} accepts at most ${MAX_FILTER_VALUES} values.`,
			field,
		);
	}

	return [...unique.values()];
}

function normalizeDialects(values: readonly string[]): KqlDialect[] {
	const normalized = normalizeFilterValues(values, "dialects");
	const dialects: KqlDialect[] = [];

	for (const value of normalized) {
		const dialect = DIALECT_ALIASES[value.toLocaleLowerCase("en-US")];
		if (!dialect) {
			throw new SearchInputError(
				"invalid_dialect",
				`Unsupported dialect "${value}". Expected one of: ${KQL_DIALECTS.join(", ")}.`,
				"dialects",
			);
		}
		if (!dialects.includes(dialect)) {
			dialects.push(dialect);
		}
	}

	return dialects;
}

function parseLimit(value: string | null | undefined): number {
	if (value === null || value === undefined || value === "") {
		return DEFAULT_LIMIT;
	}
	if (!/^\d+$/.test(value)) {
		throw new SearchInputError("invalid_limit", "limit must be a whole number.", "limit");
	}
	const limit = Number(value);
	if (limit < 1 || limit > MAX_LIMIT) {
		throw new SearchInputError(
			"invalid_limit",
			`limit must be between 1 and ${MAX_LIMIT}.`,
			"limit",
		);
	}
	return limit;
}

function validateQuery(rawQuery: string | null | undefined): string {
	const query = normalizeSearchText(rawQuery ?? "");
	if (!query) {
		throw new SearchInputError("query_required", "q is required.", "q");
	}
	if (query.length > MAX_QUERY_LENGTH) {
		throw new SearchInputError(
			"query_too_long",
			`q must be ${MAX_QUERY_LENGTH} characters or fewer.`,
			"q",
		);
	}
	return query;
}

function validateCursor(cursor: string | null | undefined): string | undefined {
	if (!cursor) {
		return undefined;
	}
	if (cursor.length > MAX_CURSOR_LENGTH || /[\u0000-\u001f\u007f]/.test(cursor)) {
		throw new SearchInputError("invalid_cursor", "cursor is invalid.", "cursor");
	}
	return cursor;
}

function valuesFor(params: URLSearchParams, singular: string, plural: string): string[] {
	return [...params.getAll(singular), ...params.getAll(plural)];
}

export function parseSearchParams(params: URLSearchParams): SearchRequest {
	return {
		q: validateQuery(params.get("q")),
		dialects: normalizeDialects(valuesFor(params, "dialect", "dialects")),
		tables: normalizeFilterValues(valuesFor(params, "table", "tables"), "tables"),
		operators: normalizeFilterValues(valuesFor(params, "operator", "operators"), "operators"),
		tags: normalizeFilterValues(valuesFor(params, "tag", "tags"), "tags"),
		authors: normalizeFilterValues(valuesFor(params, "author", "authors"), "authors"),
		sources: normalizeFilterValues(valuesFor(params, "source", "sources"), "sources"),
		cursor: validateCursor(params.get("cursor")),
		limit: parseLimit(params.get("limit")),
	};
}

export function parseSearchBody(value: unknown): SearchRequest {
	if (!isRecord(value)) {
		throw new SearchInputError("invalid_body", "Request body must be a JSON object.");
	}

	const stringValues = (field: string): string[] => {
		const input = value[field];
		if (input === undefined || input === null) {
			return [];
		}
		if (!Array.isArray(input) || input.some((item) => typeof item !== "string")) {
			throw new SearchInputError("invalid_filter", `${field} must be an array of strings.`, field);
		}
		return input;
	};

	const rawLimit = value.limit;
	if (
		rawLimit !== undefined &&
		(typeof rawLimit !== "number" || !Number.isSafeInteger(rawLimit))
	) {
		throw new SearchInputError("invalid_limit", "limit must be a whole number.", "limit");
	}

	return {
		q: validateQuery(typeof value.q === "string" ? value.q : null),
		dialects: normalizeDialects(stringValues("dialects")),
		tables: normalizeFilterValues(stringValues("tables"), "tables"),
		operators: normalizeFilterValues(stringValues("operators"), "operators"),
		tags: normalizeFilterValues(stringValues("tags"), "tags"),
		authors: normalizeFilterValues(stringValues("authors"), "authors"),
		sources: normalizeFilterValues(stringValues("sources"), "sources"),
		cursor: validateCursor(typeof value.cursor === "string" ? value.cursor : undefined),
		limit: parseLimit(rawLimit === undefined ? undefined : String(rawLimit)),
	};
}

export function isKqlDialect(value: unknown): value is KqlDialect {
	return typeof value === "string" && (KQL_DIALECTS as readonly string[]).includes(value);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
