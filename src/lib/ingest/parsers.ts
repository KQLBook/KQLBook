import { normalizeKql } from "./normalize";
import type { ParsedKqlBlock } from "./types";

const MAX_KQL_LENGTH = 100_000;
const MARKDOWN_EXTENSIONS = new Set([".md", ".markdown", ".mdx"]);
const YAML_EXTENSIONS = new Set([".yaml", ".yml"]);
const KQL_FENCE_LANGUAGES = new Set([
	"kql",
	"kusto",
	"kusto-query",
	"kusto-query-language",
	"kustoquerylanguage",
]);
const YAML_QUERY_KEYS = new Set(["query", "querytext", "query_text", "kql"]);
const YAML_RULE_MARKERS = new Set([
	"id",
	"kind",
	"severity",
	"queryfrequency",
	"queryperiod",
	"triggeroperator",
	"triggerthreshold",
	"tactics",
	"relevanttechniques",
	"requireddataconnectors",
]);

export type CandidateFileKind = "standalone-kql" | "markdown" | "yaml";

export interface ParseCandidateOptions {
	/**
	 * Recover KQL-shaped Markdown fences with missing or incorrect language
	 * labels. Use only when paths came from a reviewed source manifest.
	 */
	allowHeuristicFences?: boolean;
}

export function candidateFileKind(path: string): CandidateFileKind | null {
	const extension = extensionOf(path);
	if (extension === ".kql" || extension === ".kusto") {
		return "standalone-kql";
	}
	if (MARKDOWN_EXTENSIONS.has(extension)) {
		return "markdown";
	}
	if (YAML_EXTENSIONS.has(extension)) {
		return "yaml";
	}
	return null;
}

export function parseCandidateFile(
	path: string,
	content: string,
	options: ParseCandidateOptions = {},
): ParsedKqlBlock[] {
	switch (candidateFileKind(path)) {
		case "standalone-kql": {
			const standalone = parseStandaloneKql(path, content);
			return standalone.length > 0
				? standalone
				: parseMarkdownKql(path, content, options);
		}
		case "markdown":
			return parseMarkdownKql(path, content, options);
		case "yaml":
			return parseYamlAnalyticsRules(path, content);
		default:
			return [];
	}
}

export function parseStandaloneKql(
	path: string,
	content: string,
): ParsedKqlBlock[] {
	const standalone = readStandaloneDocument(content);
	const kql = validKql(standalone.kql);
	if (!kql) {
		return [];
	}

	return [
		{
			title: titleFromPath(path),
			kql,
			description: standalone.description,
			author: standalone.author,
			blockIndex: 0,
			kind: "standalone-kql",
		},
	];
}

