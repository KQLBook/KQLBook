import { describe, expect, it, vi } from "vitest";

import {
	isThemePreference,
	parseThemePreference,
	readThemePreference,
	resolveThemePreference,
	THEME_STORAGE_KEY,
	type ThemeStorage,
	writeThemePreference,
} from "./preferences";

function createStorage(initialValue: string | null = null): ThemeStorage {
	let value = initialValue;

	return {
		getItem: vi.fn(() => value),
		setItem: vi.fn((_key, nextValue) => {
			value = nextValue;
		}),
		removeItem: vi.fn(() => {
			value = null;
		}),
	};
}

describe("theme preferences", () => {
	it.each(["system", "light", "dark"] as const)(
		"accepts the %s preference",
		(preference) => {
			expect(isThemePreference(preference)).toBe(true);
			expect(parseThemePreference(preference)).toBe(preference);
		},
	);

	it.each([null, undefined, "", "auto", "DARK", 1])(
		"falls back to system for %s",
		(value) => {
			expect(isThemePreference(value)).toBe(false);
			expect(parseThemePreference(value)).toBe("system");
		},
	);

	it("reads and writes the stable storage key", () => {
		const storage = createStorage();

		writeThemePreference(storage, "dark");

		expect(storage.setItem).toHaveBeenCalledWith(THEME_STORAGE_KEY, "dark");
		expect(readThemePreference(storage)).toBe("dark");
	});

	it("removes the saved override when system is selected", () => {
		const storage = createStorage("dark");

		writeThemePreference(storage, "system");

		expect(storage.removeItem).toHaveBeenCalledWith(THEME_STORAGE_KEY);
		expect(readThemePreference(storage)).toBe("system");
	});

	it("does not fail when browser storage is unavailable", () => {
		const storage: ThemeStorage = {
			getItem: () => {
				throw new Error("blocked");
			},
			setItem: () => {
				throw new Error("blocked");
			},
		};

		expect(readThemePreference(storage)).toBe("system");
		expect(() => writeThemePreference(storage, "dark")).not.toThrow();
	});

	it("resolves system preference from the operating system", () => {
		expect(resolveThemePreference("system", true)).toBe("dark");
		expect(resolveThemePreference("system", false)).toBe("light");
		expect(resolveThemePreference("light", true)).toBe("light");
		expect(resolveThemePreference("dark", false)).toBe("dark");
	});
});
