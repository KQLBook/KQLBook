export type KqlSyntaxToken = {
	type:
		| "comment"
		| "constant"
		| "function"
		| "keyword"
		| "number"
		| "operator"
		| "property"
		| "punctuation"
		| "string"
		| "type"
		| "variable";
	start: number;
	end: number;
};

const QUERY_KEYWORDS = new Set([
	"alias",
	"as",
	"asc",
	"by",
	"consume",
	"count",
	"datatable",
	"declare",
	"desc",
	"distinct",
	"evaluate",
	"extend",
	"externaldata",
	"facet",
	"find",
	"fork",
	"from",
	"getschema",
	"invoke",
	"join",
	"kind",
	"let",
	"limit",
	"lookup",
	"materialize",
	"nulls",
	"of",
	"on",
	"order",
	"parse",
	"partition",
	"print",
	"project",
	"range",
	"reduce",
	"render",
	"restrict",
	"sample",
	"scan",
	"search",
	"serialize",
	"set",
	"sort",
	"step",
	"summarize",
	"take",
	"to",
	"top",
	"union",
	"view",
	"where",
	"with",
]);

const HYPHENATED_QUERY_KEYWORDS = [
	"make-series",
	"mv-apply",
	"mv-expand",
	"parse-kv",
	"parse-where",
	"project-away",
	"project-keep",
	"project-rename",
	"project-reorder",
	"sample-distinct",
	"top-hitters",
	"top-nested",
].sort((left, right) => right.length - left.length);

const WORD_OPERATORS = new Set([
	"and",
	"between",
	"contains",
	"contains_cs",
	"endswith",
	"endswith_cs",
	"has",
	"has_all",
	"has_any",
	"has_cs",
	"hasprefix",
	"hasprefix_cs",
	"hassuffix",
	"hassuffix_cs",
	"in",
	"like",
	"matches",
	"not",
	"notbetween",
	"notcontains",
	"notcontains_cs",
	"notendswith",
	"notendswith_cs",
	"notin",
	"notlike",
	"notstartswith",
	"notstartswith_cs",
	"or",
	"regex",
	"startswith",
	"startswith_cs",
]);

const SCALAR_TYPES = new Set([
	"bool",
	"boolean",
	"date",
	"datetime",
	"decimal",
	"double",
	"dynamic",
	"guid",
	"int",
	"long",
	"real",
	"string",
	"time",
	"timespan",
	"typeof",
	"uniqueid",
	"uuid",
]);

const CONSTANTS = new Set([
	"anti",
	"broadcast",
	"false",
	"first",
	"fullouter",
	"inner",
	"innerunique",
	"last",
	"leftanti",
	"leftantisemi",
	"leftouter",
	"leftsemi",
	"null",
	"rightanti",
	"rightantisemi",
	"rightouter",
	"rightsemi",
	"shuffle",
	"true",
]);

const SYMBOL_OPERATORS = [
	"==",
	"!=",
	"<=",
	">=",
	"=~",
	"!~",
	"=>",
	":=",
	"..",
	"&&",
	"||",
	"|",
	"+",
	"-",
	"*",
	"/",
	"%",
	"=",
	"<",
	">",
	"!",
	"~",
	"?",
];

const PUNCTUATION = new Set(["(", ")", "[", "]", "{", "}", ",", ";", ".", ":"]);

const NUMBER_LITERAL =
	/(?:0[xX][0-9a-fA-F]+|(?:\d+\.\d+|\d+|\.\d+)(?:[eE][+-]?\d+)?)(?:(?:microseconds?|milliseconds?|nanoseconds?|seconds?|minutes?|hours?|days?|ticks?)|(?:ns|us|ms|s|m|h|d|[lL]))?/y;

function isWordStart(character: string | undefined): boolean {
	return Boolean(character && /[A-Za-z_]/.test(character));
}

function isWordPart(character: string | undefined): boolean {
	return Boolean(character && /[A-Za-z0-9_]/.test(character));
}

function addToken(
	tokens: KqlSyntaxToken[],
	code: string,
	type: KqlSyntaxToken["type"],
	start: number,
	end: number,
) {
	let segmentStart = start;

	while (segmentStart < end) {
		const nextLineBreak = code.indexOf("\n", segmentStart);
		const segmentEnd =
			nextLineBreak === -1 || nextLineBreak >= end ? end : nextLineBreak;

		if (segmentEnd > segmentStart) {
			const previous = tokens[tokens.length - 1];
			if (
				previous &&
				previous.type === type &&
				previous.end === segmentStart
			) {
				previous.end = segmentEnd;
			} else {
				tokens.push({ type, start: segmentStart, end: segmentEnd });
			}
		}

		if (nextLineBreak === -1 || nextLineBreak >= end) {
			break;
		}
		segmentStart = nextLineBreak + 1;
	}
}

