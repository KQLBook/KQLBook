import type { KqlDialect } from "../search/types";

export interface KqlMetadata {
	tables: string[];
	operators: string[];
}

const NON_TABLE_IDENTIFIERS = new Set([
	"alias",
	"consume",
	"declare",
	"datatable",
	"evaluate",
	"externaldata",
	"find",
	"hint",
	"isfuzzy",
	"kind",
	"let",
	"macro-expand",
	"materialize",
	"pattern",
	"print",
	"range",
	"restrict",
	"search",
	"set",
	"union",
	"withsource",
]);

const PARAMETERIZED_INTUNE_ENTITIES = new Set([
	"fileinfo",
	"windowsevent",
	"windowsregistry",
]);

const RESOURCE_GRAPH_TABLES = new Set([
	"advisorresources",
	"authorizationresources",
	"chaosresources",
	"desktopvirtualizationresources",
	"extendedlocationresources",
	"guestconfigurationresources",
	"healthresources",
	"kubernetesconfigurationresources",
	"maintenanceresources",
	"migrateresources",
	"networkresources",
	"patchassessmentresources",
	"patchinstallationresources",
	"policyresources",
	"recoveryservicesresources",
	"resourcechanges",
	"resourcecontainerchanges",
	"resourcecontainers",
	"resources",
	"securityresources",
	"servicefabricresources",
	"servicehealthresources",
	"spotresources",
	"supportresources",
	"tagsresources",
]);