export function parseMarkdownKql(
	path: string,
	content: string,
	options: ParseCandidateOptions = {},
): ParsedKqlBlock[] {
	const normalized = content.replace(/\r\n?/g, "\n");
	const lines = normalized.split("\n");
	const frontmatter = readMarkdownFrontmatter(lines);
	const blocks: ParsedKqlBlock[] = [];
	let currentHeading = frontmatter.title || titleFromPath(path);
	let paragraph: string[] = [];
	let documentDescription = frontmatter.description;
	let candidateFenceIndex = 0;
	const headingOccurrences = new Map<string, number>();

	for (let index = frontmatter.endLine; index < lines.length; index += 1) {
		const line = lines[index];
		const heading = line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/);
		if (heading) {
			documentDescription = captureDocumentDescription(
				documentDescription,
				currentHeading,
				paragraph,
			);
			currentHeading = cleanMarkdownText(heading[1]) || currentHeading;
			paragraph = [];
			continue;
		}

		const opening = line.match(/^\s{0,3}(`{3,}|~{3,})\s*([^\s`]*)?.*$/);
		if (!opening) {
			if (line.trim()) {
				paragraph.push(cleanMarkdownText(line.trim()));
			} else if (paragraph.length > 0) {
				paragraph = [paragraph.join(" ")];
			}
			continue;
		}

		const marker = opening[1];
		const language = normalizeFenceLanguage(opening[2] ?? "");
		// Identity follows the physical order of fences that can contain KQL.
		// KQL aliases, unlabeled fences, and SQL fences count even when their
		// contents are rejected. Other language examples (JSON, PowerShell,
		// etc.) do not shift query identities.
		const physicalBlockIndex = isCandidateFenceLanguage(language)
			? candidateFenceIndex++
			: null;
		const body: string[] = [];
		let closingIndex = index + 1;
		for (; closingIndex < lines.length; closingIndex += 1) {
			const candidate = lines[closingIndex];
			const closing = candidate.match(
				/^\s{0,3}(`{3,}|~{3,})\s*([^\s`]*)?\s*$/,
			);
			const closingLanguage = normalizeFenceLanguage(
				closing?.[2] ?? "",
			);
			if (
				closing &&
				closing[1][0] === marker[0] &&
				closing[1].length >= marker.length &&
				(!closingLanguage ||
					closingLanguage === language ||
					(KQL_FENCE_LANGUAGES.has(language) &&
						KQL_FENCE_LANGUAGES.has(closingLanguage)))
			) {
				break;
			}
			body.push(candidate);
		}

		const fenced = readFencedKql(body);
		const kql = fenced.kql;
		const isExplicitKql =
			KQL_FENCE_LANGUAGES.has(language) &&
			Boolean(kql && hasKqlSourceShape(kql));
		const isContextualKql =
			!language &&
			isKqlHeading(currentHeading) &&
			Boolean(kql && looksLikeKql(kql));
		const isHeuristicKql =
			options.allowHeuristicFences === true &&
			(!language || language === "sql") &&
			Boolean(kql && looksLikeKql(kql));
		if (
			closingIndex >= lines.length &&
			!(isExplicitKql || isContextualKql || isHeuristicKql)
		) {
			break;
		}

		if (isExplicitKql || isContextualKql || isHeuristicKql) {
			if (kql && physicalBlockIndex !== null) {
				const nearbyDescription = usefulParagraph(paragraph);
				const headingKey = normalizedHeadingKey(currentHeading);
				const headingOccurrence =
					(headingOccurrences.get(headingKey) ?? 0) + 1;
				headingOccurrences.set(headingKey, headingOccurrence);
				blocks.push({
					title:
						headingOccurrence === 1
							? currentHeading
							: `${currentHeading} ${headingOccurrence}`,
					kql,
					description:
						frontmatter.description ||
						(isDescriptionHeading(currentHeading)
							? nearbyDescription
							: "") ||
						documentDescription ||
						fenced.preamble ||
						nearbyDescription,
					author: frontmatter.author,
					dialectHint: dialectFromHeading(currentHeading),
					blockIndex: physicalBlockIndex,
					kind: "markdown-fence",
				});
			}
		}

		index = Math.min(closingIndex, lines.length - 1);
		paragraph = [];
	}

	return blocks;
}

function readStandaloneDocument(content: string): {
	kql: string;
	description: string;
	author: string | null;
} {
	const lines = content
		.replace(/^\uFEFF/, "")
		.replace(/\r\n?/g, "\n")
		.split("\n");
	const queryMarker = lines.findIndex((line) =>
		/^\s*(?:kql\s+)?query\s*:\s*$/i.test(line),
	);
	const preambleEnd = queryMarker >= 0 ? queryMarker : lines.length;
	const descriptionParts: string[] = [];
	let author: string | null = null;

	for (let index = 0; index < preambleEnd; index += 1) {
		const line = lines[index].trim();
		const description = line.match(
			/^(?:\/\/+\s*)?(?:use\s*case|purpose|description)\s*:\s*(.+)$/i,
		);
		if (description) {
			descriptionParts.push(description[1].trim());
			continue;
		}
		const authorMatch = line.match(
			/^(?:\/\/+\s*)?author\s*:\s*(.+)$/i,
		);
		if (authorMatch) {
			author = authorMatch[1].trim() || null;
		}
	}

	if (queryMarker >= 0) {
		return {
			kql: lines.slice(queryMarker + 1).join("\n"),
			description: cleanScalar(descriptionParts.join(" ")),
			author,
		};
	}

	const body = lines.filter((line, index) => {
		if (index >= preambleEnd) {
			return true;
		}
		const trimmed = line.trim();
		if (
			/^(?:use\s*case|purpose|description|author)\s*:/i.test(trimmed)
		) {
			return false;
		}
		return !/^intune\s+device\s+query\s*(?:[-:]\s*)?kql\s*$/i.test(
			trimmed,
		);
	});

	return {
		kql: body.join("\n"),
		description: cleanScalar(descriptionParts.join(" ")),
		author,
	};
}