function readStringLiteral(code: string, start: number): number | null {
	if (code.startsWith("```", start)) {
		const closingChord = code.indexOf("```", start + 3);
		return closingChord === -1 ? code.length : closingChord + 3;
	}

	let quoteIndex = start;
	let isVerbatim = false;
	const first = code[start];

	if (first === "@") {
		if (code[start + 1] !== '"' && code[start + 1] !== "'") {
			return null;
		}
		quoteIndex = start + 1;
		isVerbatim = true;
	} else if (first === "h" || first === "H") {
		if (code[start + 1] === "@") {
			if (code[start + 2] !== '"' && code[start + 2] !== "'") {
				return null;
			}
			quoteIndex = start + 2;
			isVerbatim = true;
		} else if (code[start + 1] === '"' || code[start + 1] === "'") {
			quoteIndex = start + 1;
		} else {
			return null;
		}
	} else if (first !== '"' && first !== "'") {
		return null;
	}

	const quote = code[quoteIndex];
	let cursor = quoteIndex + 1;

	while (cursor < code.length) {
		const character = code[cursor];
		if (character === "\n" || character === "\r") {
			return cursor;
		}
		if (character === quote) {
			if (isVerbatim && code[cursor + 1] === quote) {
				cursor += 2;
				continue;
			}
			return cursor + 1;
		}
		if (!isVerbatim && character === "\\") {
			cursor = Math.min(cursor + 2, code.length);
			continue;
		}
		cursor += 1;
	}

	return code.length;
}

function readQuotedIdentifier(code: string, start: number): number | null {
	if (code[start] !== "[" || (code[start + 1] !== '"' && code[start + 1] !== "'")) {
		return null;
	}

	const quote = code[start + 1];
	let cursor = start + 2;

	while (cursor < code.length) {
		if (code[cursor] === "\\") {
			cursor = Math.min(cursor + 2, code.length);
			continue;
		}
		if (code[cursor] === quote) {
			if (code[cursor + 1] === quote) {
				cursor += 2;
				continue;
			}
			return code[cursor + 1] === "]" ? cursor + 2 : null;
		}
		if (code[cursor] === "\n" || code[cursor] === "\r") {
			return null;
		}
		cursor += 1;
	}

	return null;
}

function readHyphenatedKeyword(code: string, start: number): string | null {
	for (const keyword of HYPHENATED_QUERY_KEYWORDS) {
		if (
			code.startsWith(keyword, start) &&
			!isWordPart(code[start + keyword.length])
		) {
			return keyword;
		}
	}
	return null;
}

/**
 * Produces global, non-overlapping token ranges for Astryx CodeBlock.
 *
 * String and comment ranges are identified first so KQL words inside them are
 * never colored as executable syntax. Multi-line strings are split by line to
 * match the CodeBlock custom-tokenizer contract.
 */
export function tokenizeKql(code: string): KqlSyntaxToken[] {
	const tokens: KqlSyntaxToken[] = [];
	let cursor = 0;

	while (cursor < code.length) {
		if (code[cursor] === "/" && code[cursor + 1] === "/") {
			const lineEnd = code.indexOf("\n", cursor + 2);
			const end = lineEnd === -1 ? code.length : lineEnd;
			addToken(tokens, code, "comment", cursor, end);
			cursor = end;
			continue;
		}

		const stringEnd = readStringLiteral(code, cursor);
		if (stringEnd !== null) {
			addToken(tokens, code, "string", cursor, stringEnd);
			cursor = stringEnd;
			continue;
		}

		const identifierEnd = readQuotedIdentifier(code, cursor);
		if (identifierEnd !== null) {
			addToken(tokens, code, "property", cursor, identifierEnd);
			cursor = identifierEnd;
			continue;
		}

		if (isWordStart(code[cursor])) {
			const hyphenatedKeyword = readHyphenatedKeyword(code, cursor);
			if (hyphenatedKeyword) {
				const end = cursor + hyphenatedKeyword.length;
				addToken(tokens, code, "keyword", cursor, end);
				cursor = end;
				continue;
			}

			let end = cursor + 1;
			while (isWordPart(code[end])) {
				end += 1;
			}

			const word = code.slice(cursor, end);
			let type: KqlSyntaxToken["type"] | null = null;

			if (WORD_OPERATORS.has(word)) {
				type = "operator";
			} else if (SCALAR_TYPES.has(word)) {
				type = "type";
			} else if (CONSTANTS.has(word)) {
				type = "constant";
			} else {
				let next = end;
				while (/\s/.test(code[next] ?? "")) {
					next += 1;
				}
				if (code[next] === "(") {
					type = "function";
				} else if (QUERY_KEYWORDS.has(word)) {
					type = "keyword";
				}
			}

			if (type) {
				addToken(tokens, code, type, cursor, end);
			}
			cursor = end;
			continue;
		}

		if (code[cursor] === "$" && isWordStart(code[cursor + 1])) {
			let end = cursor + 2;
			while (isWordPart(code[end])) {
				end += 1;
			}
			addToken(tokens, code, "variable", cursor, end);
			cursor = end;
			continue;
		}

		NUMBER_LITERAL.lastIndex = cursor;
		const numberMatch = NUMBER_LITERAL.exec(code);
		if (numberMatch) {
			const end = cursor + numberMatch[0].length;
			addToken(tokens, code, "number", cursor, end);
			cursor = end;
			continue;
		}

		const symbolOperator = SYMBOL_OPERATORS.find((operator) =>
			code.startsWith(operator, cursor),
		);
		if (symbolOperator) {
			const end = cursor + symbolOperator.length;
			addToken(tokens, code, "operator", cursor, end);
			cursor = end;
			continue;
		}

		if (PUNCTUATION.has(code[cursor])) {
			addToken(tokens, code, "punctuation", cursor, cursor + 1);
		}
		cursor += 1;
	}

	return tokens;
}
