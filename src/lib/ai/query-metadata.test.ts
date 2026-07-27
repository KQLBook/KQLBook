import { describe, expect, it, vi } from "vitest";

import { DeepSeekClient } from "./deepseek";
import { DeepSeekQueryMetadataAnalyzer } from "./query-metadata";

function clientResponse(payload: Record<string, unknown>) {
	const fetchMock = vi.fn().mockResolvedValue(
		Response.json({
			choices: [{ message: { content: JSON.stringify(payload) } }],
		}),
	);
	const client = new DeepSeekClient({
		apiKey: "test-key",
		fetch: fetchMock,
	});

	return {
		fetchMock,
		analyzer: new DeepSeekQueryMetadataAnalyzer(client),
	};
}

describe("DeepSeekQueryMetadataAnalyzer", () => {
	it("returns normalized metadata and deterministic KQL operators", async () => {
		const { analyzer, fetchMock } = clientResponse({
			dialect: "sentinel",
			dialectConfidence: 0.97,
			tables: [" SigninLogs ", "signinlogs"],
			tags: [" Identity ", "identity", "Failed Sign Ins"],
		});

		const metadata = await analyzer.analyze({
			title: "Failed sign-ins",
			kql: "SigninLogs | where ResultType != 0 | summarize count()",
			explanation: "Counts failed sign-ins.",
		});

		expect(metadata).toEqual({
			dialect: "sentinel",
			dialectConfidence: 0.97,
			tables: ["SigninLogs"],
			operators: ["where", "summarize"],
			tags: ["identity", "failed-sign-ins"],
		});

		const body = JSON.parse(fetchMock.mock.calls[0][1].body);
		expect(body.response_format).toEqual({ type: "json_object" });
		expect(body.messages[0].content).toContain('"additionalProperties":false');
		expect(body.messages[0].content).toContain('"maxItems":20');
		expect(body.messages[0].content).toContain('"maxItems":12');
		expect(body.messages[0].content).toContain("untrusted data");
		const prompt = JSON.parse(body.messages[1].content);
		expect(prompt).toEqual({
			title: "Failed sign-ins",
			kql: "SigninLogs | where ResultType != 0 | summarize count()",
			explanation: "Counts failed sign-ins.",
			extractedCandidates: {
				tables: ["SigninLogs"],
				operators: ["where", "summarize"],
			},
		});
		expect(prompt).not.toHaveProperty("visibility");
		expect(prompt).not.toHaveProperty("ownerId");
	});

	it("does not add a model-proposed table absent from the KQL", async () => {
		const { analyzer } = clientResponse({
			dialect: "sentinel",
			dialectConfidence: 0.94,
			tables: ["SigninLogs", "AuditLogs"],
			tags: ["authentication"],
		});

		const metadata = await analyzer.analyze({
			title: "Failed sign-ins",
			kql: "SigninLogs | take 10",
			explanation: "",
		});

		expect(metadata.tables).toEqual(["SigninLogs"]);
	});

	it.each([
		{
			name: "a union wildcard",
			kql: "union SecurityEvent* | take 10",
			table: "SecurityEvent*",
		},
		{
			name: "an escaped table name",
			kql: '["Device Inventory"] | take 10',
			table: "Device Inventory",
		},
	])("preserves $name in generated table metadata", async ({ kql, table }) => {
		const { analyzer } = clientResponse({
			dialect: "azure-data-explorer",
			dialectConfidence: 0.95,
			tables: [table],
			tags: ["inventory"],
		});

		const metadata = await analyzer.analyze({
			title: "Inventory",
			kql,
			explanation: "",
		});

		expect(metadata.tables).toContain(table);
	});

	it("returns an ambiguous dialect instead of assuming Sentinel", async () => {
		const { analyzer } = clientResponse({
			dialect: null,
			dialectConfidence: 0.2,
			tables: [],
			tags: ["inventory"],
		});

		await expect(
			analyzer.analyze({
				title: "Inventory",
				kql: "let inventory = datatable(Name: string) ['example']; inventory",
				explanation: "",
			}),
		).resolves.toMatchObject({
			dialect: null,
			dialectConfidence: 0.2,
		});
	});

	it("rejects unexpected fields and sensitive tag values", async () => {
		const unexpected = clientResponse({
			dialect: "sentinel",
			dialectConfidence: 0.9,
			tables: ["SigninLogs"],
			tags: ["identity"],
			visibility: "public",
		});
		const sensitive = clientResponse({
			dialect: "sentinel",
			dialectConfidence: 0.9,
			tables: ["SigninLogs"],
			tags: ["analyst@example.test"],
		});
		const input = {
			title: "Failed sign-ins",
			kql: "SigninLogs | take 10",
			explanation: "",
		};

		await expect(unexpected.analyzer.analyze(input)).rejects.toMatchObject({
			code: "invalid_response",
		});
		await expect(sensitive.analyzer.analyze(input)).rejects.toMatchObject({
			code: "invalid_response",
		});
	});

	it("requires the provider to honor a confirmed dialect", async () => {
		const { analyzer } = clientResponse({
			dialect: "sentinel",
			dialectConfidence: 0.99,
			tables: ["Resources"],
			tags: ["inventory"],
		});

		await expect(
			analyzer.analyze({
				title: "Resource inventory",
				kql: "Resources | take 10",
				explanation: "",
				confirmedDialect: "azure-resource-graph",
			}),
		).rejects.toMatchObject({
			code: "invalid_response",
		});
	});
});
