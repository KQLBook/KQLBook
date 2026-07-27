import type { KqlDialect } from "../search/types";
import type { KqlMetadata } from "./metadata";

export interface QueryEnrichmentInput {
	path: string;
	title: string;
	kql: string;
	description: string;
	dialect: KqlDialect;
	metadata: KqlMetadata;
}

export interface EnrichedQueryMetadata {
	title: string;
	description: string;
	tags: string[];
}

const GENERIC_TITLE_PART =
	/^(?:(?:microsoft\s+)?sentinel|log\s+analytics|(?:microsoft\s+)?defender(?:\s+xdr|\s+365|\s+antivirus(?:\s+detections?)?|\s+for\s+(?:cloud|cloud\s+apps|endpoint|identity|office\s+365))?|(?:microsoft\s+)?365\s+defender|(?:microsoft\s+|unified\s+)?xdr|advanced\s+hunting|azure\s+data\s+explorer|(?:azure\s+)?resource\s+graph|resources?|adx|fabric|intune\s+device\s+query|kql|kusto|query|queries|query\s+information|description|purpose|use\s+case|what\s+it\s+does|examples?|references?)$/i;

const DIALECT_TAGS: Record<KqlDialect, string> = {
	sentinel: "sentinel",
	"defender-xdr": "defender-xdr",
	"azure-data-explorer": "azure-data-explorer",
	"azure-resource-graph": "azure-resource-graph",
	"intune-device-query": "intune",
};

const DIALECT_LABELS: Record<KqlDialect, string> = {
	sentinel: "Microsoft Sentinel",
	"defender-xdr": "Defender XDR",
	"azure-data-explorer": "Azure Data Explorer",
	"azure-resource-graph": "Azure Resource Graph",
	"intune-device-query": "Intune Device Query",
};

const SOURCE_PURPOSE_TITLE_RULES: ReadonlyArray<{
	path: string;
	heading: string;
	title: string;
}> = [
	{
		path: "Azure Resource Graph/Functions/AzureResourceCount.md",
		heading: "Log Analytics (Sentinel)",
		title: "Count Azure Resources by Subscription",
	},
	{
		path: "Azure Resource Graph/Functions/AzureTagSearch.md",
		heading: "Log Analytics (Sentinel)",
		title: "Search Azure Resources by Tag",
	},
	{
		path: "Azure Resource Graph/Functions/ListPublicIPs.md",
		heading: "Log Analytics (Sentinel)",
		title: "List Assigned Azure Public IP Addresses",
	},
	{
		path: "Defender For Endpoint/nf_ttp_generic_kerberos_attacks.md",
		heading: "Microsoft Defender Antivirus Detections",
		title: "Find Kerberos Overpass-the-Hash Alerts",
	},
	{
		path:
			"Defender For Endpoint/nf_ttp_smoke-sandstorm_unusual_coreuicomponent.dll-behaviour.md",
		heading: "Microsoft Defender Antivirus Detections",
		title: "Find Smoke Sandstorm DLL Hijacking Alerts",
	},
	{
		path: "Defender XDR/Linux - Network fan-out from the upload process.md",
		heading: "Follow-up pivots (recommended)",
		title: "Trace Linux Upload Process Network Fan-Out",
	},
	{
		path:
			"Defender XDR/Linux - User activity leading up to exfiltration.md",
		heading: "Follow-up pivots (recommended)",
		title: "Review Linux User Activity Before Exfiltration",
	},
];

const SOURCE_PURPOSE_TITLES = new Map(
	SOURCE_PURPOSE_TITLE_RULES.map((rule) => [
		sourcePurposeKey(rule.path, rule.heading),
		rule.title,
	]),
);

