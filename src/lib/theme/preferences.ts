export const THEME_STORAGE_KEY = "kql-book-theme";

export type ThemePreference = "system" | "light" | "dark";
export type ResolvedTheme = Exclude<ThemePreference, "system">;

export interface ThemeStorage {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
	removeItem?(key: string): void;
}

export function isThemePreference(value: unknown): value is ThemePreference {
	return value === "system" || value === "light" || value === "dark";
}

export function parseThemePreference(value: unknown): ThemePreference {
	return isThemePreference(value) ? value : "system";
}

export function readThemePreference(
	storage: ThemeStorage | null | undefined,
): ThemePreference {
	if (!storage) {
		return "system";
	}

	try {
		return parseThemePreference(storage.getItem(THEME_STORAGE_KEY));
	} catch {
		return "system";
	}
}

export function writeThemePreference(
	storage: ThemeStorage | null | undefined,
	preference: ThemePreference,
): void {
	if (!storage) {
		return;
	}

	try {
		if (preference === "system" && storage.removeItem) {
			storage.removeItem(THEME_STORAGE_KEY);
			return;
		}

		storage.setItem(THEME_STORAGE_KEY, preference);
	} catch {
		// The in-memory preference still applies when storage is unavailable.
	}
}

export function resolveThemePreference(
	preference: ThemePreference,
	prefersDark: boolean,
): ResolvedTheme {
	if (preference === "system") {
		return prefersDark ? "dark" : "light";
	}

	return preference;
}
