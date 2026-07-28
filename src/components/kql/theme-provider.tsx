"use client";

import { Theme } from "@astryxdesign/core/theme";
import {
	createContext,
	useCallback,
	useContext,
	useMemo,
	useSyncExternalStore,
} from "react";

import {
	parseThemePreference,
	readThemePreference,
	THEME_STORAGE_KEY,
	type ThemePreference,
	writeThemePreference,
} from "@/lib/theme/preferences";
import { kqlBookTheme } from "@/styles/kql-book";

type ThemePreferenceContextValue = {
	preference: ThemePreference;
	setPreference: (preference: ThemePreference) => void;
};

const ThemePreferenceContext =
	createContext<ThemePreferenceContextValue | null>(null);

const preferenceListeners = new Set<() => void>();
let clientPreference: ThemePreference | null = null;
let storageListenerAttached = false;

function syncPreferenceAttribute(preference: ThemePreference) {
	document.documentElement.dataset.themePreference = preference;
}

function notifyPreferenceListeners() {
	for (const listener of preferenceListeners) {
		listener();
	}
}

function handleStorageChange(event: StorageEvent) {
	if (event.key !== THEME_STORAGE_KEY) {
		return;
	}

	clientPreference = parseThemePreference(event.newValue);
	syncPreferenceAttribute(clientPreference);
	notifyPreferenceListeners();
}

function subscribeToPreference(listener: () => void) {
	preferenceListeners.add(listener);

	if (!storageListenerAttached) {
		window.addEventListener("storage", handleStorageChange);
		storageListenerAttached = true;
	}

	return () => {
		preferenceListeners.delete(listener);

		if (preferenceListeners.size === 0 && storageListenerAttached) {
			window.removeEventListener("storage", handleStorageChange);
			storageListenerAttached = false;
		}
	};
}

function getBrowserStorage(): Storage | null {
	try {
		return window.localStorage;
	} catch {
		return null;
	}
}

function getClientPreference(): ThemePreference {
	if (clientPreference === null) {
		clientPreference = readThemePreference(getBrowserStorage());
		syncPreferenceAttribute(clientPreference);
	}

	return clientPreference;
}

function getServerPreference(): ThemePreference {
	return "system";
}

function setClientPreference(preference: ThemePreference) {
	clientPreference = preference;
	syncPreferenceAttribute(preference);
	writeThemePreference(getBrowserStorage(), preference);
	notifyPreferenceListeners();
}

export function KqlThemeProvider({
	children,
}: {
	children: React.ReactNode;
}) {
	const preference = useSyncExternalStore(
		subscribeToPreference,
		getClientPreference,
		getServerPreference,
	);
	const setPreference = useCallback((nextPreference: ThemePreference) => {
		setClientPreference(nextPreference);
	}, []);
	const contextValue = useMemo(
		() => ({ preference, setPreference }),
		[preference, setPreference],
	);

	return (
		<ThemePreferenceContext value={contextValue}>
			<Theme theme={kqlBookTheme} mode={preference}>
				{children}
			</Theme>
		</ThemePreferenceContext>
	);
}

export function useThemePreference() {
	const context = useContext(ThemePreferenceContext);

	if (!context) {
		throw new Error("useThemePreference must be used within KqlThemeProvider");
	}

	return context;
}
