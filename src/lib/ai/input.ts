import {
	isKqlDialect,
	isRecord,
	parseSearchBody,
	SearchInputError,
} from "../search/normalize";
import type { KqlDialect } from "../search/types";
import type { GenerationBody } from "./types";

const MAX_TURNSTILE_TOKEN_LENGTH = 2_048;
const GENERATION_FIELDS = new Set([
	"q",
	"dialects",
	"tables",
	"operators",
	"tags",
	"authors",
	"sources",
	"cursor",
	"limit",
	"dialect",
	"privateProcessingAcknowledged",
	"turnstileToken",
]);

export function parseGenerationBody(value: unknown): GenerationBody {
	if (!isRecord(value)) {
		throw new SearchInputError("invalid_body", "Request body must be a JSON object.");
	}
	const unknownFields = Object.keys(value).filter((field) => !GENERATION_FIELDS.has(field));
	if (unknownFields.length > 0) {
		throw new SearchInputError(
			"unknown_fields",
			`Unknown request fields: ${unknownFields.join(", ")}.`,
		);
	}

	const request = parseSearchBody(value);
	let targetDialect: KqlDialect | null = null;

	if (value.dialect !== undefined && value.dialect !== null) {
		if (!isKqlDialect(value.dialect)) {
			throw new SearchInputError("invalid_dialect", "dialect is invalid.", "dialect");
		}
		targetDialect = value.dialect;
	} else if (request.dialects.length === 1) {
		targetDialect = request.dialects[0];
	} else if (request.dialects.length > 1) {
		throw new SearchInputError(
			"dialect_required",
			"Choose one dialect for AI generation.",
			"dialect",
		);
	}

	if (
		value.privateProcessingAcknowledged !== undefined &&
		typeof value.privateProcessingAcknowledged !== "boolean"
	) {
		throw new SearchInputError(
			"invalid_acknowledgement",
			"privateProcessingAcknowledged must be a boolean.",
			"privateProcessingAcknowledged",
		);
	}

	let turnstileToken: string | undefined;
	if (value.turnstileToken !== undefined && value.turnstileToken !== null) {
		if (
			typeof value.turnstileToken !== "string" ||
			!value.turnstileToken ||
			value.turnstileToken.length > MAX_TURNSTILE_TOKEN_LENGTH
		) {
			throw new SearchInputError(
				"invalid_turnstile_token",
				"turnstileToken is invalid.",
				"turnstileToken",
			);
		}
		turnstileToken = value.turnstileToken;
	}

	return {
		request,
		targetDialect,
		privateProcessingAcknowledged: value.privateProcessingAcknowledged === true,
		turnstileToken,
	};
}
