"use client";

import { Badge } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { CodeBlock } from "@astryxdesign/core/CodeBlock";
import { Icon } from "@astryxdesign/core/Icon";
import { useToast } from "@astryxdesign/core/Toast";
import Link from "next/link";
import * as stylex from "@stylexjs/stylex";
import { useEffect, useState } from "react";

import { tokenizeKql } from "@/lib/kql/tokenize";
import { styles } from "@/styles/kql.stylex";
import { queryTableSummary } from "./query-table-summary";
import type { QueryRecord } from "./sample-data";

type QueryInspectorProps = {
	query: QueryRecord;
	onClose?: () => void;
	isPublicPage?: boolean;
};

function GithubGlyph() {
	return (
		<svg
			aria-hidden="true"
			focusable="false"
			height="16"
			viewBox="0 0 24 24"
			width="16"
		>
			<path
				d="M12 2.25a9.75 9.75 0 0 0-3.08 19c.49.09.67-.21.67-.47v-1.71c-2.72.59-3.3-1.16-3.3-1.16-.44-1.13-1.09-1.43-1.09-1.43-.89-.61.07-.6.07-.6.98.07 1.5 1.01 1.5 1.01.88 1.5 2.3 1.07 2.86.82.09-.63.34-1.07.62-1.31-2.17-.25-4.46-1.09-4.46-4.82 0-1.07.38-1.94 1.01-2.62-.1-.25-.44-1.24.1-2.58 0 0 .82-.26 2.68 1a9.3 9.3 0 0 1 4.88 0c1.86-1.26 2.68-1 2.68-1 .54 1.34.2 2.33.1 2.58.63.68 1.01 1.55 1.01 2.62 0 3.74-2.29 4.57-4.47 4.81.35.3.66.9.66 1.82v2.52c0 .26.18.57.67.47A9.75 9.75 0 0 0 12 2.25Z"
				fill="currentColor"
			/>
		</svg>
	);
}

function HeartGlyph({ isFilled }: { isFilled: boolean }) {
	return (
		<svg
			aria-hidden="true"
			focusable="false"
			height="16"
			viewBox="0 0 24 24"
			width="16"
		>
			<path
				d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78L12 21.23l8.84-8.84a5.5 5.5 0 0 0 0-7.78Z"
				fill={isFilled ? "currentColor" : "none"}
				stroke="currentColor"
				strokeLinejoin="round"
				strokeWidth="1.75"
			/>
		</svg>
	);
}

const compactNumber = new Intl.NumberFormat("en-US", {
	notation: "compact",
	maximumFractionDigits: 1,
});
const fullNumber = new Intl.NumberFormat("en-US");

type GithubStarState = {
	repository: string;
	status: "loading" | "available" | "unavailable";
	count?: number;
};

function githubRepositoryApiUrl(repository: string): string | null {
	const parts = repository.split("/");
	if (parts.length !== 2 || !parts[0] || !parts[1]) {
		return null;
	}

	return `https://api.github.com/repos/${encodeURIComponent(parts[0])}/${encodeURIComponent(parts[1])}`;
}

