const SECRET_PATTERNS: ReadonlyArray<{
	label: string;
	pattern: RegExp;
}> = [
	{
		label: "The query may contain a GitHub access token.",
		pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{30,})\b/,
	},
	{
		label: "The query may contain a JSON Web Token.",
		pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
	},
	{
		label: "The query may contain an Azure Storage connection string.",
		pattern:
			/\bDefaultEndpointsProtocol=https?;AccountName=[^;\s]+;AccountKey=[^;\s]+/i,
	},
	{
		label: "The query may contain a bearer token.",
		pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/i,
	},
	{
		label: "The query may contain a secret assigned in plain text.",
		pattern:
			/\b(?:api[_-]?key|client[_-]?secret|password|passwd|access[_-]?token)\b\s*(?:=|:|==)\s*["'][^"'\r\n]{8,}["']/i,
	},
];

export function findQueryWarnings(kql: string): string[] {
	return SECRET_PATTERNS.filter(({ pattern }) => pattern.test(kql)).map(
		({ label }) => label,
	);
}