export function extractKqlMetadata(kql: string): KqlMetadata {
	const searchable = stripCommentsAndStrings(kql);
	const withoutComments = stripComments(kql);
	const letNames = new Set(
		[...searchable.matchAll(/\blet\s+([A-Za-z_][A-Za-z0-9_]*)\s*=/gi)].map(
			(match) => match[1].toLocaleLowerCase("en-US"),
		),
	);
	const tables = new Map<string, string>();

	const addTable = (candidate: string | undefined) => {
		if (!candidate) {
			return;
		}
		const normalized = candidate.toLocaleLowerCase("en-US");
		if (
			letNames.has(normalized) ||
			NON_TABLE_IDENTIFIERS.has(normalized)
		) {
			return;
		}
		if (!tables.has(normalized)) {
			tables.set(normalized, candidate);
		}
	};

	for (const match of kql.matchAll(
		/\btable\s*\(\s*(['"])([A-Za-z_][A-Za-z0-9_]*)\1\s*\)/gi,
	)) {
		addTable(match[2]);
	}
	for (const definition of withoutComments.matchAll(
		/\blet\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*string\b[^)]*\)\s*\{([\s\S]*?)\}\s*;/gi,
	)) {
		const functionName = definition[1];
		const tableParameter = definition[2];
		const body = definition[3];
		if (
			!new RegExp(
				`\\btable\\s*\\(\\s*${escapeRegex(tableParameter)}\\s*\\)`,
				"i",
			).test(body)
		) {
			continue;
		}

		const calls = [
			...withoutComments.matchAll(
				new RegExp(
					`\\b${escapeRegex(functionName)}\\s*\\(\\s*([^,\\r\\n)]+)`,
					"gi",
				),
			),
		];
		const tableNames = calls.map((call) =>
			call[1]
				.trim()
				.match(/^(['"])([A-Za-z_][A-Za-z0-9_]*)\1$/)?.[2],
		);
		if (
			tableNames.length > 0 &&
			tableNames.every((table): table is string => Boolean(table))
		) {
			for (const table of tableNames) {
				addTable(table);
			}
		}
	}
	for (const match of searchable.matchAll(
		/\blet\s+[A-Za-z_][A-Za-z0-9_]*\s*=\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?=\||;|\n)/gi,
	)) {
		addTable(match[1]);
	}
	for (const match of searchable.matchAll(
		/\blet\s+[A-Za-z_][A-Za-z0-9_]*\s*=\s*([A-Za-z_][A-Za-z0-9_]*)\s*\(/gi,
	)) {
		if (
			PARAMETERIZED_INTUNE_ENTITIES.has(
				match[1].toLocaleLowerCase("en-US"),
			)
		) {
			addTable(match[1]);
		}
	}
	for (const match of searchable.matchAll(
		/(?:^|[;{(])\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?=\||$)/g,
	)) {
		addTable(match[1]);
	}
	for (const match of searchable.matchAll(
		/(?:^|[;{(])\s*(?:[A-Za-z_][A-Za-z0-9_]*\([^)\n]*\)\.)+([A-Za-z_][A-Za-z0-9_]*)\s*(?=\||$)/g,
	)) {
		addTable(match[1]);
	}
	for (const match of searchable.matchAll(
		/(?:^|[;{(])\s*\["([^"\r\n]+)"\]\s*(?=\||$)/g,
	)) {
		addTable(match[1]);
	}
	for (const match of searchable.matchAll(
		/(?:^|[;{(])\s*([A-Za-z_][A-Za-z0-9_]*)\s*\(/g,
	)) {
		if (
			PARAMETERIZED_INTUNE_ENTITIES.has(
				match[1].toLocaleLowerCase("en-US"),
			)
		) {
			addTable(match[1]);
		}
	}
	for (const match of searchable.matchAll(
		/\|\s*(?:join|lookup)\b\s*(?:(?:kind|hint\.[A-Za-z_-]+)\s*=\s*[^\s(]+\s*)*\(?\s*(?:(?:[A-Za-z_][A-Za-z0-9_]*\([^)\n]*\)\.)+)?([A-Za-z_][A-Za-z0-9_]*)\b(?!\s*[=(])/gi,
	)) {
		addTable(match[1]);
	}
	for (const match of searchable.matchAll(
		/(?:^|[;|{(=])\s*union\b(?:\s+[A-Za-z_][A-Za-z0-9_]*\s*=\s*[^,\s|]+)*\s+([^|;]+)/gi,
	)) {
		for (const item of match[1].split(",")) {
			const normalizedItem = item
				.trim()
				.replace(/^\(+/, "")
				.trimStart();
			const identifierMatch = normalizedItem.match(
				/^([A-Za-z_][A-Za-z0-9_]*\*?)/,
			);
			const identifier =
				identifierMatch &&
				!normalizedItem
					.slice(identifierMatch[0].length)
					.trimStart()
					.startsWith("(")
					? identifierMatch[1]
					: undefined;
			addTable(identifier);
		}
	}
	for (const match of searchable.matchAll(
		/\b(?:find|search)\s+in\s*\(([^)]+)\)/gi,
	)) {
		for (const item of match[1].split(",")) {
			addTable(
				item
					.trim()
					.match(/^([A-Za-z_][A-Za-z0-9_]*\*?)/)?.[1],
			);
		}
	}

	const operators = new Set<string>();
	for (const match of searchable.matchAll(
		/\|\s*([A-Za-z][A-Za-z0-9-]*)(?:\s+(by))?/g,
	)) {
		const first = match[1].toLocaleLowerCase("en-US");
		const operator =
			match[2] && (first === "order" || first === "sort")
				? `${first} by`
				: first;
		operators.add(operator);
	}

	return {
		tables: [...tables.values()].slice(0, 64),
		operators: [...operators].slice(0, 64),
	};
}

export function applyDialectTableDefaults(
	metadata: KqlMetadata,
	dialect: KqlDialect,
): KqlMetadata {
	if (dialect !== "azure-resource-graph" || metadata.tables.length > 0) {
		return metadata;
	}
	return {
		...metadata,
		// Azure Resource Graph runs against Resources when no table is written.
		tables: ["Resources"],
	};
}

export function inferSpecialDialect(
	metadata: KqlMetadata,
	fallback: KqlDialect,
): KqlDialect {
	if (fallback === "intune-device-query") {
		return fallback;
	}
	if (
		metadata.tables.some((table) =>
			RESOURCE_GRAPH_TABLES.has(table.toLocaleLowerCase("en-US")),
		)
	) {
		return "azure-resource-graph";
	}
	return fallback;
}

function stripCommentsAndStrings(value: string): string {
	let output = "";
	let index = 0;

	while (index < value.length) {
		const current = value[index];
		const next = value[index + 1];
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
		if (current === '"' || current === "'") {
			const quote = current;
			output += " ";
			index += 1;
			while (index < value.length) {
				if (value[index] === quote) {
					if (value[index + 1] === quote) {
						output += "  ";
						index += 2;
						continue;
					}
					output += " ";
					index += 1;
					break;
				}
				output += value[index] === "\n" ? "\n" : " ";
				index += 1;
			}
			continue;
		}
		output += current;
		index += 1;
	}

	return output;
}

function stripComments(value: string): string {
	let output = "";
	let index = 0;
	let quote: "'" | '"' | null = null;

	while (index < value.length) {
		const current = value[index];
		const next = value[index + 1];
		if (quote) {
			output += current;
			if (current === quote) {
				if (next === quote) {
					output += next;
					index += 2;
					continue;
				}
				quote = null;
			}
			index += 1;
			continue;
		}
		if (current === "'" || current === '"') {
			quote = current;
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

function escapeRegex(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
