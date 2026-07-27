import { describe, expect, it } from "vitest";

import { queryTableSummary } from "./query-table-summary";

describe("queryTableSummary", () => {
	it("lists physical tables when they are identified", () => {
		expect(
			queryTableSummary({
				kql: "SigninLogs | take 10",
				operators: ["take"],
				tables: ["SigninLogs"],
			}),
		).toBe("SigninLogs");
	});

	it.each([
		['search "failed sign-in"', []],
		["find where TimeGenerated > ago(1h)", []],
		['let matches = search "suspicious"; matches', []],
		['union * | search "failed sign-in"', ["union", "search"]],
		["union kind=outer isfuzzy=true * | take 10", ["union", "take"]],
		['let matches = (search "suspicious"); matches', ["search"]],
	])("labels an unscoped search as covering all current tables", (kql, operators) => {
		expect(
			queryTableSummary({
				kql,
				operators,
				tables: [],
			}),
		).toBe("All tables in the current scope");
	});

	it.each([
		['print Message = "search failed sign-in"', ["print"]],
		["// search failed sign-in\nprint Value = 1", ["print"]],
		["datatable(Value:string) ['find where Value == 1']", ["datatable"]],
		["range value from 1 to 10 step 1", ["range"]],
	])("labels a tableless query without an all-scope operator accurately", (kql, operators) => {
		expect(
			queryTableSummary({
				kql,
				operators,
				tables: [],
			}),
		).toBe("No physical table referenced");
	});

	it("does not treat an explicitly scoped search as all-scope", () => {
		for (const kql of [
			'search in (SigninLogs) "failed sign-in"',
			'search kind=case_sensitive in (SigninLogs) "failed sign-in"',
			"find withsource=SourceTable in (SigninLogs) where ResultType != 0",
		]) {
			expect(
				queryTableSummary({
					kql,
					operators: ["search"],
					tables: [],
				}),
			).toBe("No physical table referenced");
		}
	});

	it("labels a dynamic table expression without inventing a table name", () => {
		expect(
			queryTableSummary({
				kql: "let tableName = 'SigninLogs'; table(tableName) | take 10",
				operators: ["take"],
				tables: [],
			}),
		).toBe("Table name selected at runtime");
	});
});
