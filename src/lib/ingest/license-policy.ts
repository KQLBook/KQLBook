import { IngestionError } from "./errors";
import {
	APPROVED_INGESTION_LICENSES,
	type ApprovedIngestionLicense,
	type GithubLicenseFile,
	type GithubRepository,
	type IngestionLicense,
} from "./types";

const APPROVED = new Set<string>(APPROVED_INGESTION_LICENSES);

const EXPLICITLY_DISALLOWED_PATTERN =
	/(?:^|[-.])(A?GPL|LGPL)(?:[-.]|$)|GNU\s+(?:AFFERO\s+)?GENERAL\s+PUBLIC/i;

export function isApprovedLicense(
	spdxId: string,
): spdxId is ApprovedIngestionLicense {
	return APPROVED.has(spdxId);
}

export function assertApprovedRepositoryLicense(
	repository: GithubRepository,
): ApprovedIngestionLicense {
	const detected = repository.license;
	if (!detected) {
		throw new IngestionError(
			"LICENSE_MISSING",
			`${repository.fullName} has no detected repository license.`,
			{ repository: repository.fullName },
		);
	}

	const spdxId = detected.spdxId.trim();
	if (!spdxId || spdxId === "NOASSERTION" || spdxId === "OTHER") {
		throw new IngestionError(
			"LICENSE_UNKNOWN",
			`${repository.fullName} does not have a recognized SPDX license.`,
			{ repository: repository.fullName, spdxId },
		);
	}

	if (!isApprovedLicense(spdxId)) {
		const reason = EXPLICITLY_DISALLOWED_PATTERN.test(
			`${spdxId} ${detected.name}`,
		)
			? "copyleft licenses are not approved"
			: "the license is outside the ingestion allowlist";
		throw new IngestionError(
			"LICENSE_DISALLOWED",
			`${repository.fullName} uses ${spdxId}; ${reason}.`,
			{ repository: repository.fullName, spdxId },
		);
	}

	return spdxId;
}

export function assertFileLicenseCompatible(
	content: string,
	repositoryLicense: ApprovedIngestionLicense,
	path: string,
): void {
	const header = content
		.split(/\r?\n/, 80)
		.map((line) => {
			const match = line.match(/SPDX-License-Identifier:\s*(.+)$/i);
			return match?.[1]
				?.replace(/\s*(?:\*\/|-->)\s*$/, "")
				.trim();
		})
		.find((value): value is string => Boolean(value));

	if (!header || header === repositoryLicense) {
		return;
	}

	throw new IngestionError(
		"LICENSE_METADATA_MISMATCH",
		`${path} declares ${header}, which differs from repository license ${repositoryLicense}.`,
		{ path, fileSpdxId: header, repositorySpdxId: repositoryLicense },
	);
}

export function buildIngestionLicense(
	repository: GithubRepository,
	licenseFile: GithubLicenseFile,
	noticeText: string | null,
): IngestionLicense {
	const spdxId = assertApprovedRepositoryLicense(repository);
	if (licenseFile.spdxId !== spdxId) {
		throw new IngestionError(
			"LICENSE_METADATA_MISMATCH",
			`GitHub returned conflicting license metadata for ${repository.fullName}.`,
			{
				repository: repository.fullName,
				repositorySpdxId: spdxId,
				fileSpdxId: licenseFile.spdxId,
			},
		);
	}

	const licenseText = normalizeNotice(licenseFile.text);
	if (!licenseText) {
		throw new IngestionError(
			"LICENSE_NOTICE_MISSING",
			`${repository.fullName} has no readable license notice.`,
			{ repository: repository.fullName, spdxId },
		);
	}

	const notice = normalizeNotice(noticeText ?? "");
	const requiredNotice = [
		`Source repository: ${repository.fullName}`,
		`License: ${spdxId}`,
		"",
		licenseText,
		notice ? `\nNOTICE\n\n${notice}` : "",
	]
		.filter((part) => part !== "")
		.join("\n");

	return {
		spdxId,
		name: licenseFile.name || repository.license?.name || spdxId,
		licenseUrl: licenseFile.htmlUrl,
		requiredNotice,
	};
}

function normalizeNotice(value: string): string {
	return value.replace(/\r\n?/g, "\n").trim();
}