const TOPIC_RULES: ReadonlyArray<{ pattern: RegExp; tag: string }> = [
	{ pattern: /\bapplication\s+(?:hang|hung|freeze|freezing)\b/i, tag: "application-hang" },
	{ pattern: /\bapplication\s+(?:crash|crashes|error|failure)\b/i, tag: "application-crash" },
	{ pattern: /\bpassword\s+spray\b/i, tag: "password-spray" },
	{ pattern: /\bbrute[\s-]?force\b/i, tag: "brute-force" },
	{ pattern: /\blateral\s+movement\b/i, tag: "lateral-movement" },
	{ pattern: /\bprivilege(?:d)?\s+(?:escalation|role|access)\b/i, tag: "privileged-access" },
	{ pattern: /\bconditional\s+access\b/i, tag: "conditional-access" },
	{ pattern: /\b(?:sign[\s-]?in|logon|login|authentication)\b/i, tag: "authentication" },
	{ pattern: /\bphish(?:ing)?\b/i, tag: "phishing" },
	{ pattern: /\bransomware\b/i, tag: "ransomware" },
	{ pattern: /\bmalware\b/i, tag: "malware" },
	{ pattern: /\bpowershell\b/i, tag: "powershell" },
	{ pattern: /\b(?:dns|domain\s+name\s+system)\b/i, tag: "dns" },
	{ pattern: /\b(?:firewall|network|ip\s+address|connection)\b/i, tag: "network" },
	{ pattern: /\b(?:registry|run\s+key)\b/i, tag: "registry" },
	{ pattern: /\bcertificate\b/i, tag: "certificate" },
	{ pattern: /\b(?:vulnerability|cve-\d{4}-\d+)\b/i, tag: "vulnerability-management" },
	{ pattern: /\b(?:threat\s+intelligence|indicator\s+of\s+compromise|ioc)\b/i, tag: "threat-intelligence" },
	{ pattern: /\b(?:email|mailbox|exchange|inbox)\b/i, tag: "email-security" },
	{ pattern: /\b(?:process|command\s+line)\b/i, tag: "process" },
	{ pattern: /\b(?:file|folder|directory)\b/i, tag: "file" },
	{ pattern: /\b(?:audit|auditing)\b/i, tag: "audit" },
	{ pattern: /\b(?:incident|alert)\b/i, tag: "incident" },
	{ pattern: /\b(?:compliance|configuration)\b/i, tag: "configuration" },
	{ pattern: /\b(?:monitor|monitoring)\b/i, tag: "monitoring" },
	{ pattern: /\b(?:troubleshoot|troubleshooting)\b/i, tag: "troubleshooting" },
];

export function enrichQueryMetadata(
	input: QueryEnrichmentInput,
): EnrichedQueryMetadata {
	const title = improveTitle(
		input.title,
		input.path,
		input.kql,
		input.dialect,
		input.metadata,
	);
	const sourceDescription =
		normalizeDescription(input.description) ||
		normalizeDescription(descriptionFromComments(input.kql));
	const description =
		sourceDescription ||
		fallbackDescription(title, input.dialect, input.metadata);
	const tags = deriveTags({
		...input,
		title,
		description,
	});

	return { title, description, tags };
}

