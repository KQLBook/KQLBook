"use client";

import { Badge } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Icon } from "@astryxdesign/core/Icon";
import { authClient, useSession } from "@/lib/auth/client";
import * as stylex from "@stylexjs/stylex";
import { useEffect, useState } from "react";

import { styles } from "@/styles/kql.stylex";
import { dialectLabel } from "./sample-data";

type CollectionKind = "owned" | "starred" | "history";

type CollectionQuery = {
	id: string;
	title: string;
	description: string;
	dialect: string;
	visibility: "public" | "private";
	starCount: number;
	updatedAt: string;
	tables: string[];
};

type HistoryRecord = {
	id: string;
	queryText: string;
	mode: string;
	resultCount: number;
	createdAt: string;
};

const content: Record<
	CollectionKind,
	{ title: string; description: string; endpoint: string }
> = {
	owned: {
		title: "My Queries",
		description:
			"Queries you authored or saved. Private records stay out of public search and sitemaps.",
		endpoint: "/api/queries?limit=25",
	},
	starred: {
		title: "Saved",
		description: "Public queries you saved for quick access.",
		endpoint: "/api/queries/starred?limit=25",
	},
	history: {
		title: "History",
		description:
			"Your signed-in searches, retrieval mode, and result count. Clear them whenever you want.",
		endpoint: "/api/history?limit=25",
	},
};

function extractItems(value: unknown): unknown[] {
	if (Array.isArray(value)) {
		return value;
	}
	if (value && typeof value === "object") {
		const object = value as Record<string, unknown>;
		if (Array.isArray(object.items)) {
			return object.items;
		}
		if (Array.isArray(object.queries)) {
			return object.queries;
		}
		if (Array.isArray(object.history)) {
			return object.history;
		}
	}
	return [];
}

function asCollectionQuery(value: unknown): CollectionQuery | null {
	if (!value || typeof value !== "object") {
		return null;
	}
	const item = value as Record<string, unknown>;
	if (typeof item.id !== "string" || typeof item.title !== "string") {
		return null;
	}
	const description =
		typeof item.description === "string" && item.description.trim()
			? item.description
			: typeof item.explanation === "string" && item.explanation.trim()
				? item.explanation
				: "Open the query to review its KQL and provenance.";
	return {
		id: item.id,
		title: item.title,
		description,
		dialect: typeof item.dialect === "string" ? item.dialect : "sentinel",
		visibility: item.visibility === "public" ? "public" : "private",
		starCount: typeof item.starCount === "number" ? item.starCount : 0,
		updatedAt:
			typeof item.updatedAt === "string" ? item.updatedAt : "Recently updated",
		tables: Array.isArray(item.tables)
			? item.tables.filter((entry): entry is string => typeof entry === "string")
			: [],
	};
}

function asHistoryRecord(value: unknown, index: number): HistoryRecord | null {
	if (!value || typeof value !== "object") {
		return null;
	}
	const item = value as Record<string, unknown>;
	const queryText =
		typeof item.rawRequest === "string"
			? item.rawRequest
			: typeof item.queryText === "string"
				? item.queryText
				: typeof item.query === "string"
					? item.query
					: null;
	if (!queryText) {
		return null;
	}
	return {
		id: typeof item.id === "string" ? item.id : `${queryText}-${index}`,
		queryText,
		mode:
			typeof item.retrievalMode === "string"
				? item.retrievalMode
				: typeof item.mode === "string"
					? item.mode
					: "hybrid",
		resultCount: typeof item.resultCount === "number" ? item.resultCount : 0,
		createdAt: typeof item.createdAt === "string" ? item.createdAt : "Recently",
	};
}

