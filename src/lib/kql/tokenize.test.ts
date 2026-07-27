import { describe, expect, it } from "vitest";

import { tokenizeKql, type KqlSyntaxToken } from "./tokenize";

function textFor(
	code: string,
	tokens: KqlSyntaxToken[],
	type: KqlSyntaxToken["type"],
) {
	return tokens
		.filter((token) => token.type === type)
		.map((token) => code.slice(token.start, token.end));
}

describe("tokenizeKql", () => {
	it("highlights a representative hunting query", () => {
		const code = `let threshold = 8; // where inside a comment
SigninLogs
| where ResultType != 0 and TimeGenerated > ago(1h)
| summarize Failed = count() by UserPrincipalName`;
		const tokens = tokenizeKql(code);

		expect(textFor(code, tokens, "keyword")).toEqual(
			expect.arrayContaining(["let", "where", "summarize", "by"]),
		);
		expect(textFor(code, tokens, "function")).toEqual(["ago", "count"]);
		expect(textFor(code, tokens, "number")).toEqual(
			expect.arrayContaining(["8", "0", "1h"]),
		);
		expect(textFor(code, tokens, "operator")).toEqual(
			expect.arrayContaining(["=", "|", "!=", "and", ">"]),
		);
		expect(textFor(code, tokens, "comment")).toEqual([
			"// where inside a comment",
		]);
	});

	it("keeps KQL string forms and quoted identifiers intact", () => {
		const code = `print
  regular = "where",
  verbatim = @'C:\\Temp',
  secret = h@"token",
  multiline = \`\`\`
where and 42
\`\`\`,
  escaped = ['where']`;
		const tokens = tokenizeKql(code);

		expect(textFor(code, tokens, "string")).toEqual(
			expect.arrayContaining([
				'"where"',
				"@'C:\\Temp'",
				'h@"token"',
				"```",
				"where and 42",
			]),
		);
		expect(textFor(code, tokens, "property")).toEqual(["['where']"]);
		expect(textFor(code, tokens, "keyword")).toEqual(["print"]);
	});

	it("recognizes types, word operators, hyphenated operators, and functions", () => {
		const code = `let detector = (value:string) { value has "x" };
T
| mv-expand item = Items
| where detector(item) and item in~ ("x", "y")`;
		const tokens = tokenizeKql(code);

		expect(textFor(code, tokens, "type")).toEqual(["string"]);
		expect(textFor(code, tokens, "keyword")).toEqual(
			expect.arrayContaining(["let", "mv-expand", "where"]),
		);
		expect(textFor(code, tokens, "function")).toEqual(["detector"]);
		expect(textFor(code, tokens, "operator")).toEqual(
			expect.arrayContaining(["has", "and", "in~"]),
		);
	});

	it("returns sorted, non-overlapping ranges that do not cross lines", () => {
		const code = `print value = \`\`\`
first line
second line
\`\`\`
// final comment`;
		const tokens = tokenizeKql(code);

		tokens.forEach((token, index) => {
			expect(token.end).toBeGreaterThan(token.start);
			expect(code.slice(token.start, token.end)).not.toContain("\n");
			if (index > 0) {
				expect(token.start).toBeGreaterThanOrEqual(tokens[index - 1].end);
			}
		});
	});
});
