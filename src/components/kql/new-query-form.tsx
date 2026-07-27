"use client";

import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import {
	SegmentedControl,
	SegmentedControlItem,
} from "@astryxdesign/core/SegmentedControl";
import { Selector } from "@astryxdesign/core/Selector";
import { TextArea } from "@astryxdesign/core/TextArea";
import { TextInput } from "@astryxdesign/core/TextInput";
import { authClient, useSession } from "@/lib/auth/client";
import type { KqlDialect, QueryVisibility } from "@/lib/search/types";
import { useRouter } from "next/navigation";
import * as stylex from "@stylexjs/stylex";
import { type FormEvent, useMemo, useState } from "react";

import { styles } from "@/styles/kql.stylex";
import { DIALECT_OPTIONS } from "./sample-data";
import { TurnstileChallenge } from "./turnstile-challenge";

const TURNSTILE_SITE_KEY =
	process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY?.trim() ?? "";

type KqlSyntaxDiagnostic = {
	code?: string;
	message: string;
	line: number;
	column: number;
};

function parseKqlSyntaxDiagnostics(value: unknown): KqlSyntaxDiagnostic[] {
	if (!Array.isArray(value)) {
		return [];
	}

	return value.flatMap((item) => {
		if (
			typeof item !== "object" ||
			item === null ||
			typeof Reflect.get(item, "message") !== "string"
		) {
			return [];
		}

		const line = Reflect.get(item, "line");
		const column = Reflect.get(item, "column");
		if (
			typeof line !== "number" ||
			!Number.isFinite(line) ||
			typeof column !== "number" ||
			!Number.isFinite(column)
		) {
			return [];
		}

		const code = Reflect.get(item, "code");
		return [{
			...(typeof code === "string" ? { code } : {}),
			message: Reflect.get(item, "message") as string,
			line,
			column,
		}];
	});
}

const starterKql = `SigninLogs
| where TimeGenerated > ago(1h)
| where ResultType != 0
| summarize FailedAttempts = count() by UserPrincipalName
| where FailedAttempts >= 8
| order by FailedAttempts desc`;