export function CollectionPage({ kind }: { kind: CollectionKind }) {
	const page = content[kind];
	const { data: session, isPending: sessionPending } = useSession();
	const [queries, setQueries] = useState<CollectionQuery[]>([]);
	const [history, setHistory] = useState<HistoryRecord[]>([]);
	const [isLoading, setIsLoading] = useState(false);
	const [error, setError] = useState("");

	useEffect(() => {
		if (!session?.user) {
			return;
		}
		const controller = new AbortController();

		const load = async () => {
			setIsLoading(true);
			setError("");
			try {
				const response = await fetch(page.endpoint, {
					headers: { Accept: "application/json" },
					signal: controller.signal,
				});
				const payload = (await response.json()) as {
					data?: unknown;
					error?: { message?: string };
				};
				if (!response.ok) {
					throw new Error(payload.error?.message ?? "The collection could not be loaded.");
				}
				const items = extractItems(payload.data);
				if (kind === "history") {
					setHistory(
						items
							.map(asHistoryRecord)
							.filter((item): item is HistoryRecord => item !== null),
					);
				} else {
					setQueries(
						items
							.map(asCollectionQuery)
							.filter((item): item is CollectionQuery => item !== null),
					);
				}
			} catch (loadError) {
				if (controller.signal.aborted) {
					return;
				}
				setError(
					loadError instanceof Error
						? loadError.message
						: "The collection could not be loaded.",
				);
			} finally {
				if (!controller.signal.aborted) {
					setIsLoading(false);
				}
			}
		};

		void load();
		return () => controller.abort();
	}, [kind, page.endpoint, session?.user]);

	const login = async () => {
		await authClient.signIn.social({
			provider: "github",
			callbackURL:
				kind === "owned" ? "/my-queries" : kind === "starred" ? "/saved" : "/history",
		});
	};

	const clearHistory = async () => {
		const confirmed = window.confirm("Clear your full search history?");
		if (!confirmed) {
			return;
		}
		try {
			const response = await fetch("/api/history", { method: "DELETE" });
			if (!response.ok) {
				throw new Error("History could not be cleared.");
			}
			setHistory([]);
		} catch (clearError) {
			setError(
				clearError instanceof Error ? clearError.message : "History could not be cleared.",
			);
		}
	};

	if (sessionPending) {
		return (
			<div {...stylex.props(styles.collectionPage)}>
				<h1 {...stylex.props(styles.collectionTitle)}>{page.title}</h1>
				<p {...stylex.props(styles.collectionDescription)}>Checking your session.</p>
			</div>
		);
	}

	if (!session?.user) {
		return (
			<div {...stylex.props(styles.collectionPage)}>
				<div {...stylex.props(styles.emptyWrap)}>
					<EmptyState
						headingLevel={1}
						title={
							kind === "starred"
								? "Login to view saved queries"
								: `Login to open ${page.title.toLocaleLowerCase("en-US")}`
						}
						description={
							kind === "starred"
								? "GitHub login keeps your saved public queries tied to your account."
								: "GitHub login keeps your private queries and search history tied to your account."
						}
						actions={<Button label="Continue with GitHub" variant="primary" onClick={login} />}
					/>
				</div>
			</div>
		);
	}

	const isEmpty = kind === "history" ? history.length === 0 : queries.length === 0;

	return (
		<div {...stylex.props(styles.collectionPage)}>
			<header {...stylex.props(styles.collectionHeader)}>
				<div>
					<div {...stylex.props(styles.eyebrow)}>{session.user.name}</div>
					<h1 {...stylex.props(styles.collectionTitle)}>{page.title}</h1>
					<p {...stylex.props(styles.collectionDescription)}>{page.description}</p>
				</div>
				{kind === "owned" ? (
					<Button label="New query" variant="primary" href="/new" />
				) : kind === "history" && history.length ? (
					<Button label="Clear history" variant="secondary" onClick={clearHistory} />
				) : null}
			</header>

			{error ? (
				<Banner
					status="error"
					title="This page could not be refreshed"
					description={error}
					isDismissable
					onDismiss={() => setError("")}
				/>
			) : null}

			{isLoading ? (
				<div {...stylex.props(styles.emptyWrap)}>
					<EmptyState
						title={
							kind === "starred"
								? "Loading saved queries"
								: `Loading ${page.title.toLocaleLowerCase("en-US")}`
						}
						description="Fetching your account records."
						isCompact
					/>
				</div>
			) : isEmpty ? (
				<div {...stylex.props(styles.emptyWrap)}>
					<EmptyState
						headingLevel={2}
						title={
							kind === "owned"
								? "No saved queries"
								: kind === "starred"
									? "No saved queries"
									: "No search history"
						}
						description={
							kind === "owned"
								? "Create a private query or save an AI-generated candidate."
								: kind === "starred"
									? "Select the heart on a public query to save it here."
									: "Signed-in searches will appear here."
						}
						icon={<Icon icon={kind === "history" ? "clock" : "search"} size="lg" />}
						actions={
							kind === "owned" ? (
								<Button label="Create a query" variant="primary" href="/new" />
							) : (
								<Button label="Search queries" variant="secondary" href="/" />
							)
						}
					/>
				</div>
			) : kind === "history" ? (
				<div {...stylex.props(styles.panel)}>
					<div {...stylex.props(styles.panelHeader)}>
						<h2 {...stylex.props(styles.panelTitle)}>Recent searches</h2>
						<Badge label={`${history.length} stored`} />
					</div>
					{history.map((entry) => (
						<div key={entry.id} {...stylex.props(styles.historyRow)}>
							<div>
								<p {...stylex.props(styles.historyQuery)}>{entry.queryText}</p>
								<p {...stylex.props(styles.historyMeta)}>
									{entry.mode} retrieval / {entry.resultCount} results
								</p>
							</div>
							<Button
								label="Search again"
								variant="ghost"
								size="sm"
								href={`/?q=${encodeURIComponent(entry.queryText)}`}
							/>
						</div>
					))}
				</div>
			) : (
				<div {...stylex.props(styles.resultList)}>
					{queries.map((query) => (
						<a
							key={query.id}
							href={`/queries/${query.id}`}
							{...stylex.props(styles.resultRow)}
						>
							<div {...stylex.props(styles.resultTopline)}>
								<h2 {...stylex.props(styles.resultTitle)}>{query.title}</h2>
								{query.visibility === "private" ? (
									<Badge label="Private" variant="neutral" />
								) : null}
							</div>
							<p {...stylex.props(styles.resultSnippet)}>{query.description}</p>
							<div {...stylex.props(styles.metadataLine)}>
								<span>{dialectLabel(query.dialect)}</span>
								{query.tables.length ? (
									<>
										<span {...stylex.props(styles.metaSeparator)} aria-hidden="true">
											/
										</span>
										<span>{query.tables.slice(0, 3).join(", ")}</span>
									</>
								) : null}
								<span {...stylex.props(styles.metaSeparator)} aria-hidden="true">
									/
								</span>
								<span>
									{query.starCount} {kind === "starred" ? "saves" : "stars"}
								</span>
							</div>
						</a>
					))}
				</div>
			)}
		</div>
	);
}