function readFencedKql(lines: readonly string[]): {
	kql: string | null;
	preamble: string;
} {
	const full = validKql(lines.join("\n"));
	if (full) {
		return { kql: full, preamble: "" };
	}

	for (
		let bodyStart = 1;
		bodyStart < Math.min(lines.length, 8);
		bodyStart += 1
	) {
		const preamble = cleanMarkdownText(lines.slice(0, bodyStart).join(" "));
		if (
			preamble.length < 12 ||
			preamble.length > 600 ||
			hasKqlSourceShape(preamble)
		) {
			continue;
		}
		const kql = validKql(lines.slice(bodyStart).join("\n"));
		if (kql) {
			return { kql, preamble };
		}
	}

	return { kql: null, preamble: "" };
}

export function parseYamlAnalyticsRules(
	path: string,
	content: string,
): ParsedKqlBlock[] {
	const documents = splitYamlDocuments(content);
	const blocks: ParsedKqlBlock[] = [];
	let blockIndex = 0;

	for (const document of documents) {
		const fields = readYamlFields(document);
		const hasRuleMarker = [...fields.keys()].some((key) =>
			YAML_RULE_MARKERS.has(key),
		);
		if (!hasRuleMarker) {
			continue;
		}

		const query = [...fields.entries()].find(([key]) =>
			YAML_QUERY_KEYS.has(key),
		)?.[1];
		const kql = query ? validKql(query) : null;
		if (!kql) {
			continue;
		}

		const title =
			fields.get("name") ||
			fields.get("title") ||
			`${titleFromPath(path)}${documents.length > 1 ? ` ${blockIndex + 1}` : ""}`;
		const author =
			fields.get("author") ||
			fields.get("createdby") ||
			fields.get("created_by") ||
			null;

		blocks.push({
			title: cleanScalar(title).slice(0, 180) || titleFromPath(path),
			kql,
			description: cleanScalar(fields.get("description") ?? ""),
			author: author ? cleanScalar(author) : null,
			blockIndex,
			kind: "yaml-rule",
		});
		blockIndex += 1;
	}

	return blocks;
}

function readMarkdownFrontmatter(lines: readonly string[]): {
	title: string;
	description: string;
	author: string | null;
	endLine: number;
} {
	if (lines[0]?.trim() !== "---") {
		return { title: "", description: "", author: null, endLine: 0 };
	}

	const closing = lines.findIndex(
		(line, index) => index > 0 && line.trim() === "---",
	);
	if (closing < 0) {
		return { title: "", description: "", author: null, endLine: 0 };
	}

	const fields = readYamlFields(lines.slice(1, closing).join("\n"));
	return {
		title: cleanScalar(fields.get("title") ?? ""),
		description: cleanScalar(fields.get("description") ?? ""),
		author: fields.has("author")
			? cleanScalar(fields.get("author") ?? "")
			: null,
		endLine: closing + 1,
	};
}

