import type { GenerationGuard } from "../../../lib/ai/abuse-control";
import type { QueryMetadataPort } from "../../../lib/ai/query-metadata";
import type { CreateQueryInput, QueryRecord } from "../../../lib/db/types";
import {
	KqlSyntaxValidationError,
	assertValidKqlSyntax,
	validateKqlSyntax,
} from "../../../lib/kql/syntax-validation";
import { KQL_DIALECTS } from "../../../lib/search/types";

import {
	ApiRouteError,
	apiJson,
	createQuerySchema,
	handleApiError,
	parseJson,
	queryResponse,
	requireSameOrigin,
} from "./_shared";

const MINIMUM_DIALECT_CONFIDENCE = 0.75;

export interface CreateQueryRouteDependencies {
	resolveCurrentUser(request: Request): Promise<{ id: string }>;
	guard: Pick<GenerationGuard, "check">;
	metadata: QueryMetadataPort;
	persist(input: CreateQueryInput): Promise<QueryRecord>;
}

export async function handleCreateQueryRequest(
	request: Request,
	dependencies: CreateQueryRouteDependencies,
): Promise<Response> {
	try {
		requireSameOrigin(request);
		const user = await dependencies.resolveCurrentUser(request);
		const input = await parseJson(request, createQuerySchema);

		assertValidKqlSyntax(input.kql, {
			dialect: input.confirmedDialect,
		});

		await dependencies.guard.check({
			request,
			viewerId: user.id,
			turnstileToken: input.turnstileToken,
			signal: request.signal,
		});

		const metadata = await dependencies.metadata.analyze(
			{
				title: input.title,
				kql: input.kql,
				explanation: input.explanation,
				confirmedDialect: input.confirmedDialect,
			},
			request.signal,
		);

		if (
			!metadata.dialect ||
			metadata.dialectConfidence < MINIMUM_DIALECT_CONFIDENCE
		) {
			throw new ApiRouteError(
				422,
				"dialect_confirmation_required",
				"Choose the KQL dialect so AI can finish the metadata.",
				{ dialects: KQL_DIALECTS },
			);
		}

		const dialectValidation = validateKqlSyntax(input.kql, {
			dialect: metadata.dialect,
		});
		if (!dialectValidation.valid) {
			if (!input.confirmedDialect) {
				throw new ApiRouteError(
					422,
					"dialect_confirmation_required",
					"Choose the KQL dialect, then fix any dialect-specific errors.",
					{
						dialects: KQL_DIALECTS,
						diagnostics: dialectValidation.diagnostics,
					},
				);
			}
			throw new KqlSyntaxValidationError(dialectValidation.diagnostics);
		}

		const query = await dependencies.persist({
			ownerId: user.id,
			title: input.title,
			kql: input.kql,
			description: input.explanation.slice(0, 10_000),
			explanation: input.explanation,
			dialect: metadata.dialect,
			visibility: input.visibility,
			tables: metadata.tables,
			operators: metadata.operators,
			tags: metadata.tags,
		});

		return apiJson(queryResponse(query), 201);
	} catch (error) {
		return handleApiError(error);
	}
}
