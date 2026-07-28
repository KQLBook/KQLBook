"use client";

import { Badge } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { ChatComposer } from "@astryxdesign/core/Chat";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Icon } from "@astryxdesign/core/Icon";
import Link from "next/link";
import { useRouter } from "next/navigation";
import * as stylex from "@stylexjs/stylex";
import {
	type CSSProperties,
	type FormEvent,
	type MouseEvent,
	type TransitionEvent,
	type UIEvent,
	useCallback,
	useEffect,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";

import type { CursorPage, QueryListItem } from "@/lib/db/types";
import { styles } from "@/styles/kql.stylex";
import { useSearchHeaderController } from "./app-frame";
import { BrandLogo } from "./brand-logo";
import {
	DIALECT_OPTIONS,
	SAMPLE_QUERIES,
	dialectLabel,
	mapStoredQuery,
	type KqlDialect,
	type QueryRecord,
} from "./sample-data";
import { QueryInspector } from "./query-inspector";
import { TurnstileChallenge } from "./turnstile-challenge";

const TURNSTILE_SITE_KEY =
	process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY?.trim() ?? "";
const DEVICE_ID_STORAGE_KEY = "kqlbook.device-id.v1";
const POPULAR_PAGE_SIZE = 20;
const POPULAR_LOAD_THRESHOLD = 640;
const LANDING_SEARCH_FADE_DISTANCE = 240;
const MOBILE_INSPECTOR_MEDIA_QUERY = "(max-width: 760px)";
const LANDING_COMPOSER_STYLE: CSSProperties &
	Record<
		"--_chat-composer-radius" | "--_chat-composer-padding",
		string
	> = {
	"--_chat-composer-radius": "24px",
	"--_chat-composer-padding": "8px",
};

function subscribeToMobileInspectorViewport(onChange: () => void) {
	const mediaQuery = window.matchMedia(MOBILE_INSPECTOR_MEDIA_QUERY);
	mediaQuery.addEventListener("change", onChange);
	return () => mediaQuery.removeEventListener("change", onChange);
}

function getMobileInspectorViewportSnapshot() {
	return window.matchMedia(MOBILE_INSPECTOR_MEDIA_QUERY).matches;
}

function getServerMobileInspectorViewportSnapshot() {
	return false;
}

function getOrCreateDeviceId(): string {
	try {
		const existing = window.localStorage.getItem(DEVICE_ID_STORAGE_KEY);
		if (existing && /^[a-f0-9]{32}$/.test(existing)) {
			return existing;
		}

		const bytes = new Uint8Array(16);
		window.crypto.getRandomValues(bytes);
		const generated = Array.from(bytes, (byte) =>
			byte.toString(16).padStart(2, "0"),
		).join("");
		window.localStorage.setItem(DEVICE_ID_STORAGE_KEY, generated);
		return generated;
	} catch {
		const bytes = new Uint8Array(16);
		window.crypto.getRandomValues(bytes);
		return Array.from(bytes, (byte) =>
			byte.toString(16).padStart(2, "0"),
		).join("");
	}
}

type ApiSearchResult = {
	queryId: string;
	versionId: string;
	title: string;
	snippet: string;
	dialect: KqlDialect;
	tables: string[];
	starCount: number;
	sourceRepository: string | null;
	sourceRepositoryUrl: string | null;
	matchType: "lexical" | "semantic" | "hybrid";
	score: number;
	provenance: {
		sourceName: string;
		sourceUrl?: string;
		licenseSpdx?: string;
		provider?: "github" | "local";
	} | null;
	visibility: "public" | "private";
};

type ApiSearchResponse = {
	query: string;
	results: ApiSearchResult[];
	mode: "lexical" | "semantic" | "hybrid" | "none";
	adequacy: {
		adequate: boolean;
		confidence: number;
		reason: string;
	};
	attempted: string[];
	fallback:
		| {
				status: "available" | "unavailable";
				dialectRequired: boolean;
		  }
		| null;
	historyId?: string;
};

type GeneratedResponse = {
	generated: {
		title: string;
		kql: string;
		explanation: string;
		dialect: KqlDialect;
		tables: string[];
		assumptions: string[];
		supportingQueryIds: string[];
		model: string;
		warning: string;
	};
};

export type InitialSearchFilters = {
	dialect?: string;
	table?: string;
	operator?: string;
	author?: string;
	tag?: string;
	source?: string;
};

type LocalSearchFilters = Required<InitialSearchFilters>;

function serializeSearchParams(
	normalizedQuery: string,
	filters: LocalSearchFilters,
	includeLimit = true,
) {
	const params = new URLSearchParams();
	if (normalizedQuery) {
		params.set("q", normalizedQuery);
	}
	if (includeLimit) {
		params.set("limit", "20");
	}
	if (filters.dialect !== "all") {
		params.set("dialect", filters.dialect);
	}
	if (filters.table !== "all") {
		params.set("table", filters.table);
	}
	if (filters.operator) {
		params.set("operator", filters.operator);
	}
	if (filters.author) {
		params.set("author", filters.author);
	}
	if (filters.tag) {
		params.set("tag", filters.tag);
	}
	if (filters.source !== "all") {
		params.set("source", filters.source);
	}
	return params;
}

function mapSearchResult(result: ApiSearchResult): QueryRecord {
	const sample = SAMPLE_QUERIES.find((query) => query.id === result.queryId);
	if (sample) {
		return {
			...sample,
			score: result.score,
			matchType: result.matchType,
			starCount: result.starCount,
			sourceRepository: result.sourceRepository ?? sample.sourceRepository,
			sourceRepositoryUrl:
				result.sourceRepositoryUrl ?? sample.sourceRepositoryUrl,
			sourceProvider:
				result.provenance?.provider ?? sample.sourceProvider,
		};
	}

	return {
		id: result.queryId,
		versionId: result.versionId,
		title: result.title,
		snippet: result.snippet,
		explanation:
			"Open the canonical query record to review its explanation, source, and version history.",
		kql: "// Query body is loaded from the canonical query record.",
		dialect: result.dialect,
		dialectLabel: dialectLabel(result.dialect),
		tables: result.tables,
		operators: [],
		tags: [],
		starCount: result.starCount,
		sourceRepository: result.sourceRepository ?? undefined,
		sourceRepositoryUrl: result.sourceRepositoryUrl ?? undefined,
		sourceProvider: result.provenance?.provider,
		sourceName: result.provenance?.sourceName ?? "Community query",
		sourceUrl: result.provenance?.sourceUrl,
		license: result.provenance?.licenseSpdx ?? "License recorded with source",
		author: result.provenance?.sourceName ?? "Community",
		updatedAt: "Recently",
		visibility: result.visibility,
		matchType: result.matchType,
		score: result.score,
	};
}

function mapPublicQuery(item: QueryListItem): QueryRecord {
	const sourceName = item.provenance?.sourceName ?? "Community query";
	const description =
		item.description.trim() ||
		"Open the query to review its KQL and source details.";

	return {
		id: item.id,
		versionId: item.currentVersionId,
		title: item.title,
		snippet: description,
		explanation: description,
		kql: "// Query body is loaded from the canonical query record.",
		dialect: item.dialect,
		dialectLabel: dialectLabel(item.dialect),
		tables: item.tables,
		operators: [],
		tags: item.tags,
		starCount: item.starCount,
		sourceName,
		sourceUrl: item.provenance?.sourceUrl,
		sourceRepository: item.sourceRepository ?? undefined,
		sourceRepositoryUrl: item.sourceRepositoryUrl ?? undefined,
		sourceProvider: item.provenance?.provider,
		license:
			item.provenance?.licenseSpdx ?? "License recorded with source",
		author: sourceName,
		updatedAt: new Date(item.updatedAt).toLocaleDateString("en-US", {
			year: "numeric",
			month: "short",
			day: "numeric",
		}),
		visibility: "public",
		matchType: "hybrid",
		score: 0,
		starredByViewer: false,
	};
}

function localSearch(
	searchText: string,
	filters: LocalSearchFilters,
) {
	const terms = searchText
		.toLocaleLowerCase("en-US")
		.split(/\s+/)
		.filter(Boolean);

	return SAMPLE_QUERIES.filter((query) => {
		const searchable = [
			query.title,
			query.snippet,
			query.kql,
			query.dialectLabel,
			...query.tables,
			...query.tags,
			...query.operators,
		]
			.join(" ")
			.toLocaleLowerCase("en-US");

		return (
			(filters.dialect === "all" || query.dialect === filters.dialect) &&
			(filters.table === "all" || query.tables.includes(filters.table)) &&
			(filters.source === "all" || query.sourceName === filters.source) &&
			(!filters.operator ||
				query.operators.some((operator) =>
					operator.toLocaleLowerCase("en-US").includes(
						filters.operator.toLocaleLowerCase("en-US"),
					),
				)) &&
			(!filters.author ||
				query.author
					.toLocaleLowerCase("en-US")
					.includes(filters.author.toLocaleLowerCase("en-US"))) &&
			(!filters.tag ||
				query.tags.some((tag) =>
					tag
						.toLocaleLowerCase("en-US")
						.includes(filters.tag.toLocaleLowerCase("en-US")),
				)) &&
			(terms.length === 0 || terms.every((term) => searchable.includes(term)))
		);
	}).sort((a, b) => b.starCount - a.starCount);
}

function SearchTitle({
	compact = false,
	onHome,
}: {
	compact?: boolean;
	onHome?: (event: MouseEvent<HTMLAnchorElement>) => void;
}) {
	return (
		<h1
			{...stylex.props(
				styles.searchTitle,
				compact ? styles.searchTitleCompact : null,
			)}
		>
			<Link
				href="/"
				onClick={onHome}
				{...stylex.props(styles.searchTitleLink)}
			>
				<BrandLogo size={compact ? "compact" : "display"} />
			</Link>
		</h1>
	);
}

function ResultRows({
	results,
	selectedId,
	onOpen,
	showScore = true,
	isInspectorList = false,
}: {
	results: QueryRecord[];
	selectedId?: string;
	onOpen: (query: QueryRecord, event: MouseEvent<HTMLAnchorElement>) => void;
	showScore?: boolean;
	isInspectorList?: boolean;
}) {
	return (
		<div
			{...stylex.props(
				styles.resultList,
				isInspectorList ? styles.resultListInspector : null,
			)}
		>
			{results.map((query) => (
				<a
					key={query.id}
					href={`/queries/${query.id}`}
					data-query-id={query.id}
					onClick={(event) => onOpen(query, event)}
					aria-current={selectedId === query.id ? "page" : undefined}
					data-testid={
						selectedId === query.id ? "selected-query-row" : undefined
					}
					{...stylex.props(
						styles.resultRow,
						selectedId === query.id ? styles.resultRowSelected : null,
					)}
				>
					<div {...stylex.props(styles.resultTopline)}>
						<h2 {...stylex.props(styles.resultTitle)}>{query.title}</h2>
						{showScore ? (
							<span {...stylex.props(styles.resultScore)}>
								{Math.round(query.score * 100)}%
							</span>
						) : null}
					</div>
					<p {...stylex.props(styles.resultSnippet)}>{query.snippet}</p>
					<div {...stylex.props(styles.metadataLine)}>
						<Badge label={query.dialectLabel} />
						<span>{query.tables.slice(0, 2).join(", ")}</span>
						{query.visibility === "private" ? (
							<Badge label="Private" variant="neutral" />
						) : null}
						{query.aiGenerated ? (
							<Badge label="AI generated" variant="purple" />
						) : null}
					</div>
				</a>
			))}
		</div>
	);
}

export function SearchWorkspace({
	initialQuery = "",
	initialFilters = {},
	initialPopularPage = null,
}: {
	initialQuery?: string;
	initialFilters?: InitialSearchFilters;
	initialPopularPage?: CursorPage<QueryListItem> | null;
}) {
	const router = useRouter();
	const { registerHomeHandler, setLogoVisible } =
		useSearchHeaderController();
	const startingDialect = DIALECT_OPTIONS.some(
		(option) => option.value === initialFilters.dialect,
	)
		? (initialFilters.dialect ?? "all")
		: "all";
	const startingFilters: LocalSearchFilters = {
		dialect: startingDialect,
		table: initialFilters.table?.trim() || "all",
		operator: initialFilters.operator?.trim() || "",
		author: initialFilters.author?.trim() || "",
		tag: initialFilters.tag?.trim() || "",
		source: initialFilters.source?.trim() || "all",
	};
	const [query, setQuery] = useState(initialQuery);
	const [dialect] = useState(startingFilters.dialect);
	const [table] = useState(startingFilters.table);
	const [operator] = useState(startingFilters.operator);
	const [author] = useState(startingFilters.author);
	const [tag] = useState(startingFilters.tag);
	const [source] = useState(startingFilters.source);
	const [results, setResults] = useState(() =>
		initialQuery.trim() ? localSearch(initialQuery, startingFilters) : [],
	);
	const [popularQueries, setPopularQueries] = useState(() =>
		initialPopularPage?.items.map(mapPublicQuery) ?? [],
	);
	const [popularCursor, setPopularCursor] = useState(
		initialPopularPage?.nextCursor ?? null,
	);
	const [popularFeedStatus, setPopularFeedStatus] = useState<
		"idle" | "loading" | "complete" | "error"
	>(
		initialPopularPage
			? initialPopularPage.nextCursor
				? "idle"
				: "complete"
			: "loading",
	);
	const [hasSearched, setHasSearched] = useState(Boolean(initialQuery.trim()));
	const [selected, setSelected] = useState<QueryRecord | null>(null);
	const [isInspectorOpen, setIsInspectorOpen] = useState(false);
	const [status, setStatus] = useState<
		"idle" | "searching" | "complete" | "error" | "generating"
	>(initialQuery ? "complete" : "idle");
	const [statusMessage, setStatusMessage] = useState(
		initialQuery ? "Showing matching indexed queries." : "",
	);
	const [fallback, setFallback] = useState<ApiSearchResponse["fallback"]>(null);
	const [historyId, setHistoryId] = useState<string | null>(null);
	const [needsChallenge, setNeedsChallenge] = useState(false);
	const [turnstileToken, setTurnstileToken] = useState("");
	const [challengeKey, setChallengeKey] = useState(0);
	const [landingScrollTop, setLandingScrollTop] = useState(0);
	const isMobileInspectorViewport = useSyncExternalStore(
		subscribeToMobileInspectorViewport,
		getMobileInspectorViewportSnapshot,
		getServerMobileInspectorViewportSnapshot,
	);
	const activeSearchKey = useRef<string | null>(null);
	const landingScrollRef = useRef<HTMLDivElement>(null);
	const popularInitialLoadStarted = useRef(false);
	const popularLoadInFlight = useRef(false);
	const inspectorRevealFrame = useRef<number | null>(null);
	const inspectorFocusFrame = useRef<number | null>(null);
	const inspectorCloseTimer = useRef<number | null>(null);
	const inspectorOpenedAsMobileOverlay = useRef(false);
	const listScrollFrame = useRef<number | null>(null);
	const listScrollStartedAt = useRef<number | null>(null);
	const listScrollFrom = useRef(0);
	const listScrollTarget = useRef(0);
	const listScrollDuration = useRef(300);
	const listScrollMode = useRef<"align-row" | "restore" | null>(null);
	const listScrollRow = useRef<HTMLElement | null>(null);
	const listScrollIsProgrammatic = useRef(false);
	const listScrollBeforeInspector = useRef(0);
	const listScrollChangedByUser = useRef(false);
	const detailRequestSerial = useRef(0);

	const clearListScrollAnimation = useCallback(() => {
		if (listScrollFrame.current !== null) {
			window.cancelAnimationFrame(listScrollFrame.current);
			listScrollFrame.current = null;
		}
		listScrollStartedAt.current = null;
		listScrollMode.current = null;
		listScrollRow.current = null;
		listScrollIsProgrammatic.current = false;
	}, []);

	const animateListScroll = (timestamp: number) => {
		const list = landingScrollRef.current;
		const mode = listScrollMode.current;
		if (!list || !mode) {
			clearListScrollAnimation();
			return;
		}

		if (listScrollStartedAt.current === null) {
			listScrollStartedAt.current = timestamp;
		}

		if (mode === "align-row") {
			const row = listScrollRow.current;
			if (!row?.isConnected) {
				clearListScrollAnimation();
				return;
			}
			const listBounds = list.getBoundingClientRect();
			const rowBounds = row.getBoundingClientRect();
			listScrollTarget.current = Math.max(
				0,
				Math.min(
					list.scrollHeight - list.clientHeight,
					list.scrollTop + rowBounds.top - listBounds.top,
				),
			);
		}

		const progress = Math.min(
			(timestamp - listScrollStartedAt.current) /
				listScrollDuration.current,
			1,
		);
		const easedProgress = 1 - (1 - progress) ** 3;
		list.scrollTop =
			listScrollFrom.current +
			(listScrollTarget.current - listScrollFrom.current) *
				easedProgress;

		if (progress < 1) {
			listScrollFrame.current = window.requestAnimationFrame(
				animateListScroll,
			);
			return;
		}

		list.scrollTop = listScrollTarget.current;
		listScrollStartedAt.current = null;
		listScrollMode.current = null;
		listScrollRow.current = null;
		listScrollFrame.current = window.requestAnimationFrame(() => {
			listScrollFrame.current = null;
			listScrollIsProgrammatic.current = false;
		});
	};

	const startListScrollAnimation = (
		mode: "align-row" | "restore",
		options: { row?: HTMLElement; target?: number } = {},
	) => {
		const list = landingScrollRef.current;
		if (!list) {
			return;
		}

		clearListScrollAnimation();
		listScrollIsProgrammatic.current = true;
		listScrollFrom.current = list.scrollTop;
		listScrollTarget.current = options.target ?? list.scrollTop;
		listScrollDuration.current = window.matchMedia(
			"(prefers-reduced-motion: reduce)",
		).matches
			? 1
			: 300;
		listScrollMode.current = mode;
		listScrollRow.current = options.row ?? null;
		listScrollFrame.current = window.requestAnimationFrame(
			animateListScroll,
		);
	};

	const clearInspectorTimers = useCallback(() => {
		if (inspectorRevealFrame.current !== null) {
			window.cancelAnimationFrame(inspectorRevealFrame.current);
			inspectorRevealFrame.current = null;
		}
		if (inspectorFocusFrame.current !== null) {
			window.cancelAnimationFrame(inspectorFocusFrame.current);
			inspectorFocusFrame.current = null;
		}
		if (inspectorCloseTimer.current !== null) {
			window.clearTimeout(inspectorCloseTimer.current);
			inspectorCloseTimer.current = null;
		}
	}, []);

	const showInspector = (record: QueryRecord) => {
		clearInspectorTimers();
		setSelected(record);
		if (isInspectorOpen) {
			return;
		}
		inspectorOpenedAsMobileOverlay.current =
			getMobileInspectorViewportSnapshot();
		inspectorRevealFrame.current = window.requestAnimationFrame(() => {
			setIsInspectorOpen(true);
			inspectorRevealFrame.current = null;
		});
	};

	const closeInspector = () => {
		clearInspectorTimers();
		detailRequestSerial.current += 1;
		const list = landingScrollRef.current;
		const selectedRow = list?.querySelector<HTMLElement>(
			'[data-testid="selected-query-row"]',
		);
		const isMobileViewportNow = getMobileInspectorViewportSnapshot();
		if (selectedRow && !isMobileViewportNow) {
			selectedRow.focus({ preventScroll: true });
		}
		if (
			!inspectorOpenedAsMobileOverlay.current &&
			list &&
			!listScrollChangedByUser.current
		) {
			startListScrollAnimation("restore", {
				target: listScrollBeforeInspector.current,
			});
		} else {
			clearListScrollAnimation();
		}
		setIsInspectorOpen(false);
		if (selectedRow && isMobileViewportNow) {
			inspectorFocusFrame.current = window.requestAnimationFrame(() => {
				selectedRow.focus({ preventScroll: true });
				inspectorFocusFrame.current = null;
			});
		}
		inspectorOpenedAsMobileOverlay.current = false;

		const prefersReducedMotion = window.matchMedia(
			"(prefers-reduced-motion: reduce)",
		).matches;
		inspectorCloseTimer.current = window.setTimeout(() => {
			setSelected(null);
			inspectorCloseTimer.current = null;
		}, prefersReducedMotion ? 20 : 360);
	};

	const handleQueryListTransitionEnd = (
		event: TransitionEvent<HTMLDivElement>,
	) => {
		if (
			event.target !== event.currentTarget ||
			event.propertyName !== "width"
		) {
			return;
		}

		if (isInspectorOpen) {
			return;
		}

		if (selected) {
			if (inspectorCloseTimer.current !== null) {
				window.clearTimeout(inspectorCloseTimer.current);
				inspectorCloseTimer.current = null;
			}
			setSelected(null);
		}
	};

	const resetInspector = useCallback(() => {
		clearInspectorTimers();
		clearListScrollAnimation();
		detailRequestSerial.current += 1;
		setIsInspectorOpen(false);
		setSelected(null);
	}, [clearInspectorTimers, clearListScrollAnimation]);

	const returnHome = useCallback((event: MouseEvent<HTMLAnchorElement>) => {
		if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
			return;
		}

		event.preventDefault();
		resetInspector();
		activeSearchKey.current = "";
		setQuery("");
		setResults([]);
		setHasSearched(false);
		setStatus("idle");
		setStatusMessage("");
		setFallback(null);
		setHistoryId(null);
		setNeedsChallenge(false);
		setTurnstileToken("");
		setLandingScrollTop(0);
		if (landingScrollRef.current) {
			landingScrollRef.current.scrollTop = 0;
		}
		router.push("/");
	}, [resetInspector, router]);

	const showSearchHeaderLogo = landingScrollTop > 0 || selected !== null;

	useEffect(() => {
		setLogoVisible(showSearchHeaderLogo);
		return () => setLogoVisible(false);
	}, [setLogoVisible, showSearchHeaderLogo]);

	useEffect(
		() => registerHomeHandler(returnHome),
		[registerHomeHandler, returnHome],
	);

	useEffect(() => {
		return () => {
			if (inspectorRevealFrame.current !== null) {
				window.cancelAnimationFrame(inspectorRevealFrame.current);
			}
			if (inspectorFocusFrame.current !== null) {
				window.cancelAnimationFrame(inspectorFocusFrame.current);
			}
			if (inspectorCloseTimer.current !== null) {
				window.clearTimeout(inspectorCloseTimer.current);
			}
			if (listScrollFrame.current !== null) {
				window.cancelAnimationFrame(listScrollFrame.current);
			}
		};
	}, []);

	const loadPopularPage = useCallback(async (cursor?: string) => {
		if (popularLoadInFlight.current) {
			return;
		}

		popularLoadInFlight.current = true;
		setPopularFeedStatus("loading");
		const params = new URLSearchParams({
			limit: String(POPULAR_PAGE_SIZE),
		});
		if (cursor) {
			params.set("cursor", cursor);
		}

		try {
			const response = await fetch(`/api/queries/popular?${params.toString()}`, {
				headers: { Accept: "application/json" },
			});
			const payload = (await response.json()) as {
				data?: CursorPage<QueryListItem>;
			};
			if (!response.ok || !payload.data) {
				throw new Error("The public query feed could not be loaded.");
			}

			const nextItems = payload.data.items.map(mapPublicQuery);
			setPopularQueries((current) => {
				if (!cursor) {
					return nextItems;
				}

				const knownIds = new Set(current.map((item) => item.id));
				return [
					...current,
					...nextItems.filter((item) => !knownIds.has(item.id)),
				];
			});
			setPopularCursor(payload.data.nextCursor ?? null);
			setPopularFeedStatus(
				payload.data.nextCursor ? "idle" : "complete",
			);
		} catch {
			setPopularFeedStatus("error");
		} finally {
			popularLoadInFlight.current = false;
		}
	}, []);

	useEffect(() => {
		if (initialPopularPage || popularInitialLoadStarted.current) {
			return;
		}
		popularInitialLoadStarted.current = true;
		void loadPopularPage();
	}, [initialPopularPage, loadPopularPage]);

	const handleQueryListScroll = (event: UIEvent<HTMLDivElement>) => {
		const landing = event.currentTarget;
		const scrollTop = landing.scrollTop;

		if (!hasSearched) {
			setLandingScrollTop(scrollTop);
		}

		if (isInspectorOpen && !listScrollIsProgrammatic.current) {
			listScrollChangedByUser.current = true;
		}

		const remainingScroll =
			landing.scrollHeight - scrollTop - landing.clientHeight;
		if (
			!hasSearched &&
			popularCursor &&
			remainingScroll <= POPULAR_LOAD_THRESHOLD
		) {
			void loadPopularPage(popularCursor);
		}
	};

	const currentFilters = (): LocalSearchFilters => ({
		dialect,
		table,
		operator: operator.trim(),
		author: author.trim(),
		tag: tag.trim(),
		source,
	});

	const runSearch = async (event?: FormEvent, submittedQuery = query) => {
		event?.preventDefault();
		const normalized = submittedQuery.trim();
		if (!normalized) {
			setQuery("");
			setResults([]);
			setHasSearched(false);
			setFallback(null);
			setHistoryId(null);
			setStatus("idle");
			setStatusMessage("");
			const params = serializeSearchParams("", currentFilters(), false);
			activeSearchKey.current = params.toString();
			router.push(params.size ? `/?${params.toString()}` : "/");
			return;
		}

		setQuery(submittedQuery);
		setHasSearched(true);
		setStatus("searching");
		setStatusMessage("Searching titles, tables, query text, and semantic matches.");
		resetInspector();

		const filters = currentFilters();
		const params = serializeSearchParams(normalized, filters);
		const routeParams = serializeSearchParams(normalized, filters, false);
		activeSearchKey.current = routeParams.toString();
		router.push(`/?${routeParams.toString()}`);

		try {
			const response = await fetch(`/api/search?${params.toString()}`, {
				headers: { Accept: "application/json" },
			});
			if (!response.ok) {
				throw new Error("Search request failed.");
			}
			const payload = (await response.json()) as { data?: ApiSearchResponse };
			if (!payload.data) {
				throw new Error("Search response was incomplete.");
			}

			const apiResults = payload.data.results.map(mapSearchResult);
			setResults(apiResults);
			setFallback(payload.data.fallback);
			setHistoryId(payload.data.historyId ?? null);
			setStatus("complete");
			setStatusMessage(
				payload.data.fallback?.status === "available"
					? "Lexical and semantic retrieval completed without an adequate match."
					: `${payload.data.mode === "hybrid" ? "Hybrid" : "Indexed"} retrieval complete.`,
			);
		} catch {
			const localResults = localSearch(normalized, currentFilters());
			setResults(localResults);
			setHistoryId(null);
			setFallback(
				localResults.length === 0
					? { status: "available", dialectRequired: dialect === "all" }
					: null,
			);
			setStatus("complete");
			setStatusMessage(
				localResults.length
					? "Showing matching indexed examples."
					: "Lexical and semantic retrieval found no adequate match.",
			);
		}
	};

	useEffect(() => {
		const normalized = initialQuery.trim();
		const filters: LocalSearchFilters = {
			dialect: startingDialect,
			table: initialFilters.table?.trim() || "all",
			operator: initialFilters.operator?.trim() || "",
			author: initialFilters.author?.trim() || "",
			tag: initialFilters.tag?.trim() || "",
			source: initialFilters.source?.trim() || "all",
		};
		const searchKey = serializeSearchParams(normalized, filters, false).toString();
		if (!normalized || activeSearchKey.current === searchKey) {
			return;
		}
		activeSearchKey.current = searchKey;
		const params = serializeSearchParams(normalized, filters);

		const search = async () => {
			setQuery(initialQuery);
			setHasSearched(true);
			setStatus("searching");
			setStatusMessage("Searching titles, tables, query text, and semantic matches.");
			try {
				const response = await fetch(`/api/search?${params.toString()}`, {
					headers: { Accept: "application/json" },
				});
				if (!response.ok) {
					throw new Error("Search request failed.");
				}
				const payload = (await response.json()) as {
					data?: ApiSearchResponse;
				};
				if (!payload.data) {
					throw new Error("Search response was incomplete.");
				}

				setResults(payload.data.results.map(mapSearchResult));
				setFallback(payload.data.fallback);
				setHistoryId(payload.data.historyId ?? null);
				setStatus("complete");
				setStatusMessage(
					payload.data.fallback?.status === "available"
						? "Lexical and semantic retrieval completed without an adequate match."
						: `${payload.data.mode === "hybrid" ? "Hybrid" : "Indexed"} retrieval complete.`,
				);
			} catch {
				const localResults = localSearch(normalized, filters);
				setResults(localResults);
				setHistoryId(null);
				setFallback(
					localResults.length === 0
						? {
								status: "available",
								dialectRequired: filters.dialect === "all",
							}
						: null,
				);
				setStatus("complete");
				setStatusMessage(
					localResults.length
						? "Showing matching indexed examples."
						: "Lexical and semantic retrieval found no adequate match.",
				);
			}
		};

		void search();
	}, [
		initialFilters.author,
		initialFilters.operator,
		initialFilters.source,
		initialFilters.table,
		initialFilters.tag,
		initialQuery,
		startingDialect,
	]);

	const openQuery = async (
		record: QueryRecord,
		event: MouseEvent<HTMLAnchorElement>,
	) => {
		if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
			return;
		}
		event.preventDefault();
		const list = landingScrollRef.current;
		if (list) {
			listScrollBeforeInspector.current = list.scrollTop;
		}
		listScrollChangedByUser.current = false;
		showInspector(record);
		if (getMobileInspectorViewportSnapshot()) {
			clearListScrollAnimation();
		} else {
			startListScrollAnimation("align-row", {
				row: event.currentTarget,
			});
		}
		const requestSerial = detailRequestSerial.current + 1;
		detailRequestSerial.current = requestSerial;

		if (historyId) {
			void fetch(`/api/history/${historyId}/click`, {
				method: "PATCH",
				headers: {
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ queryId: record.id }),
			}).catch(() => {
				// Click attribution must never block opening a result.
			});
		}

		try {
			const response = await fetch(`/api/queries/${record.id}`, {
				headers: { Accept: "application/json" },
			});
			if (!response.ok) {
				return;
			}
			const payload = (await response.json()) as {
				data?: unknown;
			};
			const stored = mapStoredQuery(payload.data);
			if (stored && detailRequestSerial.current === requestSerial) {
				setSelected({
					...record,
					...stored,
					id: record.id,
					score: record.score,
					matchType: record.matchType,
				});
			}
		} catch {
			// The search result remains usable as a public-page link.
		}
	};

	const generateQuery = async (challengeToken?: string) => {
		if (dialect === "all" && fallback?.dialectRequired) {
			setStatus("error");
			setStatusMessage(
				"Include a target dialect such as Sentinel or Defender XDR in the search.",
			);
			return;
		}

		setStatus("generating");
		setStatusMessage("Retrieval is complete. DeepSeek is generating an unverified candidate.");

		try {
			const response = await fetch("/api/ai/generate", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Accept: "application/json",
					"x-kql-device-id": getOrCreateDeviceId(),
				},
				body: JSON.stringify({
					q: query.trim(),
					dialects: dialect === "all" ? [] : [dialect],
					tables: table === "all" ? [] : [table],
					operators: operator.trim() ? [operator.trim()] : [],
					tags: tag.trim() ? [tag.trim()] : [],
					authors: author.trim() ? [author.trim()] : [],
					sources: source === "all" ? [] : [source],
					limit: 20,
					dialect: dialect === "all" ? undefined : dialect,
					privateProcessingAcknowledged: false,
					turnstileToken: challengeToken || undefined,
				}),
			});

			const payload = (await response.json()) as {
				data?: GeneratedResponse;
				error?: {
					message?: string;
					details?: { challengeRequired?: boolean };
				};
			};
			if (
				!response.ok &&
				payload.error?.details?.challengeRequired === true
			) {
				setNeedsChallenge(true);
				setTurnstileToken("");
				setChallengeKey((value) => value + 1);
				setStatus("error");
				setStatusMessage(
					TURNSTILE_SITE_KEY
						? (payload.error.message ??
								"Complete verification before generation retries.")
						: "Verification is required, but NEXT_PUBLIC_TURNSTILE_SITE_KEY is not configured. Ask the site administrator to configure it, then try again.",
				);
				return;
			}
			if (!response.ok || !payload.data?.generated) {
				throw new Error(payload.error?.message ?? "Generation failed.");
			}

			const generated = payload.data.generated;
			const record: QueryRecord = {
				id: `generated-${Date.now()}`,
				versionId: `generated-${Date.now()}`,
				title: generated.title,
				snippet: generated.explanation,
				explanation: generated.explanation,
				kql: generated.kql,
				dialect: generated.dialect,
				dialectLabel: dialectLabel(generated.dialect),
				tables: generated.tables,
				operators: [],
				tags: ["ai-generated"],
				starCount: 0,
				sourceName: "DeepSeek generation",
				license: "Not yet published",
				author: "AI candidate",
				updatedAt: "Just now",
				visibility: "private",
				matchType: "semantic",
				score: 0,
				aiGenerated: true,
				assumptions: generated.assumptions,
				model: generated.model,
			};

			setResults([record]);
			showInspector(record);
			setFallback(null);
			setNeedsChallenge(false);
			setTurnstileToken("");
			setStatus("complete");
			setStatusMessage("AI candidate generated. It has not been executed or verified.");
		} catch (error) {
			setStatus("error");
			setStatusMessage(
				error instanceof Error
					? error.message
					: "AI generation is unavailable. Try again later.",
			);
		}
	};

	const acceptTurnstileToken = (token: string) => {
		setTurnstileToken(token);
		if (token) {
			void generateQuery(token);
		}
	};

	const handleTurnstileError = (message: string) => {
		setTurnstileToken("");
		setStatus("error");
		setStatusMessage(message);
	};

	const visibleResults =
		!hasSearched && results.length === 0 ? popularQueries : results;

	const resultStatus = (
		<div {...stylex.props(styles.statusLine)} aria-live="polite">
			<span>
				<span {...stylex.props(styles.statusStrong)}>
					{status === "searching"
						? "Searching"
						: status === "generating"
							? "Generating"
							: `${visibleResults.length} ${
									visibleResults.length === 1 ? "result" : "results"
								}`}
				</span>
				{" / "}
				{hasSearched ? statusMessage : "Popular queries"}
			</span>
			{status === "searching" || status === "generating" ? (
				<Badge label={status === "searching" ? "Retrieving" : "AI fallback"} variant="info" />
			) : null}
		</div>
	);

	const noResults =
		hasSearched && results.length === 0 && status !== "searching" ? (
			<div {...stylex.props(styles.emptyWrap)}>
				<EmptyState
					headingLevel={2}
					title="No adequate query found"
					description={
						fallback?.dialectRequired || dialect === "all"
							? "Lexical and semantic retrieval completed. Include a target dialect such as Sentinel or Defender XDR in a refined search."
							: "Lexical and semantic retrieval completed. DeepSeek can generate an unverified candidate for the selected dialect."
					}
					icon={<Icon icon="search" size="lg" />}
					actions={
						<Button
							label={
								fallback?.dialectRequired && dialect === "all"
									? "Refine with a dialect"
									: "Generate with DeepSeek"
							}
							variant="primary"
							isDisabled={
								(fallback?.dialectRequired && dialect === "all") ||
								fallback?.status !== "available" ||
								status === "generating" ||
								(needsChallenge &&
									Boolean(TURNSTILE_SITE_KEY) &&
									!turnstileToken)
							}
							onClick={() => void generateQuery()}
						/>
					}
				/>
			</div>
		) : null;

	const renderSearchComposer = (isLanding = false) => (
		<div role="search" {...stylex.props(styles.searchComposer)}>
			<SearchTitle onHome={returnHome} />
			<ChatComposer
				value={query}
				onChange={setQuery}
				onSubmit={(value) => {
					void runSearch(undefined, value);
					queueMicrotask(() => setQuery(value));
				}}
				placeholder="Search KQL queries"
				density="compact"
				style={isLanding ? LANDING_COMPOSER_STYLE : undefined}
				xstyle={isLanding ? styles.landingComposerSurface : undefined}
				sendButton={
					<Button
						label="Search"
						variant={query.trim() ? "primary" : "secondary"}
						size="sm"
						isIconOnly
						icon={<Icon icon="arrowUp" />}
						isDisabled={!query.trim() || status === "searching"}
						isLoading={status === "searching"}
						onClick={() => void runSearch()}
					/>
				}
			/>
		</div>
	);

	const landingSearchProgress = Math.min(
		landingScrollTop / LANDING_SEARCH_FADE_DISTANCE,
		1,
	);
	const hasVisibleInspector = Boolean(selected && isInspectorOpen);
	const hasMobileInspectorOverlay =
		hasVisibleInspector && isMobileInspectorViewport;
	const hasDesktopInspector =
		hasVisibleInspector && !isMobileInspectorViewport;
	const listSelectionIsSuppressed = Boolean(
		selected && !isMobileInspectorViewport,
	);

	return (
		<div
			data-testid="search-workspace"
			{...stylex.props(
				styles.searchWorkspace,
				hasVisibleInspector ? styles.searchWorkspaceInspecting : null,
			)}
		>
			<div
				ref={landingScrollRef}
				data-testid="query-list-scroll"
				data-query-card-pane="true"
				aria-hidden={hasMobileInspectorOverlay ? "true" : undefined}
				inert={hasMobileInspectorOverlay ? true : undefined}
				onPointerDown={() => {
					if (isInspectorOpen) {
						listScrollChangedByUser.current = true;
						clearListScrollAnimation();
					}
				}}
				onScroll={handleQueryListScroll}
				onTouchStart={() => {
					if (isInspectorOpen) {
						listScrollChangedByUser.current = true;
						clearListScrollAnimation();
					}
				}}
				onTransitionEnd={handleQueryListTransitionEnd}
				onWheel={() => {
					if (isInspectorOpen) {
						listScrollChangedByUser.current = true;
						clearListScrollAnimation();
					}
				}}
				{...stylex.props(
					styles.queryListPane,
					hasDesktopInspector ? styles.queryListPaneInspecting : null,
				)}
			>
				{!hasSearched && !listSelectionIsSuppressed && landingScrollTop > 0 ? (
					<div
						aria-hidden="true"
						data-testid="landing-top-fade"
						{...stylex.props(styles.landingTopFade)}
					/>
				) : null}

				<div
					{...stylex.props(
						styles.queryListContent,
						hasDesktopInspector
							? null
							: hasSearched
								? styles.queryListContentResults
								: styles.queryListContentLanding,
					)}
				>
					{hasSearched ? (
						<div
							aria-hidden={listSelectionIsSuppressed ? "true" : undefined}
							inert={listSelectionIsSuppressed ? true : undefined}
							{...stylex.props(
								styles.resultsChrome,
								listSelectionIsSuppressed ? styles.resultsChromeHidden : null,
							)}
						>
							<div {...stylex.props(styles.searchedComposer)}>
								{renderSearchComposer()}
							</div>

							{status === "error" ? (
								<Banner
									status="error"
									title="The request could not be completed"
									description={statusMessage}
									isDismissable
								/>
							) : null}

							{needsChallenge && TURNSTILE_SITE_KEY ? (
								<TurnstileChallenge
									key={challengeKey}
									siteKey={TURNSTILE_SITE_KEY}
									onToken={acceptTurnstileToken}
									onError={handleTurnstileError}
								/>
							) : null}

							{resultStatus}
						</div>
					) : !listSelectionIsSuppressed ? (
						<>
							<div
								{...stylex.props(styles.landingComposer)}
								style={{
									opacity: 1 - landingSearchProgress,
									pointerEvents:
										landingSearchProgress >= 0.95 ? "none" : "auto",
									transform: `translate(-50%, calc(-50% + ${landingScrollTop}px))`,
									visibility:
										landingSearchProgress >= 1 ? "hidden" : "visible",
								}}
							>
								{renderSearchComposer(true)}
							</div>
						</>
					) : null}

					<section
						aria-label={
							hasSearched ? "Search results" : "Popular KQL queries"
						}
						data-testid="popular-query-feed"
						{...stylex.props(
							styles.queryCollection,
							hasDesktopInspector
								? styles.queryCollectionInspecting
								: null,
						)}
					>
						{visibleResults.length ? (
							<ResultRows
								results={visibleResults}
								selectedId={selected?.id}
								onOpen={openQuery}
								showScore={hasSearched}
								isInspectorList={hasDesktopInspector}
							/>
						) : null}

						{!hasSearched && !listSelectionIsSuppressed ? (
							<div
								role="status"
								aria-live="polite"
								{...stylex.props(styles.popularFeedStatus)}
							>
								{popularFeedStatus === "loading" ? (
									"Loading public queries"
								) : popularFeedStatus === "error" ? (
									<>
										<span>More queries could not be loaded.</span>
										<Button
											label="Retry"
											variant="ghost"
											size="sm"
											onClick={() =>
												void loadPopularPage(popularCursor ?? undefined)
											}
										/>
									</>
								) : popularCursor ? (
									`${popularQueries.length} queries loaded. Scroll for more.`
								) : (
									`${popularQueries.length} queries loaded.`
								)}
							</div>
						) : null}

						{!listSelectionIsSuppressed ? noResults : null}
					</section>
				</div>
			</div>

			<aside
				aria-hidden={!hasVisibleInspector}
				aria-label="Query inspector"
				data-testid="query-inspector"
				inert={!hasVisibleInspector ? true : undefined}
				onKeyDown={(event) => {
					if (event.key === "Escape" && hasVisibleInspector) {
						event.preventDefault();
						closeInspector();
					}
				}}
				{...stylex.props(
					styles.inspector,
					hasVisibleInspector ? styles.inspectorOpen : null,
				)}
			>
				{selected ? (
					<QueryInspector
						key={selected.id}
						query={selected}
						onClose={closeInspector}
						focusCloseOnMount={hasMobileInspectorOverlay}
					/>
				) : null}
			</aside>
		</div>
	);
}
