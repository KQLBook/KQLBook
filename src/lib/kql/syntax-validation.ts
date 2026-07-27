import "@kusto/language-service-next/bridge.js";
import "@kusto/language-service-next/Kusto.Language.Bridge.js";

import type { KqlDialect } from "../search/types";

const MAX_QUERY_LENGTH = 100_000;
const MAX_DIAGNOSTICS = 20;
const RESOURCE_GRAPH_OPERATORS = new Set([
	"count",
	"distinct",
	"extend",
	"join",
	"limit",
	"mv-expand",
	"mvexpand",
	"order",
	"parse",
	"project",
	"project-away",
	"sort",
	"summarize",
	"take",
	"top",
	"union",
	"where",
]);
const RESOURCE_GRAPH_JOIN_KINDS = new Set([
	"fullouter",
	"inner",
	"innerunique",
	"leftouter",
]);
const INTUNE_DEVICE_QUERY_OPERATORS = new Set([
	"count",
	"distinct",
	"join",
	"order",
	"project",
	"summarize",
	"take",
	"top",
	"where",
]);

export interface KqlSyntaxValidationOptions {
	dialect?: KqlDialect | null;
}

export interface KqlSyntaxDiagnostic {
	/**
	 * Stable policy code or the Microsoft parser's stable KSxxx code.
	 */
	code: string;
	message: string;
	severity: "error";
	/** Zero-based UTF-16 offset into the submitted query. */
	start: number;
	/** UTF-16 code-unit length. */
	length: number;
	/** One-based source line. */
	line: number;
	/** One-based source column. */
	column: number;
}

export interface KqlSyntaxValidationResult {
	valid: boolean;
	diagnostics: KqlSyntaxDiagnostic[];
}

export class KqlSyntaxValidationError extends Error {
	readonly diagnostics: KqlSyntaxDiagnostic[];

	constructor(diagnostics: readonly KqlSyntaxDiagnostic[]) {
		super(diagnostics[0]?.message ?? "The KQL query is invalid.");
		this.name = "KqlSyntaxValidationError";
		this.diagnostics = diagnostics.map((diagnostic) => ({ ...diagnostic }));
	}
}

type PolicyFailure = {
	code: string;
	message: string;
	start: number;
	length?: number;
};

/**
 * Parses KQL with Microsoft's language service, then applies small admission
 * policies that a syntax parser intentionally does not cover.
 *
 * This validates syntax and query shape. It cannot prove that referenced
 * tables, columns, functions, or data exist in the destination tenant.
 */
export function validateKqlSyntax(
	source: string,
	options: KqlSyntaxValidationOptions = {},
): KqlSyntaxValidationResult {
	const earlyFailure = getEarlyPolicyFailure(source);
	if (earlyFailure) {
		return invalidResult(source, earlyFailure);
	}

	const code = Kusto.Language.KustoCode.Parse(source);
	if (!code) {
		return invalidResult(source, {
			code: "KQL_PARSER_FAILURE",
			message: "The KQL parser could not parse this query.",
			start: 0,
		});
	}

	const syntaxDiagnostics = readList(code.GetSyntaxDiagnostics())
		.map((diagnostic) => fromKustoDiagnostic(source, code, diagnostic))
		.sort(compareDiagnostics);

	if (syntaxDiagnostics.length > 0) {
		return {
			valid: false,
			diagnostics: capDiagnostics(source, syntaxDiagnostics),
		};
	}

	if (code.Kind !== "Query") {
		return invalidResult(source, {
			code: "KQL_QUERY_REQUIRED",
			message:
				"Only read-only KQL queries can be saved; management commands and directives are not allowed.",
			start: firstNonCommentOffset(source),
			length: firstTokenLength(source),
		});
	}

	const root = code.Syntax;
	const statements =
		root instanceof Kusto.Language.Syntax.QueryBlock ? root.Statements : null;
	const statementCount = statements?.Count ?? 0;

	if (statementCount === 0) {
		return invalidResult(source, {
			code: "KQL_EMPTY",
			message: "Enter a KQL query, not only whitespace or comments.",
			start: 0,
		});
	}

	const lastSeparatedStatement = statements?.getItem$1(statementCount - 1);
	const lastStatement = lastSeparatedStatement?.Element;

	if (!(lastStatement instanceof Kusto.Language.Syntax.ExpressionStatement)) {
		const start = lastStatement?.TextStart ?? firstNonCommentOffset(source);
		return invalidResult(source, {
			code: "KQL_RESULT_EXPRESSION_REQUIRED",
			message:
				"The query must end with a result expression after any let, declare, set, or restrict statements.",
			start,
			length: lastStatement?.Width ?? firstTokenLength(source),
		});
	}

	const dialectDiagnostics = getDialectDiagnostics(
		source,
		code,
		options.dialect,
	);
	if (dialectDiagnostics.length > 0) {
		return {
			valid: false,
			diagnostics: capDiagnostics(
				source,
				dialectDiagnostics.sort(compareDiagnostics),
			),
		};
	}

	return { valid: true, diagnostics: [] };
}

