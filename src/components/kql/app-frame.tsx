"use client";

import { AppShell } from "@astryxdesign/core/AppShell";
import { Avatar } from "@astryxdesign/core/Avatar";
import { Button } from "@astryxdesign/core/Button";
import { DropdownMenu } from "@astryxdesign/core/DropdownMenu";
import { Icon } from "@astryxdesign/core/Icon";
import { TopNav, TopNavHeading, TopNavItem } from "@astryxdesign/core/TopNav";
import { useToast } from "@astryxdesign/core/Toast";
import { authClient, useSession } from "@/lib/auth/client";
import { usePathname, useRouter } from "next/navigation";
import {
	createContext,
	type MouseEvent,
	useCallback,
	useContext,
	useMemo,
	useRef,
	useState,
} from "react";
import * as stylex from "@stylexjs/stylex";

import { styles } from "@/styles/kql.stylex";
import { BrandLogo } from "./brand-logo";

const destinations = [
	{ label: "My queries", href: "/my-queries" },
	{ label: "Saved", href: "/saved" },
];

type SearchHomeHandler = (event: MouseEvent<HTMLAnchorElement>) => void;

type SearchHeaderController = {
	registerHomeHandler: (handler: SearchHomeHandler) => () => void;
	setLogoVisible: (visible: boolean) => void;
};

const EMPTY_SEARCH_HEADER_CONTROLLER: SearchHeaderController = {
	registerHomeHandler: () => () => undefined,
	setLogoVisible: () => undefined,
};

const SearchHeaderContext = createContext<SearchHeaderController>(
	EMPTY_SEARCH_HEADER_CONTROLLER,
);

export function useSearchHeaderController() {
	return useContext(SearchHeaderContext);
}

function pathIsSelected(pathname: string, href: string) {
	return pathname === href || pathname.startsWith(`${href}/`);
}

export function AppFrame({ children }: { children: React.ReactNode }) {
	const pathname = usePathname();
	const router = useRouter();
	const { data: session, isPending } = useSession();
	const [isLoggingIn, setIsLoggingIn] = useState(false);
	const [showSearchHeaderLogo, setShowSearchHeaderLogo] = useState(false);
	const searchHomeHandler = useRef<SearchHomeHandler | null>(null);
	const toast = useToast();
	const isSearchPage = pathname === "/";
	const registerSearchHomeHandler = useCallback(
		(handler: SearchHomeHandler) => {
			searchHomeHandler.current = handler;
			return () => {
				if (searchHomeHandler.current === handler) {
					searchHomeHandler.current = null;
				}
			};
		},
		[],
	);
	const searchHeaderController = useMemo<SearchHeaderController>(
		() => ({
			registerHomeHandler: registerSearchHomeHandler,
			setLogoVisible: setShowSearchHeaderLogo,
		}),
		[registerSearchHomeHandler],
	);
	const handleSearchHeaderHome = useCallback(
		(event: MouseEvent<HTMLElement>) => {
			searchHomeHandler.current?.(event as MouseEvent<HTMLAnchorElement>);
		},
		[],
	);

	const login = async () => {
		if (isLoggingIn) {
			return;
		}

		setIsLoggingIn(true);
		try {
			const result = await authClient.signIn.social({
				provider: "github",
				callbackURL: pathname || "/",
				disableRedirect: true,
			});

			if (result.error || !result.data?.url) {
				toast({
					body: "Login is unavailable. Check the GitHub OAuth configuration.",
					type: "error",
					uniqueID: "github-login-error",
				});
				return;
			}

			window.location.assign(result.data.url);
		} catch {
			toast({
				body: "Login could not start. Try again.",
				type: "error",
				uniqueID: "github-login-error",
			});
		} finally {
			setIsLoggingIn(false);
		}
	};

	const logout = async () => {
		await authClient.signOut();
		router.push("/");
		router.refresh();
	};

	const desktopNavigation = (
		<div {...stylex.props(styles.navDesktop)}>
			{destinations.map((item) => (
				<TopNavItem
					key={item.href}
					label={item.label}
					href={item.href}
					isSelected={pathIsSelected(pathname, item.href)}
				/>
			))}
		</div>
	);

	const mobileNavigation = (
		<div {...stylex.props(styles.navMobile)}>
			<DropdownMenu
				button={{
					label: "Open navigation",
					variant: "ghost",
					isIconOnly: true,
					icon: <Icon icon="menu" />,
				}}
				items={destinations.map((item) => ({
					label: item.label,
					onClick: () => router.push(item.href),
				}))}
				menuWidth={190}
				placement="below"
			/>
		</div>
	);

	const authentication = isPending ? (
		<Button label="Checking session" variant="ghost" isLoading isDisabled />
	) : session?.user ? (
		<DropdownMenu
			button={{
				label: session.user.name || "Account",
				variant: "ghost",
				icon: (
					<Avatar
						name={session.user.name}
						src={session.user.image ?? undefined}
						size="sm"
					/>
				),
			}}
			items={[
				{
					label: session.user.email,
					isDisabled: true,
				},
				{
					label: "Sign out",
					onClick: logout,
				},
			]}
			menuWidth={220}
			placement="below"
		/>
	) : (
		<Button
			label="Log in"
			variant="primary"
			isLoading={isLoggingIn}
			isDisabled={isLoggingIn}
			onClick={login}
			xstyle={styles.loginButton}
		/>
	);

	return (
		<SearchHeaderContext.Provider value={searchHeaderController}>
			<AppShell
				variant="surface"
				height="fill"
				contentPadding={0}
				mobileNav={false}
				xstyle={styles.appShell}
				topNav={
					<TopNav
						label="Primary navigation"
						heading={
							!isSearchPage || showSearchHeaderLogo ? (
								<TopNavHeading
									logo={<BrandLogo size="nav" />}
									logoLabel="KQL Book"
									headingHref="/"
									data-testid={
										isSearchPage ? "search-nav-logo" : undefined
									}
									onClick={
										isSearchPage ? handleSearchHeaderHome : undefined
									}
								/>
							) : undefined
						}
						endContent={
							<div {...stylex.props(styles.authCluster)}>
								{session?.user ? desktopNavigation : null}
								{session?.user ? mobileNavigation : null}
								{authentication}
							</div>
						}
					/>
				}
			>
				{children}
			</AppShell>
		</SearchHeaderContext.Provider>
	);
}