export function QueryInspector({
	query,
	onClose,
	isPublicPage = false,
}: QueryInspectorProps) {
	const [isSaved, setIsSaved] = useState(query.starredByViewer ?? false);
	const [status, setStatus] = useState("");
	const [isSavePending, setIsSavePending] = useState(false);
	const toast = useToast();
	const githubRepositoryUrl =
		query.sourceRepositoryUrl ??
		(query.sourceProvider === "github" && query.sourceRepository
			? `https://github.com/${query.sourceRepository}`
			: undefined);
	const githubApiUrl =
		query.sourceProvider === "github" && query.sourceRepository
			? githubRepositoryApiUrl(query.sourceRepository)
			: null;
	const [githubStarState, setGithubStarState] = useState<GithubStarState>(() => ({
		repository: query.sourceRepository ?? "",
		status: githubApiUrl ? "loading" : "unavailable",
	}));
	const currentGithubStarState =
		githubStarState.repository === query.sourceRepository
			? githubStarState
			: {
					repository: query.sourceRepository ?? "",
					status: githubApiUrl ? ("loading" as const) : ("unavailable" as const),
				};

	useEffect(() => {
		const repository = query.sourceRepository ?? "";
		if (!githubApiUrl) {
			return;
		}

		const controller = new AbortController();
		void fetch(githubApiUrl, {
			headers: {
				Accept: "application/vnd.github+json",
			},
			signal: controller.signal,
		})
			.then(async (response) => {
				if (!response.ok) {
					throw new Error(`GitHub returned ${response.status}.`);
				}

				const payload: unknown = await response.json();
				if (!payload || typeof payload !== "object") {
					throw new Error("GitHub returned invalid repository metadata.");
				}

				const count = (payload as Record<string, unknown>).stargazers_count;
				if (!Number.isSafeInteger(count) || (count as number) < 0) {
					throw new Error("GitHub returned an invalid star count.");
				}

				setGithubStarState({
					repository,
					status: "available",
					count: count as number,
				});
			})
			.catch((error: unknown) => {
				if (error instanceof DOMException && error.name === "AbortError") {
					return;
				}
				setGithubStarState({
					repository,
					status: "unavailable",
				});
			});

		return () => controller.abort();
	}, [githubApiUrl, query.sourceRepository]);

	const githubStarCount =
		currentGithubStarState.status === "available"
			? currentGithubStarState.count
			: undefined;
	const githubStarText =
		githubStarCount === undefined
			? currentGithubStarState.status === "loading"
				? "..."
				: "--"
			: compactNumber.format(githubStarCount);
	const githubStarLabel =
		githubStarCount === undefined
			? currentGithubStarState.status === "loading"
				? "GitHub star count loading"
				: "GitHub star count unavailable"
			: `${fullNumber.format(githubStarCount)} GitHub stars`;

	const copyQuery = async () => {
		try {
			await navigator.clipboard.writeText(query.kql);
			setStatus("Query copied to clipboard.");
		} catch {
			setStatus("Copy failed. Select the query text and copy it manually.");
		}
	};

	const toggleSave = async () => {
		if (query.visibility !== "public" || isSavePending) {
			return;
		}

		const wasSaved = isSaved;
		setIsSavePending(true);
		try {
			const response = await fetch(`/api/queries/${query.id}/star`, {
				method: wasSaved ? "DELETE" : "POST",
				headers: {
					"Content-Type": "application/json",
				},
			});

			if (response.status === 401) {
				const loginMessage = "Log in with GitHub to save this query.";
				toast({
					body: loginMessage,
					isAutoHide: false,
					type: "info",
					uniqueID: "save-login-required",
				});
				return;
			}
			if (!response.ok) {
				throw new Error("Save request failed.");
			}

			setIsSaved(!wasSaved);
			setStatus(wasSaved ? "Removed from Saved." : "Query saved.");
		} catch {
			setStatus("The saved query could not be updated. Try again.");
		} finally {
			setIsSavePending(false);
		}
	};

	const reportQuery = async () => {
		const confirmed = window.confirm(
			"Report this public query for review by a moderator?",
		);
		if (!confirmed) {
			return;
		}

		try {
			const response = await fetch(`/api/queries/${query.id}/report`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					reason: "other",
					details: "Submitted from the query detail page.",
				}),
			});
			if (response.status === 401) {
				setStatus("Login with GitHub to report a query.");
				return;
			}
			if (!response.ok) {
				throw new Error("Report request failed.");
			}
			setStatus("Report sent for moderator review.");
		} catch {
			setStatus("The report could not be sent. Try again.");
		}
	};

	return (
		<div {...stylex.props(isPublicPage ? styles.publicPage : styles.inspectorInner)}>
			{isPublicPage ? (
				<div {...stylex.props(styles.breadcrumb)}>
					<Link href="/">Search</Link>
					{" / "}
					<span aria-current="page">{query.title}</span>
				</div>
			) : null}
			<div {...stylex.props(styles.inspectorHeader)}>
				<div>
					<div {...stylex.props(styles.metadataLine)}>
						{query.visibility === "private" ? (
							<Badge label="Private" variant="neutral" />
						) : null}
						<Badge label={query.dialectLabel} variant="blue" />
						{query.aiGenerated ? (
							<Badge label="AI generated" variant="purple" />
						) : null}
					</div>
					<h1 {...stylex.props(styles.inspectorTitle)}>{query.title}</h1>
					<div {...stylex.props(styles.metadataLine)}>
						<span>Updated {query.updatedAt}</span>
					</div>
				</div>
				<div
					{...stylex.props(
						styles.inspectorActions,
						styles.inspectorHeaderActions,
					)}
				>
					{query.sourceProvider === "github" && query.sourceRepository ? (
						<div {...stylex.props(styles.githubOrigin)}>
							{githubRepositoryUrl ? (
								<a
									aria-label={`View ${query.sourceRepository} on GitHub. ${githubStarLabel}.`}
									href={githubRepositoryUrl}
									rel="noopener noreferrer"
									target="_blank"
									{...stylex.props(styles.githubRepositoryLink)}
								>
									<GithubGlyph />
									<span
										title={query.sourceRepository}
										{...stylex.props(styles.githubRepositoryName)}
									>
										{query.sourceRepository}
									</span>
									<span
										aria-live="polite"
										title={githubStarLabel}
										{...stylex.props(styles.githubStarCount)}
									>
										{githubStarText}
									</span>
								</a>
							) : null}
						</div>
					) : null}
					{onClose ? (
						<Button
							label="Close query details"
							variant="ghost"
							size="sm"
							isIconOnly
							icon={<Icon icon="close" />}
							onClick={onClose}
						/>
					) : null}
				</div>
			</div>

			{query.aiGenerated ? (
				<div {...stylex.props(styles.aiNotice)}>
					<Banner
						status="warning"
						title="Generated after retrieval found no adequate match"
						description="This query was generated by AI and was not executed or verified."
					/>
				</div>
			) : null}

			<section {...stylex.props(styles.querySection)} aria-labelledby="query-code-title">
				<h2 id="query-code-title" {...stylex.props(styles.sectionHeading)}>
					Query
				</h2>
				<CodeBlock
					code={query.kql}
					language="kql"
					hasLanguageLabel={false}
					hasCopyButton
					onCopy={copyQuery}
					isWrapped
					tokenizer={tokenizeKql}
					highlightMode="spans"
					width="100%"
					maxHeight={520}
				/>
			</section>

			<section {...stylex.props(styles.querySection)} aria-labelledby="explanation-title">
				<h2 id="explanation-title" {...stylex.props(styles.sectionHeading)}>
					What it does
				</h2>
				<p {...stylex.props(styles.explanation)}>{query.explanation}</p>
			</section>

			{query.assumptions?.length ? (
				<section {...stylex.props(styles.querySection)} aria-labelledby="assumptions-title">
					<h2 id="assumptions-title" {...stylex.props(styles.sectionHeading)}>
						Assumptions
					</h2>
					<ul>
						{query.assumptions.map((assumption) => (
							<li key={assumption}>{assumption}</li>
						))}
					</ul>
				</section>
			) : null}

			<section
				aria-label="Tables"
				{...stylex.props(styles.querySection, styles.tableSummary)}
			>
				<div {...stylex.props(styles.detailLabel)}>Tables</div>
				<p {...stylex.props(styles.detailValue)}>
					{queryTableSummary(query)}
				</p>
			</section>

			<section {...stylex.props(styles.querySection)} aria-labelledby="query-tags-title">
				<h2 id="query-tags-title" {...stylex.props(styles.sectionHeading)}>
					Tags
				</h2>
				<div {...stylex.props(styles.tagList)}>
					{query.tags.map((tag) => (
						<Badge key={tag} label={tag} />
					))}
				</div>
			</section>

			<div {...stylex.props(styles.inspectorActions)}>
				{query.visibility === "public" ? (
					<Button
						label={isSaved ? "Saved" : "Save query"}
						variant={isSaved ? "primary" : "secondary"}
						icon={<HeartGlyph isFilled={isSaved} />}
						isLoading={isSavePending}
						onClick={toggleSave}
					/>
				) : null}
				{query.visibility === "public" ? (
					<Button label="Report" variant="ghost" onClick={reportQuery} />
				) : null}
			</div>

			<p aria-live="polite" {...stylex.props(styles.visuallyHidden)}>
				{status}
			</p>
		</div>
	);
}