function splitYamlDocuments(content: string): string[] {
	const normalized = content.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
	const documents: string[] = [];
	let current: string[] = [];

	for (const line of normalized.split("\n")) {
		if (/^---\s*(?:#.*)?$/.test(line) && current.some((value) => value.trim())) {
			documents.push(current.join("\n"));
			current = [];
			continue;
		}
		if (/^\.\.\.\s*(?:#.*)?$/.test(line)) {
			if (current.some((value) => value.trim())) {
				documents.push(current.join("\n"));
			}
			current = [];
			continue;
		}
		current.push(line);
	}

	if (current.some((value) => value.trim())) {
		documents.push(current.join("\n"));
	}
	return documents;
}

function readYamlFields(document: string): Map<string, string> {
	const lines = document.replace(/\r\n?/g, "\n").split("\n");
	const fields = new Map<string, string>();

	for (let index = 0; index < lines.length; index += 1) {
		const match = lines[index].match(
			/^(\s*)([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*?)\s*$/,
		);
		if (!match) {
			continue;
		}

		const indent = match[1].length;
		const key = match[2].toLocaleLowerCase("en-US");
		const rawValue = match[3];
		const block = rawValue.match(/^([>|])([+-]?)(\d+)?\s*(?:#.*)?$/);
		if (block) {
			const consumed = readYamlBlock(lines, index + 1, indent, block[1] === ">");
			fields.set(key, consumed.value);
			index = consumed.endLine - 1;
			continue;
		}

		if (rawValue && !rawValue.startsWith("{") && !rawValue.startsWith("[")) {
			fields.set(key, parseInlineYamlScalar(rawValue));
		}
	}

	return fields;
}

function readYamlBlock(
	lines: readonly string[],
	startLine: number,
	parentIndent: number,
	folded: boolean,
): { value: string; endLine: number } {
	const body: string[] = [];
	let endLine = startLine;
	let contentIndent: number | null = null;

	for (; endLine < lines.length; endLine += 1) {
		const line = lines[endLine];
		if (!line.trim()) {
			body.push("");
			continue;
		}

		const indentation = line.match(/^\s*/)?.[0].length ?? 0;
		if (indentation <= parentIndent) {
			break;
		}
		contentIndent ??= indentation;
		body.push(line.slice(Math.min(contentIndent, indentation)));
	}

	return {
		value: folded ? foldYamlLines(body) : body.join("\n"),
		endLine,
	};
}

function foldYamlLines(lines: readonly string[]): string {
	let output = "";
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index];
		const next = lines[index + 1];
		output += line;
		if (next === undefined) {
			continue;
		}
		output += !line || !next ? "\n" : " ";
	}
	return output;
}

function parseInlineYamlScalar(value: string): string {
	const withoutComment = value.replace(/\s+#.*$/, "").trim();
	if (
		withoutComment.startsWith('"') &&
		withoutComment.endsWith('"')
	) {
		try {
			return JSON.parse(withoutComment) as string;
		} catch {
			return withoutComment.slice(1, -1);
		}
	}
	if (
		withoutComment.startsWith("'") &&
		withoutComment.endsWith("'")
	) {
		return withoutComment.slice(1, -1).replace(/''/g, "'");
	}
	return withoutComment;
}

function validKql(value: string): string | null {
	const kql = normalizeKql(value);
	if (
		!kql ||
		kql.length > MAX_KQL_LENGTH ||
		/^```|```$/.test(kql) ||
		/[\u0000\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(kql) ||
		looksLikeNonKqlShell(kql) ||
		looksLikeNonKqlProse(kql) ||
		findKqlStructuralProblem(kql) !== null ||
		!hasKqlSourceShape(kql)
	) {
		return null;
	}
	return kql;
}

export function findKqlStructuralProblem(value: string): string | null {
	const statements = splitTopLevelKqlStatements(value);
	if (!statements) {
		return "unbalanced string, comment, or delimiter";
	}
	const withoutComments = stripKqlComments(value);
	if (
		/\blet\s+[A-Za-z_][A-Za-z0-9_]*\s*=\s*;/i.test(withoutComments) ||
		/\blet\s+[A-Za-z_][A-Za-z0-9_]*\s*=\s*$/i.test(withoutComments)
	) {
		return "empty let assignment";
	}
	if (/^\s*\/\/+\s*let\s+Function\s*=/im.test(value)) {
		return "function wrapper is commented out";
	}

	const terminal = statements
		.map((statement) => stripKqlComments(statement).trim())
		.filter(Boolean)
		.at(-1);
	if (!terminal) {
		return "query has no terminal result expression";
	}
	if (
		/^(?:alias|declare|let|pattern|restrict|set)\b/i.test(terminal)
	) {
		return "query ends with a declaration instead of a result expression";
	}
	if (/^\|/.test(terminal)) {
		return "terminal pipeline has no tabular input";
	}
	if (/^\.{3}\s*$/.test(terminal)) {
		return "query ends with a placeholder";
	}
	return null;
}

function splitTopLevelKqlStatements(value: string): string[] | null {
	const statements: string[] = [];
	const delimiters: string[] = [];
	let start = 0;
	let quote: "'" | '"' | null = null;
	let verbatimQuote = false;
	let lineComment = false;
	let blockComment = false;

	for (let index = 0; index < value.length; index += 1) {
		const character = value[index];
		const next = value[index + 1];
		if (lineComment) {
			if (character === "\n") {
				lineComment = false;
			}
			continue;
		}
		if (blockComment) {
			if (character === "*" && next === "/") {
				blockComment = false;
				index += 1;
			}
			continue;
		}
		if (quote) {
			if (!verbatimQuote && character === "\\" && next !== undefined) {
				index += 1;
				continue;
			}
			if (character === quote) {
				if (next === quote) {
					index += 1;
				} else {
					quote = null;
					verbatimQuote = false;
				}
			}
			continue;
		}
		if (character === "'" || character === '"') {
			quote = character;
			verbatimQuote = value[index - 1] === "@";
			continue;
		}
		if (character === "/" && next === "/") {
			lineComment = true;
			index += 1;
			continue;
		}
		if (character === "/" && next === "*") {
			blockComment = true;
			index += 1;
			continue;
		}
		if (character === "(" || character === "[" || character === "{") {
			delimiters.push(character);
			continue;
		}
		if (character === ")" || character === "]" || character === "}") {
			const expected =
				character === ")" ? "(" : character === "]" ? "[" : "{";
			if (delimiters.pop() !== expected) {
				return null;
			}
			continue;
		}
		if (character === ";" && delimiters.length === 0) {
			statements.push(value.slice(start, index));
			start = index + 1;
		}
	}

	if (quote || blockComment || delimiters.length > 0) {
		return null;
	}
	statements.push(value.slice(start));
	return statements;
}

function looksLikeNonKqlShell(value: string): boolean {
	const executable = stripKqlComments(value).trimStart();
	return /^(?:set\s+"[^"\r\n]+=[^"\r\n]*"\s*&&\s*(?:cmd(?:\.exe)?\b|[A-Za-z0-9_.-]+\.exe\b)|cmd(?:\.exe)?\s+\/c\b|powershell(?:\.exe)?\s+(?:-|\/)|pwsh(?:\.exe)?\s+(?:-|\/))/iu.test(
		executable,
	);
}

function looksLikeNonKqlProse(value: string): boolean {
	const executable = maskKqlStrings(stripKqlComments(value));
	return (
		/(?:^|[;\n])\s*[A-Za-z][A-Za-z0-9_-]*\s+[A-Za-z][^|;=\n]*[.!?]\s*(?=$|[;\n])/mu.test(
			executable,
		) ||
		/(?:^|[;\n])\s*Between\b[^|;=\n]*[.!?]\s*(?=$|[;\n])/imu.test(
			executable,
		)
	);
}

function maskKqlStrings(value: string): string {
	let output = "";
	let quote: "'" | '"' | null = null;
	let verbatimQuote = false;

	for (let index = 0; index < value.length; index += 1) {
		const character = value[index];
		const next = value[index + 1];
		if (quote) {
			if (!verbatimQuote && character === "\\" && next !== undefined) {
				output += next === "\n" ? " \n" : "  ";
				index += 1;
				continue;
			}
			if (character === quote) {
				if (next === quote) {
					output += "  ";
					index += 1;
				} else {
					quote = null;
					verbatimQuote = false;
					output += " ";
				}
			} else {
				output += character === "\n" ? "\n" : " ";
			}
			continue;
		}
		if (character === "'" || character === '"') {
			quote = character;
			verbatimQuote = value[index - 1] === "@";
			output += " ";
			continue;
		}
		output += character;
	}

	return output;
}

function normalizeFenceLanguage(value: string): string {
	return value
		.trim()
		.replace(/^\{\./, "")
		.replace(/\}$/, "")
		.toLocaleLowerCase("en-US");
}

function isCandidateFenceLanguage(language: string): boolean {
	return (
		!language ||
		language === "sql" ||
		KQL_FENCE_LANGUAGES.has(language)
	);
}

function normalizedHeadingKey(value: string): string {
	return cleanScalar(value).toLocaleLowerCase("en-US");
}

function isKqlHeading(value: string): boolean {
	return /\b(?:advanced hunting|azure data explorer|defender|kql|kusto|query|sentinel|xdr)\b/i.test(
		value,
	);
}

function dialectFromHeading(
	value: string,
): ParsedKqlBlock["dialectHint"] {
	if (/\b(?:azure\s+resource\s+graph|resource\s+graph)\b/i.test(value)) {
		return "azure-resource-graph";
	}
	if (/\b(?:azure\s+data\s+explorer|adx|fabric)\b/i.test(value)) {
		return "azure-data-explorer";
	}
	if (/\bintune\s+device\s+query\b/i.test(value)) {
		return "intune-device-query";
	}
	if (/\b(?:microsoft\s+sentinel|sentinel|log\s+analytics)\b/i.test(value)) {
		return "sentinel";
	}
	if (
		/\b(?:defender(?:\s+xdr|\s+for\s+(?:endpoint|identity|office\s+365))?|advanced\s+hunting|microsoft\s+365\s+defender)\b/i.test(
			value,
		)
	) {
		return "defender-xdr";
	}
	return undefined;
}

function looksLikeKql(value: string): boolean {
	return (
		hasKqlSourceShape(value) &&
		(/\|\s*(?:as|consume|count|distinct|evaluate|extend|find|fork|getschema|invoke|join|lookup|make-series|mv-apply|mv-expand|order|parse|parse-kv|parse-where|partition|project|project-away|project-keep|project-rename|project-reorder|reduce|render|sample|sample-distinct|scan|search|serialize|sort|summarize|take|top|top-hitters|top-nested|union|where)\b/i.test(
			value,
		) ||
			/^\s*(?:\/\/[^\n]*\n\s*)*(?:let|declare|evaluate|externaldata|find|macro-expand|print|range|search|set|union)\b/i.test(
				value,
			))
	);
}

function hasKqlSourceShape(value: string): boolean {
	let withoutLeadingComments = stripKqlComments(value).trimStart();
	while (withoutLeadingComments) {
		if (withoutLeadingComments.startsWith("//")) {
			const newline = withoutLeadingComments.indexOf("\n");
			withoutLeadingComments =
				newline < 0
					? ""
					: withoutLeadingComments.slice(newline + 1).trimStart();
			continue;
		}
		if (withoutLeadingComments.startsWith("/*")) {
			const closing = withoutLeadingComments.indexOf("*/", 2);
			if (closing < 0) {
				return false;
			}
			withoutLeadingComments = withoutLeadingComments
				.slice(closing + 2)
				.trimStart();
			continue;
		}
		break;
	}
	if (!withoutLeadingComments) {
		return false;
	}
	if (
		/^(?:alias|declare|evaluate|externaldata|find|let|macro-expand|print|range|restrict|search|set|union)\b/i.test(
			withoutLeadingComments,
		)
	) {
		return true;
	}
	if (/^\.[A-Za-z-]+\b/.test(withoutLeadingComments)) {
		return true;
	}
	return /^(?:\["[^"\r\n]+"\]|[A-Za-z_][A-Za-z0-9_]*)(?:\s*\([^;\r\n]*\))?(?:\s*(?:\.|\||;|$))/u.test(
		withoutLeadingComments,
	);
}

function stripKqlComments(value: string): string {
	let output = "";
	let index = 0;
	let quote: "'" | '"' | null = null;
	let verbatimQuote = false;

	while (index < value.length) {
		const current = value[index];
		const next = value[index + 1];

		if (quote) {
			output += current;
			if (!verbatimQuote && current === "\\" && next !== undefined) {
				output += next;
				index += 2;
				continue;
			}
			if (current === quote) {
				if (next === quote) {
					output += next;
					index += 2;
					continue;
				}
				quote = null;
				verbatimQuote = false;
			}
			index += 1;
			continue;
		}
		if (current === "'" || current === '"') {
			quote = current;
			verbatimQuote = value[index - 1] === "@";
			output += current;
			index += 1;
			continue;
		}
		if (current === "/" && next === "/") {
			while (index < value.length && value[index] !== "\n") {
				output += " ";
				index += 1;
			}
			continue;
		}
		if (current === "/" && next === "*") {
			output += "  ";
			index += 2;
			while (
				index < value.length &&
				!(value[index] === "*" && value[index + 1] === "/")
			) {
				output += value[index] === "\n" ? "\n" : " ";
				index += 1;
			}
			if (index < value.length) {
				output += "  ";
				index += 2;
			}
			continue;
		}

		output += current;
		index += 1;
	}

	return output;
}

function extensionOf(path: string): string {
	const filename = path.split("/").at(-1) ?? "";
	const dot = filename.lastIndexOf(".");
	return dot < 0 ? "" : filename.slice(dot).toLocaleLowerCase("en-US");
}

function titleFromPath(path: string): string {
	const filename = path.split("/").at(-1) ?? "Untitled query";
	const dot = filename.lastIndexOf(".");
	const stem = dot > 0 ? filename.slice(0, dot) : filename;
	return (
		stem
			.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
			.replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
			.replace(/[_-]+/g, " ")
			.replace(/\s+/g, " ")
			.trim()
			.slice(0, 180) || "Untitled query"
	);
}

function cleanMarkdownText(value: string): string {
	return value
		.replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
		.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
		.replace(/[*_`~]/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

function cleanScalar(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

function usefulParagraph(lines: readonly string[]): string {
	const paragraph = cleanScalar(lines.join(" "));
	if (
		paragraph.length < 12 ||
		/^(?:https?:\/\/|references?\b|source\b)/i.test(paragraph) ||
		/\|\s*:?-{3,}/.test(paragraph) ||
		(paragraph.match(/\|/g) ?? []).length >= 4 ||
		lines.some((line) => /^\s*\|?\s*:?-{3,}/.test(line)) ||
		lines.filter((line) => (line.match(/\|/g) ?? []).length >= 2).length >= 2
	) {
		return "";
	}
	return paragraph;
}

function captureDocumentDescription(
	current: string,
	heading: string,
	lines: readonly string[],
): string {
	const paragraph = usefulParagraph(lines);
	if (!paragraph) {
		return current;
	}
	if (isDescriptionHeading(heading)) {
		return paragraph;
	}
	if (
		current ||
		/^(?:references?|risk|mitre|techniques?|tactics?|query information|sources?)$/i.test(
			heading,
		)
	) {
		return current;
	}
	return paragraph;
}

function isDescriptionHeading(value: string): boolean {
	return /^(?:description|purpose|use\s*case|what\s+it\s+does)$/i.test(
		value.trim(),
	);
}
