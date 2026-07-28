"use client";

import {
	DropdownMenu,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
} from "@astryxdesign/core/DropdownMenu";
import { useTheme } from "@astryxdesign/core/theme";

import {
	isThemePreference,
	type ResolvedTheme,
} from "@/lib/theme/preferences";
import { useThemePreference } from "./theme-provider";

function ThemeIcon({ mode }: { mode: ResolvedTheme }) {
	if (mode === "dark") {
		return (
			<svg
				aria-hidden="true"
				fill="none"
				height="18"
				viewBox="0 0 24 24"
				width="18"
			>
				<path
					d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"
					stroke="currentColor"
					strokeLinecap="round"
					strokeLinejoin="round"
					strokeWidth="1.7"
				/>
			</svg>
		);
	}

	return (
		<svg
			aria-hidden="true"
			fill="none"
			height="18"
			viewBox="0 0 24 24"
			width="18"
		>
			<circle cx="12" cy="12" r="4" stroke="currentColor" strokeWidth="1.7" />
			<path
				d="M12 2v2m0 16v2M4.93 4.93l1.42 1.42m11.3 11.3 1.42 1.42M2 12h2m16 0h2M4.93 19.07l1.42-1.42m11.3-11.3 1.42-1.42"
				stroke="currentColor"
				strokeLinecap="round"
				strokeWidth="1.7"
			/>
		</svg>
	);
}

export function ThemeMenu() {
	const { mode } = useTheme();
	const { preference, setPreference } = useThemePreference();

	return (
		<DropdownMenu
			button={{
				label: `Theme: ${preference}`,
				variant: "ghost",
				isIconOnly: true,
				icon: <ThemeIcon mode={mode} />,
				tooltip: "Theme",
			}}
			hasChevron={false}
			menuWidth={168}
			placement="below"
		>
			<DropdownMenuRadioGroup
				aria-label="Theme"
				onChange={(value) => {
					if (isThemePreference(value)) {
						setPreference(value);
					}
				}}
				value={preference}
			>
				<DropdownMenuRadioItem label="System" value="system" />
				<DropdownMenuRadioItem label="Light" value="light" />
				<DropdownMenuRadioItem label="Dark" value="dark" />
			</DropdownMenuRadioGroup>
		</DropdownMenu>
	);
}
