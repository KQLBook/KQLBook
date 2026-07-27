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
				boxShadow:
					"0 1px 2px rgb(0 0 0 / 10%), inset 0 0 0 1px rgb(0 0 0 / 4%)",
				":hover": {
					boxShadow:
						"0 2px 6px rgb(0 0 0 / 12%), inset 0 0 0 1px rgb(0 0 0 / 4%)",
				},
			},
			"variant:secondary": {
				borderColor: "rgb(0 0 0 / 6%)",
				borderStyle: "solid",
				borderWidth: "1px",
				boxShadow: "0 1px 2px rgb(0 0 0 / 4%)",
				":hover": {
					borderColor: "rgb(0 0 0 / 10%)",
					boxShadow: "0 2px 5px rgb(0 0 0 / 7%)",
				},
			},
			"variant:destructive": {
				boxShadow:
					"0 1px 2px rgb(0 0 0 / 10%), inset 0 0 0 1px rgb(0 0 0 / 5%)",
			},
		},
	},
});
