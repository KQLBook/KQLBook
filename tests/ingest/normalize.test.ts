import { describe, expect, it } from "vitest";

import {
	makeDedupeKey,
	makeSourceIdentity,
	normalizeKql,
} from "../../src/lib/ingest/normalize";

describe("ingestion normalization and dedupe", () => {
	it("normalizes transport whitespace but preserves query semantics", () => {
		expect(
			normalizeKql(
				"\r\nSigninLogs  \r\n\r\n\r\n| where Value == \"A  B\"   \r\n",
			),
		).toBe('SigninLogs\n\n| where Value == "A  B"');
	});

	it("uses normalized KQL, dialect, and source identity in the key", async () => {
		const source = makeSourceIdentity("Example/KQL", "rules/login.kql", 0);
		const first = await makeDedupeKey(
			"SigninLogs  \r\n| take 10\r\n",
			"sentinel",
			source,
		);
		const same = await makeDedupeKey(
			"SigninLogs\n| take 10",
			"sentinel",
			source,
		);
		const otherDialect = await makeDedupeKey(
			"SigninLogs\n| take 10",
			"defender-xdr",
			source,
		);
		const otherSource = await makeDedupeKey(
			"SigninLogs\n| take 10",
			"sentinel",
			makeSourceIdentity("Example/KQL", "rules/other.kql", 0),
		);

		expect(first).toBe(same);
		expect(otherDialect).not.toBe(first);
		expect(otherSource).not.toBe(first);
	});
});