export function assertValidKqlSyntax(
	source: string,
	options: KqlSyntaxValidationOptions = {},
): void {
	const result = validateKqlSyntax(source, options);
	if (!result.valid) {
		throw new KqlSyntaxValidationError(result.diagnostics);
	}
}

function getEarlyPolicyFailure(source: string): PolicyFailure | null {
	if (source.length > MAX_QUERY_LENGTH) {
		return {
			code: "KQL_QUERY_TOO_LARGE",
			message: `KQL queries cannot exceed ${MAX_QUERY_LENGTH.toLocaleString("en-US")} characters.`,
			start: MAX_QUERY_LENGTH,
			length: source.length - MAX_QUERY_LENGTH,
		};
	}

	if (!hasNonCommentContent(source)) {
		return {
			code: "KQL_EMPTY",
			message: "Enter a KQL query, not only whitespace or comments.",
			start: 0,
		};
	}

	const control = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/.exec(
		source,
	);
	if (control?.index !== undefined) {
		return {
			code: "KQL_CONTROL_CHARACTER",
			message: "The query contains a control character that KQL source cannot use.",
			start: control.index,
			length: control[0].length,
		};
	}

	const contentStart = firstNonCommentOffset(source);
	const content = source.slice(contentStart);

	if (
		/^```(?:kql|kusto)?(?:\s|$)/i.test(content) ||
		/^(?:#{1,6}|>|[-+*])\s/.test(content)
	) {
		return {
			code: "KQL_MARKDOWN_NOT_ALLOWED",
			message: "Paste the KQL itself without Markdown headings, lists, or code fences.",
			start: contentStart,
			length: Math.max(1, firstLineLength(content)),
		};
	}

	if (looksLikeSql(content)) {
		return {
			code: "KQL_SQL_NOT_ALLOWED",
			message: "This input looks like SQL. Only KQL queries can be saved.",
			start: contentStart,
			length: firstTokenLength(content),
		};
	}

	if (looksLikeShell(content)) {
		return {
			code: "KQL_SHELL_NOT_ALLOWED",
			message: "This input looks like a shell command. Only KQL queries can be saved.",
			start: contentStart,
			length: firstTokenLength(content),
		};
	}

	if (/^[{[]/.test(content)) {
		return {
			code: "KQL_JSON_NOT_ALLOWED",
			message: "This input looks like JSON. Only KQL queries can be saved.",
			start: contentStart,
			length: 1,
		};
	}

	if (/^<(?:!doctype\b|!--|\/?[A-Za-z][A-Za-z0-9:-]*\b)/i.test(content)) {
		return {
			code: "KQL_HTML_NOT_ALLOWED",
			message: "This input looks like HTML. Only KQL queries can be saved.",
			start: contentStart,
			length: Math.max(1, firstTokenLength(content)),
		};
	}

	const masked = maskStringsAndComments(source);
	const placeholder =
		/\$\{[^}\r\n]+\}|\{\{[^}\r\n]+\}\}|\b(?:YOUR|REPLACE|INSERT)[_-]?(?:TABLE|COLUMN|VALUE|QUERY)\b|\b(?:TODO|FIXME|REPLACE_ME)\b/i.exec(
			masked,
		);
	if (placeholder?.index !== undefined) {
		return {
			code: "KQL_PLACEHOLDER_NOT_ALLOWED",
			message: "Replace template placeholders with concrete KQL before saving.",
			start: placeholder.index,
			length: placeholder[0].length,
		};
	}

	return null;
}

function looksLikeSql(content: string): boolean {
	return /^(?:(?:select|with)\b[\s\S]*\b(?:from|select)\b|insert\s+into\b|update\s+\S+\s+set\b|delete\s+from\b|merge\s+into\b|truncate\s+table\b|(?:create|alter|drop)\s+(?:database|table|view|index|schema|procedure)\b)/i.test(
		content,
	);
}

function looksLikeShell(content: string): boolean {
	return /^(?:#!|\$\s+|(?:sudo\s+)?(?:bash|sh|zsh|fish|pwsh|powershell|cmd|curl|wget|ssh|scp|git|kubectl|helm|docker|podman|terraform|ansible|python\d*|node|npm|npx|yarn|pnpm|az|aws|gcloud|echo|cd|ls|rm|chmod|chown|export)\b)/i.test(
		content,
	);
}

function getDialectDiagnostics(
	source: string,
	code: Kusto.Language.KustoCode,
	dialect: KqlDialect | null | undefined,
): KqlSyntaxDiagnostic[] {
	if (
		dialect !== "azure-resource-graph" &&
		dialect !== "intune-device-query"
	) {
		return [];
	}

	const diagnostics: KqlSyntaxDiagnostic[] = [];
	const allowedOperators =
		dialect === "azure-resource-graph"
			? RESOURCE_GRAPH_OPERATORS
			: INTUNE_DEVICE_QUERY_OPERATORS;

	code.Syntax?.WalkNodes((node) => {
		if (node instanceof Kusto.Language.Syntax.QueryOperator) {
			const token = node.GetFirstToken();
			const operator = token?.Text?.toLowerCase() ?? "";
			if (operator && !allowedOperators.has(operator)) {
				diagnostics.push(
					makeDiagnostic(source, {
						code: "KQL_DIALECT_OPERATOR_NOT_SUPPORTED",
						message: `The ${operator} operator is not supported by ${dialectLabel(dialect)}.`,
						start: token?.TextStart ?? node.TextStart,
						length: token?.Width ?? operator.length,
					}),
				);
			}
		}

		if (
			node instanceof Kusto.Language.Syntax.DataTableExpression ||
			node instanceof Kusto.Language.Syntax.ExternalDataExpression
		) {
			const token = node.GetFirstToken();
			const expressionName = token?.Text?.toLowerCase() ?? "this source";
			diagnostics.push(
				makeDiagnostic(source, {
					code: "KQL_DIALECT_OPERATOR_NOT_SUPPORTED",
					message: `The ${expressionName} source is not supported by ${dialectLabel(dialect)}.`,
					start: token?.TextStart ?? node.TextStart,
					length: token?.Width ?? expressionName.length,
				}),
			);
		}

		if (
			dialect === "azure-resource-graph" &&
			node instanceof Kusto.Language.Syntax.JoinOperator
		) {
			addResourceGraphJoinDiagnostics(source, node, diagnostics);
		}

		if (
			dialect === "azure-resource-graph" &&
			node instanceof Kusto.Language.Syntax.MvExpandOperator
		) {
			const rowLimit = node.RowLimitClause?.RowLimit;
			const token = rowLimit?.GetFirstToken();
			const value = Number(token?.Text);
			if (Number.isFinite(value) && value > 2_000) {
				diagnostics.push(
					makeDiagnostic(source, {
						code: "KQL_ARG_MV_EXPAND_LIMIT",
						message:
							"Azure Resource Graph limits mv-expand to 2,000 rows.",
						start: token?.TextStart ?? rowLimit?.TextStart ?? node.TextStart,
						length: token?.Width ?? rowLimit?.Width ?? 0,
					}),
				);
			}
		}
	});

	return diagnostics;
}

function addResourceGraphJoinDiagnostics(
	source: string,
	join: Kusto.Language.Syntax.JoinOperator,
	diagnostics: KqlSyntaxDiagnostic[],
): void {
	const parameters = join.Parameters;
	if (!parameters) {
		return;
	}

	for (let index = 0; index < parameters.Count; index += 1) {
		const parameter = parameters.getItem$1(index);
		const name = parameter.Name?.SimpleName?.toLowerCase();
		const valueToken = parameter.Expression?.GetFirstToken();
		const value = valueToken?.Text?.toLowerCase() ?? "";

		if (
			name === "kind" &&
			value &&
			!RESOURCE_GRAPH_JOIN_KINDS.has(value)
		) {
			diagnostics.push(
				makeDiagnostic(source, {
					code: "KQL_ARG_JOIN_KIND_NOT_SUPPORTED",
					message: `Azure Resource Graph does not support join kind=${value}.`,
					start: valueToken?.TextStart ?? parameter.TextStart,
					length: valueToken?.Width ?? parameter.Width,
				}),
			);
		}

		if (name === "hint.strategy") {
			diagnostics.push(
				makeDiagnostic(source, {
					code: "KQL_ARG_JOIN_STRATEGY_NOT_SUPPORTED",
					message:
						"Azure Resource Graph does not support custom join strategies.",
					start: parameter.TextStart,
					length: parameter.Width,
				}),
			);
		}
	}
}

function dialectLabel(
	dialect: "azure-resource-graph" | "intune-device-query",
): string {
	return dialect === "azure-resource-graph"
		? "Azure Resource Graph"
		: "Intune Device Query";
}

function hasNonCommentContent(source: string): boolean {
	let index = 0;
	while (index < source.length) {
		const character = source[index];
		if (/\s/.test(character)) {
			index += 1;
			continue;
		}
		if (character === "/" && source[index + 1] === "/") {
			const lineEnd = source.indexOf("\n", index + 2);
			index = lineEnd === -1 ? source.length : lineEnd + 1;
			continue;
		}
		return true;
	}
	return false;
}

function firstNonCommentOffset(source: string): number {
	let index = 0;
	while (index < source.length) {
		const character = source[index];
		if (/\s/.test(character)) {
			index += 1;
			continue;
		}
		if (character === "/" && source[index + 1] === "/") {
			const lineEnd = source.indexOf("\n", index + 2);
			index = lineEnd === -1 ? source.length : lineEnd + 1;
			continue;
		}
		return index;
	}
	return 0;
}

function maskStringsAndComments(source: string): string {
	const masked = source.split("");
	let index = 0;

	const blank = (start: number, end: number) => {
		for (let cursor = start; cursor < end; cursor += 1) {
			if (masked[cursor] !== "\n" && masked[cursor] !== "\r") {
				masked[cursor] = " ";
			}
		}
	};

	while (index < source.length) {
		if (source[index] === "/" && source[index + 1] === "/") {
			const end = source.indexOf("\n", index + 2);
			const commentEnd = end === -1 ? source.length : end;
			blank(index, commentEnd);
			index = commentEnd;
			continue;
		}

		let quoteIndex = index;
		let verbatim = false;
		if (
			(source[index] === "h" || source[index] === "H") &&
			source[index + 1] === "@"
		) {
			quoteIndex = index + 2;
			verbatim = true;
		} else if (
			(source[index] === "h" ||
				source[index] === "H" ||
				source[index] === "@") &&
			(source[index + 1] === "'" || source[index + 1] === '"')
		) {
			quoteIndex = index + 1;
			verbatim = source[index] === "@";
		}

		const chord = source.slice(quoteIndex, quoteIndex + 3);
		if (chord === "```" || chord === "~~~") {
			const closing = source.indexOf(chord, quoteIndex + 3);
			const end = closing === -1 ? source.length : closing + 3;
			blank(index, end);
			index = end;
			continue;
		}

		const quote = source[quoteIndex];
		if (quote !== "'" && quote !== '"') {
			index += 1;
			continue;
		}

		let cursor = quoteIndex + 1;
		while (cursor < source.length) {
			if (!verbatim && source[cursor] === "\\") {
				cursor += 2;
				continue;
			}
			if (source[cursor] === quote) {
				if (source[cursor + 1] === quote) {
					cursor += 2;
					continue;
				}
				cursor += 1;
				break;
			}
			cursor += 1;
		}
		blank(index, Math.min(cursor, source.length));
		index = Math.max(cursor, index + 1);
	}

	return masked.join("");
}

