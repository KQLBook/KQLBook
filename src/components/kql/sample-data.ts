export type KqlDialect =
	| "sentinel"
	| "defender-xdr"
	| "azure-data-explorer"
	| "azure-resource-graph"
	| "intune-device-query";

export type QueryVisibility = "public" | "private";

export type QueryRecord = {
	id: string;
	versionId: string;
	title: string;
	snippet: string;
	explanation: string;
	kql: string;
	dialect: KqlDialect;
	dialectLabel: string;
	tables: string[];
	operators: string[];
	tags: string[];
	starCount: number;
	sourceName: string;
	sourceUrl?: string;
	sourceRepository?: string;
	sourceRepositoryUrl?: string;
	sourceProvider?: "github" | "local";
	license: string;
	author: string;
	updatedAt: string;
	visibility: QueryVisibility;
	matchType: "lexical" | "semantic" | "hybrid";
	score: number;
	aiGenerated?: boolean;
	assumptions?: string[];
	model?: string;
	starredByViewer?: boolean;
};

export const DIALECT_OPTIONS: Array<{ value: KqlDialect; label: string }> = [
	{ value: "sentinel", label: "Sentinel / Log Analytics" },
	{ value: "defender-xdr", label: "Defender XDR" },
	{ value: "azure-data-explorer", label: "Azure Data Explorer / Fabric" },
	{ value: "azure-resource-graph", label: "Azure Resource Graph" },
	{ value: "intune-device-query", label: "Intune Device Query" },
];

