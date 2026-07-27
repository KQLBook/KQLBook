import { describe, expect, it } from "vitest";

import {
	KqlSyntaxValidationError,
	assertValidKqlSyntax,
	validateKqlSyntax,
} from "./syntax-validation";

describe("validateKqlSyntax", () => {
	it.each([
		{
			dialect: "sentinel" as const,
			kql: `SecurityEvent
| where EventSourceName == "Microsoft-Windows-Security-Auditing"
| summarize EventCount = count() by EventID
| sort by EventCount desc`,
		},
		{
			dialect: "defender-xdr" as const,
			kql: `DeviceProcessEvents
| where Timestamp > ago(7d)
| where FileName in~ ("powershell.exe", "powershell_ise.exe")
| project Timestamp, DeviceName, FileName, ProcessCommandLine
| top 100 by Timestamp`,
		},
		{
			dialect: "azure-data-explorer" as const,
			kql: `StormEvents
| summarize event_count = count() by State
| sort by event_count desc
| take 10`,
		},
		{
			dialect: "azure-resource-graph" as const,
			kql: `Resources
| distinct type, apiVersion
| where isnotnull(apiVersion)
| order by type asc`,
		},
		{
			dialect: "intune-device-query" as const,
			kql: `Cpu
| where Architecture == "ARM64"`,
		},
	])("accepts representative $dialect KQL", ({ dialect, kql }) => {
		expect(validateKqlSyntax(kql, { dialect })).toEqual({
			valid: true,
			diagnostics: [],
		});
	});

	it("accepts bare sources, preludes, nested queries, comments, and KQL strings", () => {
		const queries = [
			"SigninLogs",
			"table('SigninLogs')",
			`let threshold = 3;
declare query_parameters(account:string = "alice");
set querytrace = true;
let matches = (name:string) {
	SigninLogs
	| where UserPrincipalName == name
};
matches(account)
| join kind=leftouter (
	AuditLogs
	| where TimeGenerated > ago(1d)
) on $left.Id == $right.Id
| where threshold > 0`,
			`// A pipe in this comment is not syntax: | made_up
print
	regular = "a // b",
	verbatim = @'C:\\Temp\\file.txt',
	obfuscated = h@"token",
	multiline = \`\`\`
line one
line two
\`\`\``,
		];

		for (const query of queries) {
			expect(validateKqlSyntax(query).valid, query).toBe(true);
		}
	});

	it.each([
		["empty input", " \n// comment only", "KQL_EMPTY"],
		["Markdown", "```kql\nT | take 1\n```", "KQL_MARKDOWN_NOT_ALLOWED"],
		["JSON", '{"query":"T | take 1"}', "KQL_JSON_NOT_ALLOWED"],
		["SQL", "SELECT * FROM SecurityEvent", "KQL_SQL_NOT_ALLOWED"],
		["shell", "curl https://example.test", "KQL_SHELL_NOT_ALLOWED"],
		["HTML", "<script>alert(1)</script>", "KQL_HTML_NOT_ALLOWED"],
		["placeholder", "YOUR_TABLE | take 1", "KQL_PLACEHOLDER_NOT_ALLOWED"],
		["management command", ".show tables", "KQL_QUERY_REQUIRED"],
		["leading pipe", "| where x == 1", "KS198"],
		["trailing pipe", "T | where x == 1 |", "KS176"],
		["double pipe", "T | | take 1", "KS176"],
		["unknown pipeline operator", "T | made_up x", "KS176"],
		["missing stage argument", "T | where", "KS006"],
		["dangling binary operator", "T | where x ==", "KS006"],
		["bad comma", "T | project x,", "KS006"],
		["bad delimiter", "T | project x=(1 + 2", "KS005"],
		["bad string", 'T | where x == "unterminated', "KS001"],
	])("rejects %s", (_label, kql, code) => {
		const result = validateKqlSyntax(kql);
		expect(result.valid).toBe(false);
		expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
			code,
		);
	});

	it.each([
		"let threshold = 3;",
		"declare query_parameters(account:string);",
		"set querytrace = true;",
	])("rejects declaration-only input: %s", (kql) => {
		expect(validateKqlSyntax(kql).diagnostics[0]?.code).toBe(
			"KQL_RESULT_EXPRESSION_REQUIRED",
		);
	});

	it("does not mistake placeholders inside KQL strings for templates", () => {
		expect(
			validateKqlSyntax(
				`print literal = "\${VALUE}", verbatim = @"{{VALUE}}"`,
			).valid,
		).toBe(true);
	});

	it("applies only documented Azure Resource Graph operator constraints", () => {
		expect(
			validateKqlSyntax(
				`UnknownResourceTable
| join kind=leftouter (AnotherUnknownTable) on id
| mv-expand item = values limit 2000
| project id, item`,
				{ dialect: "azure-resource-graph" },
			).valid,
		).toBe(true);

		const unsupported = validateKqlSyntax(
			"Resources | render table",
			{ dialect: "azure-resource-graph" },
		);
		expect(unsupported.diagnostics[0]?.code).toBe(
			"KQL_DIALECT_OPERATOR_NOT_SUPPORTED",
		);

		expect(
			validateKqlSyntax(
				"Resources | join kind=leftanti (ResourceContainers) on id",
				{ dialect: "azure-resource-graph" },
			).diagnostics[0]?.code,
		).toBe("KQL_ARG_JOIN_KIND_NOT_SUPPORTED");

		expect(
			validateKqlSyntax("Resources | mv-expand item = values limit 2001", {
				dialect: "azure-resource-graph",
			}).diagnostics[0]?.code,
		).toBe("KQL_ARG_MV_EXPAND_LIMIT");
	});

	it("applies the documented generic Intune operator subset", () => {
		expect(
			validateKqlSyntax(
				"UnknownDeviceEntity | where State == 'ready' | project DeviceId",
				{ dialect: "intune-device-query" },
			).valid,
		).toBe(true);

		expect(
			validateKqlSyntax("Device | extend LowerName = tolower(DeviceName)", {
				dialect: "intune-device-query",
			}).diagnostics[0]?.code,
		).toBe("KQL_DIALECT_OPERATOR_NOT_SUPPORTED");

		// Pre-dialect validation checks shared KQL without guessing a target.
		expect(
			validateKqlSyntax("Device | extend LowerName = tolower(DeviceName)")
				.valid,
		).toBe(true);
	});

	it("returns deterministic JSON-safe source locations", () => {
		const result = validateKqlSyntax("T\n| where");
		expect(result.valid).toBe(false);
		expect(result.diagnostics[0]).toEqual({
			code: "KS006",
			message: "Missing expression",
			severity: "error",
			start: 9,
			length: 0,
			line: 2,
			column: 8,
		});
		expect(JSON.parse(JSON.stringify(result))).toEqual(result);
	});

	it("caps parser diagnostics", () => {
		const result = validateKqlSyntax(
			Array.from({ length: 40 }, (_, index) => `word${index}`).join(" "),
		);
		expect(result.valid).toBe(false);
		expect(result.diagnostics).toHaveLength(20);
		expect(result.diagnostics.at(-1)?.code).toBe(
			"KQL_DIAGNOSTICS_TRUNCATED",
		);
	});

	it("rejects oversized input before parsing", () => {
		const result = validateKqlSyntax("T".repeat(100_001));
		expect(result.diagnostics[0]?.code).toBe("KQL_QUERY_TOO_LARGE");
	});

	it("provides an assertion error carrying plain diagnostics", () => {
		expect(() => assertValidKqlSyntax("T | where")).toThrow(
			KqlSyntaxValidationError,
		);
		try {
			assertValidKqlSyntax("T | where");
		} catch (error) {
			expect(error).toBeInstanceOf(KqlSyntaxValidationError);
			expect(
				(error as KqlSyntaxValidationError).diagnostics[0]?.code,
			).toBe("KS006");
		}
	});
});
