import { defineTheme } from "@astryxdesign/core/theme";
import { neutralTheme } from "@astryxdesign/theme-neutral";

export const kqlBookTheme = defineTheme({
	name: "kql-book",
	extends: neutralTheme,
	components: {
		button: {
			base: {
				borderRadius: "9999px",
				fontWeight: "550",
				transitionProperty:
					"background-image, background-color, border-color, box-shadow, color, opacity, transform",
			},
			"size:sm": {
				height: "32px",
			},
			"size:md": {
				height: "36px",
			},
			"size:lg": {
				height: "44px",
			},
			"variant:primary": {
				boxShadow: "0 1px 2px var(--color-shadow)",
				":hover": {
					boxShadow: "0 2px 6px var(--color-shadow)",
				},
			},
			"variant:secondary": {
				borderColor: "var(--color-border)",
				borderStyle: "solid",
				borderWidth: "1px",
				boxShadow: "0 1px 2px var(--color-shadow)",
				":hover": {
					borderColor: "var(--color-border-emphasized)",
					boxShadow: "0 2px 5px var(--color-shadow)",
				},
			},
			"variant:destructive": {
				boxShadow: "0 1px 2px var(--color-shadow)",
			},
		},
	},
});