export const SAMPLE_QUERIES: QueryRecord[] = [
	{
		id: "d3a1509d-9160-4dc5-b5b7-5e62ed8abaf0",
		versionId: "9ab47bb2-d76d-441b-b98e-bd014c22b8f0",
		title: "Password spray across multiple countries",
		snippet:
			"Find users with repeated failed sign-ins from more than one country inside a 15-minute window.",
		explanation:
			"This query groups failed Entra sign-ins by user and 15-minute window, then keeps bursts that cross both an attempt threshold and a country threshold. Review the result with Conditional Access, identity risk, and successful sign-ins before treating it as a confirmed password spray.",
		kql: `let attemptThreshold = 8;
let countryThreshold = 2;
SigninLogs
| where TimeGenerated > ago(1h)
| where ResultType != 0
| extend Country = tostring(LocationDetails.countryOrRegion)
| summarize
    FailedAttempts = count(),
    Countries = make_set(Country, 10),
    CountryCount = dcount(Country),
    SourceIPs = make_set(IPAddress, 20)
  by UserPrincipalName, bin(TimeGenerated, 15m)
| where FailedAttempts >= attemptThreshold
    and CountryCount >= countryThreshold
| order by FailedAttempts desc`,
		dialect: "sentinel",
		dialectLabel: "Sentinel",
		tables: ["SigninLogs"],
		operators: ["where", "extend", "summarize", "make_set", "dcount"],
		tags: ["identity", "password-spray", "entra-id"],
		starCount: 184,
		sourceName: "KQL Book demo",
		license: "CC0-1.0",
		author: "KQL Book",
		updatedAt: "Jul 18, 2026",
		visibility: "public",
		matchType: "hybrid",
		score: 0.97,
	},
	{
		id: "1299fab4-459d-48b5-964b-2bc678c32366",
		versionId: "0eca3257-40bc-4cc6-81ae-e3d1952b1359",
		title: "Encoded PowerShell launched by Office",
		snippet:
			"Surface Office processes that start PowerShell with encoded or hidden-window command-line arguments.",
		explanation:
			"This Defender XDR query looks for PowerShell spawned by common Office applications and gives extra weight to encoded, hidden, and non-interactive arguments. Parent-child context reduces noise, but administrators and document automation can still produce legitimate matches.",
		kql: `DeviceProcessEvents
| where Timestamp > ago(24h)
| where FileName in~ ("powershell.exe", "pwsh.exe")
| where InitiatingProcessFileName in~ (
    "winword.exe",
    "excel.exe",
    "powerpnt.exe",
    "outlook.exe"
  )
| where ProcessCommandLine has_any (
    "-enc",
    "-encodedcommand",
    "-windowstyle hidden",
    "-noninteractive"
  )
| project
    Timestamp,
    DeviceName,
    AccountUpn,
    InitiatingProcessFileName,
    ProcessCommandLine,
    SHA1
| order by Timestamp desc`,
		dialect: "defender-xdr",
		dialectLabel: "Defender XDR",
		tables: ["DeviceProcessEvents"],
		operators: ["where", "in~", "has_any", "project"],
		tags: ["powershell", "office", "execution"],
		starCount: 132,
		sourceName: "KQL Book demo",
		license: "CC0-1.0",
		author: "KQL Book",
		updatedAt: "Jul 11, 2026",
		visibility: "public",
		matchType: "semantic",
		score: 0.91,
	},
	{
		id: "ba71215d-af4f-4c33-83b8-12594c4a2080",
		versionId: "447a9e0d-5841-4100-a8b4-9ade1f930ac8",
		title: "Rare service installation on Windows endpoints",
		snippet:
			"Identify newly created services whose image path or service name is uncommon across the device fleet.",
		explanation:
			"This hunting query establishes a seven-day baseline for service names, then returns service-installation events from the last day that appear on only one device. The result is intended for triage with signer, file prevalence, and process-tree evidence.",
		kql: `let baseline =
    DeviceEvents
    | where Timestamp between (ago(8d) .. ago(1d))
    | where ActionType == "ServiceInstalled"
    | summarize BaselineDevices = dcount(DeviceId) by ServiceName;
DeviceEvents
| where Timestamp > ago(1d)
| where ActionType == "ServiceInstalled"
| extend ServiceName = tostring(AdditionalFields.ServiceName)
| extend ServiceImagePath = tostring(AdditionalFields.ServiceImagePath)
| join kind=leftouter baseline on ServiceName
| where coalesce(BaselineDevices, 0) <= 1
| project Timestamp, DeviceName, ServiceName, ServiceImagePath, InitiatingProcessAccountUpn
| order by Timestamp desc`,
		dialect: "defender-xdr",
		dialectLabel: "Defender XDR",
		tables: ["DeviceEvents"],
		operators: ["let", "summarize", "join", "coalesce", "project"],
		tags: ["persistence", "service", "windows"],
		starCount: 97,
		sourceName: "KQL Book demo",
		license: "CC0-1.0",
		author: "KQL Book",
		updatedAt: "Jul 2, 2026",
		visibility: "public",
		matchType: "hybrid",
		score: 0.87,
	},
	{
		id: "be6a9954-39d2-44b9-82ea-c4e1c0d2a50d",
		versionId: "cc37f585-4d16-441f-b453-0dc820f81d69",
		title: "Public IP addresses without an associated network security group",
		snippet:
			"List attached public IP resources whose network interface does not reference a network security group.",
		explanation:
			"This Azure Resource Graph query joins public IP resources to network interfaces, expands their IP configurations, and keeps interfaces without an NSG reference. It reports resource configuration only; validate effective rules and the attached workload separately.",
		kql: `Resources
| where type =~ "microsoft.network/publicipaddresses"
| project
    publicIpId = id,
    publicIpName = name,
    resourceGroup,
    subscriptionId,
    ipAddress = tostring(properties.ipAddress)
| join kind=inner (
    Resources
    | where type =~ "microsoft.network/networkinterfaces"
    | mv-expand ipConfig = properties.ipConfigurations
    | extend publicIpId = tostring(ipConfig.properties.publicIPAddress.id)
    | extend nsgId = tostring(properties.networkSecurityGroup.id)
    | project publicIpId, nicName = name, nsgId
  ) on publicIpId
| where isempty(nsgId)
| project subscriptionId, resourceGroup, publicIpName, ipAddress, nicName
| order by subscriptionId asc`,
		dialect: "azure-resource-graph",
		dialectLabel: "Resource Graph",
		tables: ["Resources"],
		operators: ["where", "project", "join", "mv-expand", "isempty"],
		tags: ["azure", "network", "exposure"],
		starCount: 76,
		sourceName: "KQL Book demo",
		license: "CC0-1.0",
		author: "KQL Book",
		updatedAt: "Jun 29, 2026",
		visibility: "public",
		matchType: "lexical",
		score: 0.84,
	},
	{
		id: "025ae4ab-f7ec-4fa5-ae9c-71a2de3ca9f8",
		versionId: "630f19e3-88ee-42d8-9e37-43c7ddfd9fe2",
		title: "Authentication failures by application and error code",
		snippet:
			"Summarize application authentication failures and compare each interval with its recent baseline.",
		explanation:
			"This Azure Data Explorer query builds an hourly series for failed authentication events, decomposes the series, and returns positive anomalies. Replace the sample table and column names with the schema used by your cluster or Fabric eventhouse.",
		kql: `AuthenticationEvents
| where Timestamp > ago(14d)
| where Result == "Failure"
| make-series Failures = count()
    on Timestamp
    from ago(14d) to now() step 1h
    by Application, ErrorCode
| extend (Anomalies, Score, Baseline) =
    series_decompose_anomalies(Failures, 1.5, -1, "linefit")
| mv-expand
    Timestamp to typeof(datetime),
    Failures to typeof(long),
    Anomalies to typeof(double),
    Score to typeof(double),
    Baseline to typeof(double)
| where Anomalies > 0
| project Timestamp, Application, ErrorCode, Failures, Baseline, Score
| order by Score desc`,
		dialect: "azure-data-explorer",
		dialectLabel: "ADX / Fabric",
		tables: ["AuthenticationEvents"],
		operators: ["make-series", "series_decompose_anomalies", "mv-expand"],
		tags: ["anomaly", "authentication", "timeseries"],
		starCount: 58,
		sourceName: "KQL Book demo",
		license: "CC0-1.0",
		author: "KQL Book",
		updatedAt: "Jun 21, 2026",
		visibility: "public",
		matchType: "semantic",
		score: 0.8,
	},
	{
		id: "1a83e8bf-1cb8-47d6-be87-23706b7345f7",
		versionId: "e149ce30-6354-46ae-af76-cbd68e9b37f8",
		title: "Device health and local storage readiness",
		snippet:
			"Return device identity, operating system, free disk space, and encryption state for an Intune device query.",
		explanation:
			"This Intune Device Query uses the Device, LogicalDrive, and EncryptableVolume entities to provide a compact readiness snapshot. Entity availability and property names should be confirmed against the Intune query schema for the target device.",
		kql: `Device
| project DeviceName, Manufacturer, Model, OSVersion
| join kind=leftouter (
    LogicalDrive
    | where DriveType == 3
    | project DeviceId, DriveId, FreeSpaceBytes, SizeBytes
  ) on DeviceId
| join kind=leftouter (
    EncryptableVolume
    | project DeviceId, DriveId, ProtectionStatus, EncryptionMethod
  ) on DeviceId, DriveId
| project
    DeviceName,
    Manufacturer,
    Model,
    OSVersion,
    DriveId,
    FreeSpaceGB = round(FreeSpaceBytes / 1GB, 1),
    ProtectionStatus,
    EncryptionMethod`,
		dialect: "intune-device-query",
		dialectLabel: "Intune",
		tables: ["Device", "LogicalDrive", "EncryptableVolume"],
		operators: ["project", "join", "where", "round"],
		tags: ["intune", "device-health", "encryption"],
		starCount: 41,
		sourceName: "KQL Book demo",
		license: "CC0-1.0",
		author: "KQL Book",
		updatedAt: "Jun 17, 2026",
		visibility: "public",
		matchType: "lexical",
		score: 0.77,
	},
];