function fromKustoDiagnostic(
	source: string,
	code: Kusto.Language.KustoCode,
	diagnostic: Kusto.Language.Diagnostic,
): KqlSyntaxDiagnostic {
	const start = clamp(diagnostic.Start, 0, source.length);
	const length = clamp(diagnostic.Length, 0, source.length - start);
	const lineReference = { v: 1 };
	const columnReference = { v: 1 };
	const located = code.TryGetLineAndOffset(
		start,
		lineReference,
		columnReference,
	);
	const fallback = positionToLineColumn(source, start);

	return {
		code: diagnostic.Code ?? "KQL_SYNTAX_ERROR",
		message:
			diagnostic.Message ??
			diagnostic.Description ??
			"The query contains invalid KQL syntax.",
		severity: "error",
		start,
		length,
		line: located ? lineReference.v : fallback.line,
		column: located ? columnReference.v : fallback.column,
	};
}

function invalidResult(
	source: string,
	failure: PolicyFailure,
): KqlSyntaxValidationResult {
	const start = clamp(failure.start, 0, source.length);
	const location = positionToLineColumn(source, start);
	return {
		valid: false,
		diagnostics: [
			{
				code: failure.code,
				message: failure.message,
				severity: "error",
				start,
				length: clamp(failure.length ?? 0, 0, source.length - start),
				line: location.line,
				column: location.column,
			},
		],
	};
}

