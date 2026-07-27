import { tokenizeKql } from "../../lib/kql/tokenize";
import type { QueryRecord } from "./sample-data";

type TableSummaryQuery = Pick<QueryRecord, "kql" | "operators" | "tables">;

const ALL_SCOPE_OPERATORS = new Set(["find", "search"]);

function maskCommentsAndStrings(kql: string): string {
	const characters = kql.split("");

	for (const token of tokenizeKql(kql)) {
		if (token.type !== "comment" && token.type !== "string") {
			continue;
		}
		for (let index = token.start; index < token.end; index += 1) {
			if (characters[index] !== "\n" && characters[index] !== "\r") {
				characters[index] = " ";
			}
		}
	}

	return characters.join("");
}

function hasUnscopedSearchOrFind(query: TableSummaryQuery): boolean {
	const operatorIsKnown = query.operators.some((operator) =>
		ALL_SCOPE_OPERATORS.has(operator.trim().toLocaleLowerCase("en-US")),
	);
	const searchableKql = maskCommentsAndStrings(query.kql);
	const unscopedCommand =
		/(?:^|[;|])\s*(?:let\s+[A-Za-z_][A-Za-z0-9_]*\s*=\s*)?(search|find)\b(?!\s+(?:(?:kind|withsource)\s*=\s*[A-Za-z_][A-Za-z0-9_]*\s+)*in\s*\()/gim;

	if (unscopedCommand.test(searchableKql)) {
		return true;
	}

	if (!operatorIsKnown) {
		return false;
	}

	const scopedCommand =
		/\b(?:search|find)\b\s+(?:(?:kind|withsource)\s*=\s*[A-Za-z_][A-Za-z0-9_]*\s+)*in\s*\(/im;
	return !scopedCommand.test(searchableKql);
}

function hasAllTableUnion(kql: string): boolean {
	const searchableKql = maskCommentsAndStrings(kql);
	return /\bunion\b(?:(?:\s+(?:kind|isfuzzy|withsource)\s*=\s*[^\s,|]+)*)\s+\*/im.test(
		searchableKql,
	);
}

function hasDynamicTableSelection(kql: string): boolean {
	const searchableKql = maskCommentsAndStrings(kql);
	return /\btable\s*\(\s*[A-Za-z_][A-Za-z0-9_]*\s*\)/im.test(
		searchableKql,
	);
}

export function queryTableSummary(query: TableSummaryQuery): string {
	if (query.tables.length > 0) {
		return query.tables.join(", ");
	}
	if (hasUnscopedSearchOrFind(query) || hasAllTableUnion(query.kql)) {
		return "All tables in the current scope";
	}
	if (hasDynamicTableSelection(query.kql)) {
		return "Table name selected at runtime";
	}
	return "No physical table referenced";
}
