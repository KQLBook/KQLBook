import { describe, expect, it } from "vitest";

import {
	applyDialectTableDefaults,
	extractKqlMetadata,
	inferSpecialDialect,
} from "../../src/lib/ingest/metadata";

describe("KQL ingestion metadata", () => {
	it("derives tables and pipe operators without treating let names as tables", () => {
		const metadata = extractKqlMetadata(`let recent = DeviceProcessEvents
| where Timestamp > ago(1h);
recent
| join kind=inner (DeviceInfo | project DeviceId, DeviceName) on DeviceId
| summarize Events=count() by DeviceName
| order by Events desc`);

		expect(metadata.tables).toEqual([
			"DeviceProcessEvents",
			"DeviceInfo",
		]);
		expect(metadata.operators).toEqual([
			"where",
			"join",
			"project",
			"summarize",
			"order by",
		]);
	});

	it("does not extract identifiers from comments or string literals", () => {
		const metadata = extractKqlMetadata(`// FakeTable | where Value == "x"
SigninLogs
| where UserPrincipalName == "AnotherTable"
| take 10`);

		expect(metadata.tables).toEqual(["SigninLogs"]);
		expect(metadata.operators).toEqual(["where", "take"]);
	});

	it("recognizes an Azure Resource Graph table", () => {
		const metadata = extractKqlMetadata(
			"authorizationresources | where type has 'roleAssignments'",
		);
		expect(inferSpecialDialect(metadata, "sentinel")).toBe(
			"azure-resource-graph",
		);
	});

	it("recognizes a Resource Graph table selected through arg()", () => {
		const metadata = extractKqlMetadata(
			'arg("").authorizationresources | take 10',
		);
		expect(metadata.tables).toEqual(["authorizationresources"]);
		expect(inferSpecialDialect(metadata, "sentinel")).toBe(
			"azure-resource-graph",
		);
	});

	it("recognizes parameterized Intune entities as data sources", () => {
		expect(
			extractKqlMetadata(`WindowsEvent('Application', 7d)
| where tostring(EventId) == '1002'`).tables,
		).toEqual(["WindowsEvent"]);
		expect(
			extractKqlMetadata(
				"FileInfo('C:\\\\Windows\\\\*') | take 10",
			).tables,
		).toEqual(["FileInfo"]);
		expect(
			extractKqlMetadata(
				"WindowsRegistry('HKEY_LOCAL_MACHINE\\\\Software\\\\*')",
			).tables,
		).toEqual(["WindowsRegistry"]);
	});

	it("does not treat projected fields or join hints as tables", () => {
		const metadata = extractKqlMetadata(`DeviceInfo
| project DeviceId,
    DeviceName,
    OnboardingStatus
| join hint.remote=left kind=leftouter (
    arg("").DeviceProcessEvents
    | project DeviceId
) on DeviceId
| project DeviceName, AccountDomain`);

		expect(metadata.tables).toEqual([
			"DeviceInfo",
			"DeviceProcessEvents",
		]);
	});

	it("finds sources inside functions, parenthesized expressions, and multiline unions", () => {
		const metadata = extractKqlMetadata(`let readEvents = () {
    DeviceEvents
    | where ActionType == "Example"
};
let recentFiles = materialize(
    DeviceFileEvents
    | where Timestamp > ago(1d)
);
union kind=outer
    DeviceNetworkEvents,
    DeviceProcessEvents
| take 10`);

		expect(metadata.tables).toEqual([
			"DeviceEvents",
			"DeviceFileEvents",
			"DeviceNetworkEvents",
			"DeviceProcessEvents",
		]);
	});

	it("finds a table wrapped in parentheses after union", () => {
		expect(
			extractKqlMetadata(`union
    (
        SigninLogs
    )
| take 10`).tables,
		).toEqual(["SigninLogs"]);
	});

	it("resolves finite literal table arguments passed to a local helper", () => {
		const metadata = extractKqlMetadata(`let aadFunc = (tableName: string, email: string) {
    table(tableName)
    | where UserPrincipalName == email
};
aadFunc("SigninLogs", "person@example.test")
| union aadFunc("AADNonInteractiveUserSignInLogs", "person@example.test")`);

		expect(metadata.tables).toEqual([
			"SigninLogs",
			"AADNonInteractiveUserSignInLogs",
		]);
	});

	it("does not guess a local helper table when any call is dynamic", () => {
		const metadata = extractKqlMetadata(`let aadFunc = (tableName: string) {
    table(tableName)
};
let requestedTable = "SigninLogs";
aadFunc(requestedTable)`);

		expect(metadata.tables).toEqual([]);
	});

	it("applies the implicit Resources table for Azure Resource Graph", () => {
		expect(
			applyDialectTableDefaults(
				{ tables: [], operators: ["where"] },
				"azure-resource-graph",
			).tables,
		).toEqual(["Resources"]);
	});
});