export function NewQueryForm() {
	const router = useRouter();
	const { data: session, isPending: sessionPending } = useSession();
	const [title, setTitle] = useState("");
	const [explanation, setExplanation] = useState("");
	const [kql, setKql] = useState(starterKql);
	const [visibility, setVisibility] = useState<QueryVisibility>("private");
	const [confirmedDialect, setConfirmedDialect] = useState<
		KqlDialect | undefined
	>();
	const [needsDialect, setNeedsDialect] = useState(false);
	const [needsChallenge, setNeedsChallenge] = useState(false);
	const [challengeKey, setChallengeKey] = useState(0);
	const [isSaving, setIsSaving] = useState(false);
	const [error, setError] = useState("");
	const [syntaxDiagnostics, setSyntaxDiagnostics] = useState<
		KqlSyntaxDiagnostic[]
	>([]);

	const warnings = useMemo(() => {
		const findings: string[] = [];
		if (/(AccountKey|client_secret|api[_-]?key|Bearer\s+[A-Za-z0-9._-]+)/i.test(kql)) {
			findings.push("The query may contain a credential or token.");
		}
		return findings;
	}, [kql]);

	const changeContent = (change: () => void) => {
		change();
		setConfirmedDialect(undefined);
		setNeedsDialect(false);
		setNeedsChallenge(false);
		setError("");
		setSyntaxDiagnostics([]);
	};

	const login = async () => {
		await authClient.signIn.social({
			provider: "github",
			callbackURL: "/new",
		});
	};

	const submitQuery = async (turnstileToken?: string) => {
		setError("");
		setSyntaxDiagnostics([]);
		if (turnstileToken) {
			setNeedsChallenge(false);
		}
		setIsSaving(true);

		try {
			const response = await fetch("/api/queries", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Accept: "application/json",
				},
				body: JSON.stringify({
					title,
					kql,
					explanation,
					visibility,
					aiMetadataAcknowledged: true,
					...(confirmedDialect ? { confirmedDialect } : {}),
					...(turnstileToken ? { turnstileToken } : {}),
				}),
			});
			const payload = (await response.json()) as {
				data?: { id?: string };
				error?: {
					code?: string;
					message?: string;
					details?: {
						challengeRequired?: boolean;
						diagnostics?: unknown;
					};
				};
			};
			const responseDiagnostics = parseKqlSyntaxDiagnostics(
				payload.error?.details?.diagnostics,
			);

			if (response.status === 401) {
				await login();
				return;
			}
			if (
				!response.ok &&
				payload.error?.details?.challengeRequired === true
			) {
				setNeedsChallenge(true);
				setChallengeKey((value) => value + 1);
				setError(
					TURNSTILE_SITE_KEY
						? "Complete verification to generate metadata and save this query."
						: "Verification is required, but NEXT_PUBLIC_TURNSTILE_SITE_KEY is not configured.",
				);
				return;
			}
			if (
				response.status === 422 &&
				payload.error?.code === "dialect_confirmation_required"
			) {
				setNeedsDialect(true);
				setSyntaxDiagnostics(responseDiagnostics);
				setError(
					payload.error.message ??
						"Choose the KQL dialect, then try saving again.",
				);
				return;
			}
			if (
				response.status === 422 &&
				payload.error?.code === "invalid_kql"
			) {
				setSyntaxDiagnostics(responseDiagnostics);
				setError(
					payload.error.message ??
						"Fix the KQL errors, then try saving again.",
				);
				return;
			}
			if (!response.ok || !payload.data?.id) {
				setSyntaxDiagnostics(responseDiagnostics);
				throw new Error(payload.error?.message ?? "The query could not be saved.");
			}

			router.push(`/queries/${payload.data.id}`);
			router.refresh();
		} catch (saveError) {
			setError(
				saveError instanceof Error
					? saveError.message
					: "The query could not be saved.",
			);
		} finally {
			setIsSaving(false);
		}
	};

	const save = async (event: FormEvent) => {
		event.preventDefault();
		await submitQuery();
	};

	const acceptTurnstileToken = (token: string) => {
		if (token) {
			void submitQuery(token);
		}
	};

	const handleTurnstileError = (message: string) => {
		setError(message);
	};

	if (sessionPending) {
		return (
			<div {...stylex.props(styles.formPage)}>
				<h1 {...stylex.props(styles.collectionTitle)}>New query</h1>
				<p {...stylex.props(styles.collectionDescription)}>Checking your session.</p>
			</div>
		);
	}

	if (!session?.user) {
		return (
			<div {...stylex.props(styles.formPage)}>
				<div {...stylex.props(styles.emptyWrap)}>
					<EmptyState
						headingLevel={1}
						title="Login to add a query"
						description="GitHub login connects each query to its owner and keeps new queries private by default."
						actions={<Button label="Continue with GitHub" variant="primary" onClick={login} />}
					/>
				</div>
			</div>
		);
	}

	return (
		<div {...stylex.props(styles.formPage)}>
			<header>
				<h1 {...stylex.props(styles.collectionTitle)}>New query</h1>
				<p {...stylex.props(styles.collectionDescription)}>
					Add the KQL and explain its purpose. Syntax, query shape, and
					supported dialect rules are checked before save.
				</p>
			</header>

			<form onSubmit={save} {...stylex.props(styles.formCard, styles.formGrid)}>
				<div {...stylex.props(styles.visibilityRow)}>
					<div>
						<div {...stylex.props(styles.visibilityLabel)}>Visibility</div>
						<p {...stylex.props(styles.visibilityDescription)}>
							{visibility === "public"
								? "Published immediately and visible in public search."
								: "Only you can find or open this query."}
						</p>
					</div>
					<SegmentedControl
						label="Query visibility"
						value={visibility}
						onChange={(value) =>
							setVisibility(value === "public" ? "public" : "private")
						}
						layout="fill"
					>
						<SegmentedControlItem value="private" label="Private" />
						<SegmentedControlItem value="public" label="Public" />
					</SegmentedControl>
				</div>

				{needsDialect ? (
					<Selector
						label="KQL dialect"
						description="AI could not identify this confidently."
						options={DIALECT_OPTIONS}
						value={confirmedDialect}
						onChange={(value) => {
							setConfirmedDialect(value as KqlDialect);
							setError("");
							setSyntaxDiagnostics([]);
						}}
						placeholder="Choose a dialect"
						isRequired
						width="100%"
					/>
				) : null}

				<TextInput
					label="Title"
					value={title}
					onChange={(value) => changeContent(() => setTitle(value))}
					placeholder="Describe the investigation outcome"
					isRequired
					width="100%"
				/>

				<TextArea
					label="KQL"
					value={kql}
					onChange={(value) => changeContent(() => setKql(value))}
					rows={14}
					hasSpellCheck={false}
					isRequired
					maxLength={100_000}
					width="100%"
					status={
						syntaxDiagnostics.length
							? {
									type: "error",
									message: `Fix ${syntaxDiagnostics.length} ${syntaxDiagnostics.length === 1 ? "KQL error" : "KQL errors"} before saving.`,
								}
							: undefined
					}
				/>

				<TextArea
					label="Explanation"
					value={explanation}
					onChange={(value) => changeContent(() => setExplanation(value))}
					rows={5}
					placeholder="What the query finds, how to interpret it, and likely false positives."
					isOptional
					maxLength={20_000}
					width="100%"
				/>

				{warnings.length ? (
					<Banner
						status="warning"
						title={`${warnings.length} nonblocking ${warnings.length === 1 ? "warning" : "warnings"}`}
						description="You can still save or publish. Review these items first when possible."
						defaultIsExpanded
					>
						<ul>
							{warnings.map((warning) => (
								<li key={warning}>{warning}</li>
							))}
						</ul>
					</Banner>
				) : null}

				{error ? (
					<Banner
						status="error"
						title="The query was not saved"
						description={error}
						isDismissable
						onDismiss={() => {
							setError("");
							setSyntaxDiagnostics([]);
						}}
					>
						{syntaxDiagnostics.length ? (
							<ul>
								{syntaxDiagnostics.map((diagnostic, index) => (
									<li
										key={`${diagnostic.line}:${diagnostic.column}:${diagnostic.code ?? index}`}
									>
										Line {diagnostic.line}, column {diagnostic.column}:{" "}
										{diagnostic.message}
									</li>
								))}
							</ul>
						) : null}
					</Banner>
				) : null}

				{needsChallenge && TURNSTILE_SITE_KEY ? (
					<TurnstileChallenge
						key={challengeKey}
						siteKey={TURNSTILE_SITE_KEY}
						onToken={acceptTurnstileToken}
						onError={handleTurnstileError}
						title="Verify this save"
						description="Complete Cloudflare verification. Metadata generation retries when a token is ready."
					/>
				) : null}

				<p {...stylex.props(styles.aiProcessingDisclosure)}>
					The query is parsed but not executed. Tenant tables, columns,
					functions, and permissions are not verified. The title, KQL, and
					explanation are sent directly to the DeepSeek API to identify the
					dialect, tables, and tags, including for private queries.
				</p>

				<div {...stylex.props(styles.formActions)}>
					<Button label="Cancel" variant="ghost" href="/" />
					<Button
						label="Save query"
						variant="primary"
						type="submit"
						isLoading={isSaving}
						isDisabled={
							!title.trim() ||
							!kql.trim() ||
							(needsDialect && !confirmedDialect)
						}
					/>
				</div>
			</form>
		</div>
	);
}
