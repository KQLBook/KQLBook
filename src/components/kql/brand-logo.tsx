import * as stylex from "@stylexjs/stylex";
import { useId } from "react";

type BrandLogoProps = {
	size?: "display" | "compact" | "nav";
};

export function BrandLogo({ size = "display" }: BrandLogoProps) {
	const gradientId = useId();

	return (
		<span
			{...stylex.props(
				styles.logo,
				size === "compact" ? styles.compact : null,
				size === "nav" ? styles.nav : null,
			)}
		>
			<svg
				aria-hidden="true"
				focusable="false"
				viewBox="0 0 26 26"
				{...stylex.props(styles.chevron)}
			>
				<defs>
					<linearGradient
						id={gradientId}
						x1="4"
						y1="22"
						x2="22"
						y2="4"
						gradientUnits="userSpaceOnUse"
					>
						<stop offset="0" stopColor="#2f5bff" />
						<stop offset="1" stopColor="#9b5cff" />
					</linearGradient>
				</defs>
				<path
					d="M8.1 7.6L20 6L18.4 17.9"
					fill="none"
					stroke={`url(#${gradientId})`}
					strokeLinecap="round"
					strokeLinejoin="round"
					strokeWidth="6"
				/>
			</svg>
			<span {...stylex.props(styles.wordmark)}>
				<span {...stylex.props(styles.initialism)}>KQL</span>
				<span {...stylex.props(styles.descriptor)}>Book</span>
			</span>
		</span>
	);
}

const styles = stylex.create({
	logo: {
		alignItems: "center",
		display: "inline-flex",
		fontSize: "inherit",
		letterSpacing: "-0.025em",
		lineHeight: 1,
		whiteSpace: "nowrap",
	},
	wordmark: {
		alignItems: "baseline",
		display: "inline-flex",
		gap: "0.24em",
	},
	initialism: {
		fontWeight: 700,
	},
	descriptor: {
		fontWeight: 550,
	},
	chevron: {
		display: "block",
		height: "0.78em",
		marginInlineEnd: "0.38em",
		overflow: "visible",
		transform: "translateY(-0.06em)",
		width: "0.78em",
	},
	compact: {
		letterSpacing: "-0.02em",
	},
	nav: {
		fontSize: 20,
		letterSpacing: "-0.02em",
	},
});