export function isGenericQueryTitle(value: string): boolean {
	const title = cleanText(value)
		.replace(/\p{Pd}/gu, "-")
		.replace(/^\d+[.)]\s*/, "")
		.replace(/\s*(?:#|[-:])?\s*\d+$/, "")
		.replace(/^the\s+/i, "")
		.replace(/\s+(?:query|queries|kql)$/i, "");
	if (!title) {
		return true;
	}
	if (/^update\s+the(?:\s+query)?$/i.test(title)) {
		return true;
	}
	if (/^follow[-\s]?up\s+pivots?(?:\s*\(\s*recommended\s*\))?$/i.test(title)) {
		return true;
	}
	return title
		.split(/\s*(?:\/|&|\+|,|\(|\)|\s+-\s+|\band\b)\s*/i)
		.filter(Boolean)
		.every((part) => GENERIC_TITLE_PART.test(part));
}

export function disambiguateSourceTitle(
	title: string,
	kql: string,
	metadata: KqlMetadata,
	partNumber: number,
): string {
	const qualifierMatch = title.match(
		/\s+-\s+(?:Microsoft Sentinel(?: and Defender XDR)?|Defender XDR|Azure Data Explorer|Azure Resource Graph|Intune Device Query)$/i,
	);
	const qualifier = qualifierMatch?.[0] ?? "";
	const base = (
		qualifier ? title.slice(0, -qualifier.length) : title
	).replace(/\s+-\s+Part\s+\d+$/i, "");
	const detail =
		titleFromLeadingComment(kql) ||
		titleFromKqlIntent(kql, metadata);
	const head =
		detail && !sameTitle(detail, base)
			? `${base}: ${detail}`
			: base;
	const tail = ` - Part ${partNumber}${qualifier}`;
	const available = Math.max(1, 180 - tail.length);
	return `${head.slice(0, available).trimEnd()}${tail}`;
}

function improveTitle(
	value: string,
	path: string,
	kql: string,
	dialect: KqlDialect,
	metadata: KqlMetadata,
): string {
	const candidate = cleanText(value);
	const sourcePurposeTitle = titleFromKnownSourcePurpose(path, candidate);
	if (sourcePurposeTitle) {
		return sourcePurposeTitle;
	}
	if (candidate && !isGenericQueryTitle(candidate)) {
		return candidate.slice(0, 180);
	}

	const ordinal = genericTitleOrdinal(candidate);
	const pathTitle = titleFromSourcePath(path);
	const commentTitle =
		ordinal > 1 ? titleFromLeadingComment(kql) : "";
	const intentTitle =
		ordinal > 1 && !commentTitle
			? titleFromKqlIntent(kql, metadata)
			: "";
	let sourceTitle =
		commentTitle ||
		(intentTitle && !sameTitle(intentTitle, pathTitle)
			? `${pathTitle}: ${intentTitle} - Part ${ordinal}`
			: pathTitle);
	if (isGenericQueryTitle(sourceTitle) || /^readme$/i.test(sourceTitle)) {
		sourceTitle =
			titleFromLeadingComment(kql) ||
			titleFromKqlIntent(kql, metadata) ||
			titleFromParentPath(path);
	}
	if (!sourceTitle || isGenericQueryTitle(sourceTitle)) {
		sourceTitle = metadata.tables[0]
			? `${humanizeIdentifier(metadata.tables[0])} query`
			: `${DIALECT_LABELS[dialect]} query`;
	}

	const qualifier = genericTitleQualifier(candidate, dialect);
	const title =
		qualifier && !sourceTitle.toLocaleLowerCase("en-US").includes(
			qualifier.toLocaleLowerCase("en-US"),
		)
			? `${sourceTitle} - ${qualifier}`
			: sourceTitle;
	return title.slice(0, 180);
}

function genericTitleOrdinal(title: string): number {
	const match = title.match(/\s*(?:#|[-:])?\s*(\d+)$/);
	const value = Number(match?.[1] ?? 1);
	return Number.isSafeInteger(value) && value > 0 ? value : 1;
}

function sameTitle(left: string, right: string): boolean {
	const normalize = (value: string) =>
		cleanText(value).toLocaleLowerCase("en-US");
	return normalize(left) === normalize(right);
}

function titleFromKqlIntent(
	kql: string,
	metadata: KqlMetadata,
): string {
	const actionFilter = kql.match(
		/\|\s*where\s+(?:tostring\s*\(\s*)?([A-Za-z_][A-Za-z0-9_]*)\s*\)?\s*(?:==|=~|has|contains|startswith)\s*@?(['"])([^'"\r\n]{2,100})\2/i,
	);
	if (actionFilter) {
		const field = actionFilter[1];
		const value = actionFilter[3];
		if (/^(?:type|resourceType)$/i.test(field)) {
			const resource = value.split("/").at(-1) ?? value;
			return `List ${humanizeIdentifier(resource)} resources`;
		}
		if (
			/^(?:ActionType|ActivityType|EventType|Operation|OperationName|RecordType)$/i.test(
				field,
			)
		) {
			return `Find ${humanizeIdentifier(value)} events`;
		}
		const source = metadata.tables[0]
			? humanizeIdentifier(metadata.tables[0])
			: "events";
		return `Filter ${source} by ${humanizeIdentifier(field)}`;
	}

	const distinct = kql.match(
		/\|\s*distinct\s+([A-Za-z_$][A-Za-z0-9_$]*)/i,
	);
	if (distinct) {
		return `List distinct ${humanizeIdentifier(distinct[1])}`;
	}

	const summarize = kql.match(
		/\|\s*summarize\b[^|\r\n]*?\bby\s+(?:[A-Za-z_][A-Za-z0-9_]*\s*=\s*)?([A-Za-z_$][A-Za-z0-9_$]*)/i,
	);
	if (summarize) {
		const source = metadata.tables[0]
			? humanizeIdentifier(metadata.tables[0])
			: "events";
		return `Summarize ${source} by ${humanizeIdentifier(summarize[1])}`;
	}

	return "";
}

function genericTitleQualifier(
	title: string,
	fallback: KqlDialect,
): string | null {
	const withoutOrdinal = title.replace(/\s*(?:#|[-:])?\s*\d+$/, "");
	if (/references?|queries?|kql|kusto/i.test(withoutOrdinal)) {
		return null;
	}
	if (
		/sentinel|log\s+analytics/i.test(withoutOrdinal) &&
		/defender|advanced\s+hunting/i.test(withoutOrdinal)
	) {
		return "Microsoft Sentinel and Defender XDR";
	}
	if (/sentinel|log\s+analytics/i.test(withoutOrdinal)) {
		return DIALECT_LABELS.sentinel;
	}
	if (/defender|advanced\s+hunting/i.test(withoutOrdinal)) {
		return DIALECT_LABELS["defender-xdr"];
	}
	if (/resource\s+graph/i.test(withoutOrdinal)) {
		return DIALECT_LABELS["azure-resource-graph"];
	}
	if (/azure\s+data\s+explorer|\badx\b|\bfabric\b/i.test(withoutOrdinal)) {
		return DIALECT_LABELS["azure-data-explorer"];
	}
	if (/intune/i.test(withoutOrdinal)) {
		return DIALECT_LABELS["intune-device-query"];
	}
	return title ? DIALECT_LABELS[fallback] : null;
}

function titleFromSourcePath(path: string): string {
	const filename = path.split("/").at(-1) ?? "";
	const dot = filename.lastIndexOf(".");
	const stem = dot > 0 ? filename.slice(0, dot) : filename;
	return humanizeIdentifier(stem);
}

function titleFromKnownSourcePurpose(path: string, heading: string): string {
	return SOURCE_PURPOSE_TITLES.get(sourcePurposeKey(path, heading)) ?? "";
}

function sourcePurposeKey(path: string, heading: string): string {
	const normalize = (value: string) =>
		value
			.normalize("NFKC")
			.toLocaleLowerCase("en-US")
			.replace(/[^a-z0-9]+/g, " ")
			.trim();
	return `${normalize(path)}\u0000${normalize(heading)}`;
}

function titleFromParentPath(path: string): string {
	const segments = path.split("/").slice(0, -1).reverse();
	const parent = segments.find((segment) => {
		const candidate = humanizeIdentifier(segment);
		return (
			candidate &&
			!isGenericQueryTitle(candidate) &&
			!/^(?:docs?|rules?|analytics|hunting|queries?)$/i.test(candidate)
		);
	});
	return parent ? humanizeIdentifier(parent) : "";
}

function titleFromLeadingComment(kql: string): string {
	for (const line of kql.replace(/\r\n?/g, "\n").split("\n").slice(0, 30)) {
		if (!line.trim()) {
			continue;
		}
		const comment = line.match(/^\s*\/\/+\s?(.*)$/)?.[1]?.trim();
		if (comment === undefined) {
			break;
		}
		const title = cleanText(
			comment
				.replace(
					/^(?:title|query|name|description|purpose|use\s*case)\s*:\s*/i,
					"",
				)
				.replace(/[.:;]+$/, ""),
		);
		if (
			title.length >= 5 &&
			title.length <= 120 &&
			!isGenericQueryTitle(title) &&
			!/^(?:author|copyright|data\s+connector|source|spdx|https?:\/\/|={3,}|-{3,})\b/i.test(
				title,
			) &&
			!/^this\s+query\b/i.test(title)
		) {
			return title;
		}
	}
	return "";
}

function humanizeIdentifier(value: string): string {
	return cleanText(
		value
			.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
			.replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
			.replace(/[_-]+/g, " "),
	);
}

function descriptionFromComments(kql: string): string {
	const lines = kql.replace(/\r\n?/g, "\n").split("\n").slice(0, 100);
	const collected: string[] = [];
	const leadingParagraph: string[] = [];
	let collecting = false;

	for (const line of lines) {
		if (!line.trim()) {
			if (leadingParagraph.length > 0 && !collecting) {
				break;
			}
			continue;
		}
		const comment = line.match(/^\s*\/\/+\s?(.*)$/)?.[1]?.trim();
		if (comment === undefined) {
			if (collecting || leadingParagraph.length > 0) {
				break;
			}
			continue;
		}
		const labeled = comment.match(
			/^(?:use\s*case|purpose|description)\s*:\s*(.*)$/i,
		);
		if (labeled) {
			collecting = true;
			if (labeled[1]) {
				collected.push(labeled[1]);
			}
			continue;
		}
		if (!collecting) {
			if (
				comment &&
				!/^(?:data\s+connector|author|copyright|spdx|source|https?:\/\/|={3,}|-{3,})\b/i.test(
					comment,
				)
			) {
				leadingParagraph.push(comment);
			}
			continue;
		}
		if (
			!comment ||
			/^(?:tables?|mitre|tactics?|techniques?|author|severity|rule|={3,}|-{3,})\s*:?/i.test(
				comment,
			)
		) {
			break;
		}
		collected.push(comment);
	}

	return (collected.length > 0 ? collected : leadingParagraph).join(" ");
}

function fallbackDescription(
	title: string,
	dialect: KqlDialect,
	metadata: KqlMetadata,
): string {
	const subject = title
		.replace(
			/\s+-\s+(?:Microsoft Sentinel|Defender XDR|Azure Data Explorer|Azure Resource Graph|Intune Device Query)$/i,
			"",
		)
		.trim();
	const source = sourcePhrase(metadata.tables, dialect);
	const actions: ReadonlyArray<[RegExp, string]> = [
		[/^show\s+(.+)/i, "Returns"],
		[/^list\s+(.+)/i, "Lists"],
		[/^find\s+(.+)/i, "Finds"],
		[/^detect\s+(.+)/i, "Detects"],
		[/^identify\s+(.+)/i, "Identifies"],
		[/^monitor\s+(.+)/i, "Monitors"],
		[/^analy[sz]e\s+(.+)/i, "Analyzes"],
		[/^track\s+(.+)/i, "Tracks"],
		[/^check\s+(.+)/i, "Checks"],
		[/^count\s+(.+)/i, "Counts"],
		[/^get\s+(.+)/i, "Returns"],
	];

	for (const [pattern, verb] of actions) {
		const match = subject.match(pattern);
		if (match) {
			return ensureSentence(`${verb} ${lowerFirst(match[1])}${source}`);
		}
	}

	if (metadata.tables.length > 1) {
		return ensureSentence(
			`Correlates ${formatList(metadata.tables.slice(0, 3))} to investigate ${lowerFirst(subject)}`,
		);
	}
	if (metadata.tables.length === 1) {
		return ensureSentence(
			`Queries ${metadata.tables[0]} to investigate ${lowerFirst(subject)}`,
		);
	}
	return ensureSentence(
		`Runs ${lowerFirst(subject)} in ${DIALECT_LABELS[dialect]}`,
	);
}

function sourcePhrase(tables: readonly string[], dialect: KqlDialect): string {
	if (tables.length === 0) {
		return ` in ${DIALECT_LABELS[dialect]}`;
	}
	if (tables.length === 1) {
		return ` from ${tables[0]}`;
	}
	return ` by correlating ${formatList(tables.slice(0, 3))}`;
}

function deriveTags(
	input: QueryEnrichmentInput & { title: string; description: string },
): string[] {
	const tags = new Set<string>([DIALECT_TAGS[input.dialect]]);
	const topicText = [
		input.title,
		input.description,
		humanizeIdentifier(input.path),
		...input.metadata.tables.map(humanizeIdentifier),
	].join(" ");

	for (const table of input.metadata.tables.slice(0, 4)) {
		const normalized = normalizeTag(table);
		if (normalized && normalized !== "resources") {
			tags.add(normalized);
		}
	}
	for (const rule of TOPIC_RULES) {
		if (rule.pattern.test(topicText)) {
			tags.add(rule.tag);
		}
	}
	addTableCategoryTags(tags, input.metadata.tables);

	for (const match of input.kql.matchAll(
		/\bEventId\)?\s*(?:==|=~|in)\s*\(?\s*['"]?(\d{3,5})\b/gi,
	)) {
		tags.add(`event-id-${match[1]}`);
		if (tags.size >= 12) {
			break;
		}
	}
	for (const match of input.kql.matchAll(/\bT\d{4}(?:\.\d{3})?\b/g)) {
		tags.add(match[0].toLocaleLowerCase("en-US"));
		if (tags.size >= 12) {
			break;
		}
	}

	if (
		input.dialect === "intune-device-query" &&
		input.metadata.tables.some((table) =>
			/^(?:FileInfo|WindowsEvent|WindowsRegistry)$/i.test(table),
		)
	) {
		tags.add("single-device");
	}
	if (tags.size < 3 && input.metadata.operators.includes("join")) {
		tags.add("correlation");
	}
	if (tags.size < 3 && input.metadata.operators.includes("summarize")) {
		tags.add("aggregation");
	}
	if (tags.size < 2) {
		tags.add("community-query");
	}

	return [...tags].slice(0, 12);
}

function addTableCategoryTags(
	tags: Set<string>,
	tables: readonly string[],
): void {
	const joined = tables.join(" ");
	if (/\b(?:AAD|AuditLogs|SigninLogs|Entra|Identity)/i.test(joined)) {
		tags.add("identity");
	}
	if (/\bDevice(?:Events|Info|File|Image|Logon|Network|Process|Registry|Tvm)/i.test(joined)) {
		tags.add("endpoint");
	}
	if (/\b(?:Email|UrlClick|OfficeActivity)/i.test(joined)) {
		tags.add("email-security");
	}
	if (/\b(?:SecurityEvent|WindowsEvent|Syslog|CommonSecurityLog)\b/i.test(joined)) {
		tags.add("event-log");
	}
	if (/\b(?:ThreatIntel|ThreatIntelligence)/i.test(joined)) {
		tags.add("threat-intelligence");
	}
	if (/\bDeviceTvm/i.test(joined)) {
		tags.add("vulnerability-management");
	}
}

function normalizeDescription(value: string): string {
	const cleaned = cleanText(
		value
			.replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
			.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
			.replace(/<[^>]+>/g, " ")
			.replace(/^(?:use\s*case|purpose|description)\s*:\s*/i, ""),
	);
	if (cleaned.length < 8) {
		return "";
	}
	const shortened =
		cleaned.length > 900
			? `${cleaned.slice(0, 897).replace(/\s+\S*$/, "")}...`
			: cleaned;
	return ensureSentence(shortened);
}

function normalizeTag(value: string): string {
	return humanizeIdentifier(value)
		.toLocaleLowerCase("en-US")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 64);
}

function cleanText(value: string): string {
	return value.replace(/[*_`~]/g, "").replace(/\s+/g, " ").trim();
}

function ensureSentence(value: string): string {
	const cleaned = cleanText(value);
	return /[.!?]$/.test(cleaned) ? cleaned : `${cleaned}.`;
}

function lowerFirst(value: string): string {
	return value ? `${value[0].toLocaleLowerCase("en-US")}${value.slice(1)}` : value;
}

function formatList(values: readonly string[]): string {
	if (values.length <= 1) {
		return values[0] ?? "";
	}
	if (values.length === 2) {
		return `${values[0]} and ${values[1]}`;
	}
	return `${values.slice(0, -1).join(", ")}, and ${values.at(-1)}`;
}