function makeDiagnostic(
	source: string,
	failure: PolicyFailure,
): KqlSyntaxDiagnostic {
	const start = clamp(failure.start, 0, source.length);
	const location = positionToLineColumn(source, start);
	return {
		code: failure.code,
		message: failure.message,
		severity: "error",
		start,
		length: clamp(failure.length ?? 0, 0, source.length - start),
		line: location.line,
		column: location.column,
	};
}

function capDiagnostics(
	source: string,
	diagnostics: KqlSyntaxDiagnostic[],
): KqlSyntaxDiagnostic[] {
	if (diagnostics.length <= MAX_DIAGNOSTICS) {
		return diagnostics;
	}

	const location = positionToLineColumn(source, source.length);
	return [
		...diagnostics.slice(0, MAX_DIAGNOSTICS - 1),
		{
			code: "KQL_DIAGNOSTICS_TRUNCATED",
			message: `Only the first ${MAX_DIAGNOSTICS - 1} syntax errors are shown.`,
			severity: "error",
			start: source.length,
			length: 0,
			line: location.line,
			column: location.column,
		},
	];
}

function readList<T>(
	list: System.Collections.Generic.IReadOnlyList$1<T> | null,
): T[] {
	if (!list) {
		return [];
	}

	const values: T[] = [];
	for (let index = 0; index < list.Count; index += 1) {
		values.push(list.getItem(index));
	}
	return values;
}

function compareDiagnostics(
	left: KqlSyntaxDiagnostic,
	right: KqlSyntaxDiagnostic,
): number {
	return (
		left.start - right.start ||
		left.length - right.length ||
		left.code.localeCompare(right.code) ||
		left.message.localeCompare(right.message)
	);
}

function positionToLineColumn(
	source: string,
	position: number,
): { line: number; column: number } {
	let line = 1;
	let column = 1;
	const end = clamp(position, 0, source.length);

	for (let index = 0; index < end; index += 1) {
		if (source[index] === "\n") {
			line += 1;
			column = 1;
		} else {
			column += 1;
		}
	}

	return { line, column };
}

function firstTokenLength(source: string): number {
	return source.match(/^\S+/)?.[0].length ?? 0;
}

function firstLineLength(source: string): number {
	const lineEnd = source.search(/[\r\n]/);
	return lineEnd === -1 ? source.length : lineEnd;
}

function clamp(value: number, minimum: number, maximum: number): number {
	if (!Number.isFinite(value)) {
		return minimum;
	}
	return Math.min(maximum, Math.max(minimum, value));
}