export function findSampleQuery(id: string): QueryRecord | undefined {
	return SAMPLE_QUERIES.find((query) => query.id === id);
}

export function dialectLabel(value: string): string {
	return (
		DIALECT_OPTIONS.find((option) => option.value === value)?.label ??
		value
			.split("-")
			.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
			.join(" ")
	);
}

function objectValue(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object"
		? (value as Record<string, unknown>)
		: null;
}

function stringList(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter((entry): entry is string => typeof entry === "string")
		: [];
}

function isDialect(value: unknown): value is KqlDialect {
	return DIALECT_OPTIONS.some((option) => option.value === value);
}

/**
 * Maps the canonical D1/API record shape into the view model shared by the
 * client inspector and the server-rendered public query page.
 */
export function mapStoredQuery(value: unknown): QueryRecord | null {
	const record = objectValue(value);
	if (!record || typeof record.id !== "string") {
		return null;
	}

	const version = objectValue(record.currentVersion) ?? record;
	if (
		typeof version.title !== "string" ||
		typeof version.kql !== "string" ||
		!isDialect(version.dialect)
	) {
		return null;
	}

	const provenance = objectValue(record.provenance);
	const description =
		typeof version.description === "string" ? version.description : "";
	const explanation =
		(typeof version.explanation === "string"
			? version.explanation.trim()
			: "") ||
		description.trim() ||
		"No explanation has been added yet.";
	const sourceName =
		typeof provenance?.sourceName === "string"
			? provenance.sourceName
			: typeof provenance?.repository === "string"
				? provenance.repository
				: "Community query";
	const updatedAt =
		typeof record.updatedAt === "string"
			? new Date(record.updatedAt).toLocaleDateString("en-US", {
					year: "numeric",
					month: "short",
					day: "numeric",
				})
			: "Recently";

	return {
		id: record.id,
		versionId:
			typeof version.id === "string"
				? version.id
				: typeof record.currentVersionId === "string"
					? record.currentVersionId
					: record.id,
		title: version.title,
		snippet: description || explanation,
		explanation,
		kql: version.kql,
		dialect: version.dialect,
		dialectLabel: dialectLabel(version.dialect),
		tables: stringList(version.tables),
		operators: stringList(version.operators),
		tags: stringList(version.tags),
		starCount: typeof record.starCount === "number" ? record.starCount : 0,
		sourceName,
		sourceUrl:
			typeof provenance?.sourceUrl === "string"
				? provenance.sourceUrl
				: undefined,
		sourceRepository:
			typeof record.sourceRepository === "string"
				? record.sourceRepository
				: undefined,
			sourceRepositoryUrl:
				typeof record.sourceRepositoryUrl === "string"
					? record.sourceRepositoryUrl
					: undefined,
			sourceProvider:
			provenance?.provider === "github" || provenance?.provider === "local"
				? provenance.provider
				: undefined,
		license:
			typeof provenance?.licenseSpdx === "string"
				? provenance.licenseSpdx
				: "Community submission",
		author:
			typeof provenance?.originalAuthor === "string"
				? provenance.originalAuthor
				: sourceName,
		updatedAt,
		visibility: record.visibility === "private" ? "private" : "public",
		matchType: "hybrid",
		score: 1,
		aiGenerated: version.aiGenerated === true,
		assumptions: stringList(version.assumptions),
		model:
			typeof version.generationModel === "string"
				? version.generationModel
				: undefined,
		starredByViewer: record.starredByViewer === true,
	};
}
