import { describe, expect, it } from "vitest";

import {
	disambiguateSourceTitle,
	enrichQueryMetadata,
	isGenericQueryTitle,
} from "../../src/lib/ingest/enrichment";
import { extractKqlMetadata } from "../../src/lib/ingest/metadata";

describe("query metadata enrichment", () => {
	it("replaces a product-only heading with a purpose-bearing source title", () => {
		const kql = `AADSignInEventsBeta
| where AccountDisplayName == "Emergency Admin"`;
		const enriched = enrichQueryMetadata({
			path: "Azure Active Directory/MonitorCloudBreakGlassAccount.md",
			title: "Defender XDR",
			kql,
			description: "",
			dialect: "defender-xdr",
			metadata: extractKqlMetadata(kql),
		});

		expect(enriched.title).toBe(
			"Monitor Cloud Break Glass Account - Defender XDR",
		);
		expect(enriched.description).toContain("AADSignInEventsBeta");
		expect(enriched.tags).toEqual(
			expect.arrayContaining([
				"defender-xdr",
				"aad-sign-in-events-beta",
				"authentication",
			]),
		);
	});

	it("derives useful Intune tags from the query and supplied use case", () => {
		const kql = `WindowsEvent('Application', 7d)
| where tostring(EventId) == '1002'`;
		const enriched = enrichQueryMetadata({
			path: "WindowsEvent/Show Application Hangs.kql",
			title: "Show Application Hangs",
			kql,
			description:
				"Monitoring application hang events in Windows systems over the past 7 days.",
			dialect: "intune-device-query",
			metadata: extractKqlMetadata(kql),
		});

		expect(enriched.description).toBe(
			"Monitoring application hang events in Windows systems over the past 7 days.",
		);
		expect(enriched.tags).toEqual(
			expect.arrayContaining([
				"intune",
				"windows-event",
				"application-hang",
				"event-id-1002",
				"single-device",
			]),
		);
	});

	it("uses a labeled KQL comment when source prose is unavailable", () => {
		const kql = `// Description: Finds unsigned drivers on the device.
WindowsDriver
| where Signed != true`;
		const enriched = enrichQueryMetadata({
			path: "WindowsDriver/Unsigned Drivers.kql",
			title: "Unsigned Drivers",
			kql,
			description: "",
			dialect: "intune-device-query",
			metadata: extractKqlMetadata(kql),
		});

		expect(enriched.description).toBe(
			"Finds unsigned drivers on the device.",
		);
	});

	it("recognizes product-only and combined product headings", () => {
		for (const title of [
			"Microsoft Defender",
			"Microsoft Defender XDR",
			"Microsoft 365 Defender",
			"Sentinel 2",
			"Microsoft Sentinel / 365 Defender 3",
			"Microsoft Sentinel + Defender XDR #5",
			"Microsoft Defender for Endpoint 7",
			"Microsoft Sentinel Query",
			"Microsoft XDR",
			"Defender 365 2",
			"Resource Graph 2",
			"Resources 8",
			"Description",
			"3. The KQL Query",
			"Update the Query",
			"Query",
			"Query #5",
			"References",
			"Log Analytics (Sentinel)",
			"Microsoft Defender Antivirus Detections",
			"Follow-up pivots (recommended)",
			"Follow\u2011up pivots (recommended)",
		]) {
			expect(isGenericQueryTitle(title), title).toBe(true);
		}
		expect(isGenericQueryTitle("Detect suspicious PowerShell")).toBe(false);
	});

	it("replaces broad headings with verified source-purpose titles", () => {
		const cases = [
			{
				path: "Azure Resource Graph/Functions/AzureResourceCount.md",
				title: "Log Analytics (Sentinel)",
				kql: 'Resources | summarize count() by subscriptionId',
				dialect: "azure-resource-graph",
				expected: "Count Azure Resources by Subscription",
			},
			{
				path: "Azure Resource Graph/Functions/AzureTagSearch.md",
				title: "Log Analytics (Sentinel)",
				kql: 'Resources | where tags contains "production"',
				dialect: "azure-resource-graph",
				expected: "Search Azure Resources by Tag",
			},
			{
				path: "Azure Resource Graph/Functions/ListPublicIPs.md",
				title: "Log Analytics (Sentinel)",
				kql: "Resources | distinct properties.ipAddress",
				dialect: "azure-resource-graph",
				expected: "List Assigned Azure Public IP Addresses",
			},
			{
				path: "Defender For Endpoint/nf_ttp_generic_kerberos_attacks.md",
				title: "Microsoft Defender Antivirus Detections",
				kql: 'AlertInfo | where Title contains "overpass-the-hash"',
				dialect: "defender-xdr",
				expected: "Find Kerberos Overpass-the-Hash Alerts",
			},
			{
				path:
					"Defender For Endpoint/nf_ttp_smoke-sandstorm_unusual_coreuicomponent.dll-behaviour.md",
				title: "Microsoft Defender Antivirus Detections",
				kql: 'AlertInfo | where Title contains "DLL hijacking"',
				dialect: "defender-xdr",
				expected: "Find Smoke Sandstorm DLL Hijacking Alerts",
			},
			{
				path:
					"Defender XDR/Linux - Network fan\u2011out from the upload process.md",
				title: "Follow\u2011up pivots (recommended)",
				kql: "DeviceNetworkEvents | project RemoteIP, RemotePort",
				dialect: "defender-xdr",
				expected: "Trace Linux Upload Process Network Fan-Out",
			},
			{
				path:
					"Defender XDR/Linux - User activity leading up to exfiltration.md",
				title: "Follow-up pivots (recommended)",
				kql: "DeviceProcessEvents | project AccountName, ProcessCommandLine",
				dialect: "defender-xdr",
				expected: "Review Linux User Activity Before Exfiltration",
			},
		] as const;

		for (const testCase of cases) {
			const enriched = enrichQueryMetadata({
				path: testCase.path,
				title: testCase.title,
				kql: testCase.kql,
				description: "",
				dialect: testCase.dialect,
				metadata: extractKqlMetadata(testCase.kql),
			});

			expect(enriched.title, testCase.path).toBe(testCase.expected);
		}
	});

	it("keeps a descriptive sibling heading in a curated source file", () => {
		const kql =
			'DeviceProcessEvents | where ProcessCommandLine contains "Rubeus"';
		const enriched = enrichQueryMetadata({
			path: "Defender For Endpoint/nf_ttp_generic_kerberos_attacks.md",
			title: "Common Rubeus command lines",
			kql,
			description: "",
			dialect: "defender-xdr",
			metadata: extractKqlMetadata(kql),
		});

		expect(enriched.title).toBe("Common Rubeus command lines");
	});

	it("replaces a combined product heading with the source purpose", () => {
		const kql = "SigninLogs | take 10";
		const enriched = enrichQueryMetadata({
			path: "Identity/SuccessfulDeviceCodeAuthenticationUnmanagedDevice.md",
			title: "Microsoft Sentinel / 365 Defender 3",
			kql,
			description: "",
			dialect: "sentinel",
			metadata: extractKqlMetadata(kql),
		});

		expect(enriched.title).toBe(
			"Successful Device Code Authentication Unmanaged Device - Microsoft Sentinel and Defender XDR",
		);
	});

	it("uses a leading KQL comment to disambiguate repeated generic blocks", () => {
		const kql = `// Update rings
DeviceTvmInfoGathering
| project DeviceName, AvEngineRing`;
		const enriched = enrichQueryMetadata({
			path: "Defender/MDE-DefenderEngine.md",
			title: "Microsoft 365 Defender 5",
			kql,
			description: "",
			dialect: "defender-xdr",
			metadata: extractKqlMetadata(kql),
		});

		expect(enriched.title).toBe("Update rings - Defender XDR");
	});

	it("adds source purpose and KQL intent to repeated product headings", () => {
		const kql = `CloudAppEvents
| where ActionType == "IsolateDevice"
| take 10`;
		const enriched = enrichQueryMetadata({
			path: "Defender For Endpoint/MDE-Audit.md",
			title: "Defender XDR 2",
			kql,
			description: "",
			dialect: "defender-xdr",
			metadata: extractKqlMetadata(kql),
		});

		expect(enriched.title).toBe(
			"MDE Audit: Find Isolate Device events - Part 2 - Defender XDR",
		);
	});

	it("disambiguates a repeated source title with query intent and part number", () => {
		const kql = `CloudAppEvents
| where ActionType == "IsolateDevice"
| take 10`;

		expect(
			disambiguateSourceTitle(
				"MDE Audit - Defender XDR",
				kql,
				extractKqlMetadata(kql),
				4,
			),
		).toBe(
			"MDE Audit: Find Isolate Device events - Part 4 - Defender XDR",
		);
	});
});
