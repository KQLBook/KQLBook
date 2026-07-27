import { describe, expect, it } from "vitest";

import { IngestionError } from "../../src/lib/ingest/errors";
import {
	assertApprovedRepositoryLicense,
	assertFileLicenseCompatible,
	buildIngestionLicense,
} from "../../src/lib/ingest/license-policy";
import type {
	GithubLicenseFile,
	GithubRepository,
} from "../../src/lib/ingest/types";

function repository(
	spdxId: string | null,
): GithubRepository {
	return {
		fullName: "example/kql",
		owner: "example",
		name: "kql",
		defaultBranch: "main",
		htmlUrl: "https://github.com/example/kql",
		license: spdxId
			? {
					spdxId,
					name: spdxId,
					apiUrl: "https://api.github.com/licenses/example",
				}
			: null,
	};
}

const licenseFile: GithubLicenseFile = {
	spdxId: "MIT",
	name: "MIT License",
	path: "LICENSE",
	htmlUrl:
		"https://github.com/example/kql/blob/1111111111111111111111111111111111111111/LICENSE",
	text: "Copyright Example\n\nPermission is hereby granted.",
};

describe("repository license gate", () => {
	it.each([
		"MIT",
		"BSD-2-Clause",
		"BSD-3-Clause",
		"Apache-2.0",
		"ISC",
		"Unlicense",
		"CC0-1.0",
	])("allows exact allowlisted SPDX identifier %s", (spdxId) => {
		expect(assertApprovedRepositoryLicense(repository(spdxId))).toBe(spdxId);
	});

	it.each([null, "NOASSERTION", "GPL-3.0", "AGPL-3.0", "MIT OR GPL-3.0"])(
		"rejects missing, unknown, copyleft, or compound license %s",
		(spdxId) => {
			expect(() => assertApprovedRepositoryLicense(repository(spdxId))).toThrow(
				IngestionError,
			);
		},
	);

	it("retains the license text and Apache NOTICE material", () => {
		const apacheFile = {
			...licenseFile,
			spdxId: "Apache-2.0",
			name: "Apache License 2.0",
			text: "Apache License\nVersion 2.0",
		};
		const result = buildIngestionLicense(
			repository("Apache-2.0"),
			apacheFile,
			"Copyright Example Contributors",
		);

		expect(result.requiredNotice).toContain("Apache License");
		expect(result.requiredNotice).toContain("NOTICE");
		expect(result.requiredNotice).toContain("Example Contributors");
	});

	it("rejects a conflicting per-file SPDX header", () => {
		expect(() =>
			assertFileLicenseCompatible(
				"// SPDX-License-Identifier: MIT OR GPL-3.0\nSigninLogs | take 10",
				"MIT",
				"query.kql",
			),
		).toThrowError(/differs from repository license MIT/);
	});
});
