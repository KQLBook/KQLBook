"use client";

import Script from "next/script";
import * as stylex from "@stylexjs/stylex";
import { useCallback, useEffect, useRef } from "react";

import { styles } from "@/styles/kql.stylex";

type TurnstileOptions = {
	sitekey: string;
	action: string;
	theme: "auto";
	callback: (token: string) => void;
	"error-callback": () => void;
	"expired-callback": () => void;
	"timeout-callback": () => void;
};

type TurnstileApi = {
	render: (container: HTMLElement, options: TurnstileOptions) => string;
	remove: (widgetId: string) => void;
};

declare global {
	interface Window {
		turnstile?: TurnstileApi;
	}
}

type TurnstileChallengeProps = {
	siteKey: string;
	onToken: (token: string) => void;
	onError: (message: string) => void;
	title?: string;
	description?: string;
};

export function TurnstileChallenge({
	siteKey,
	onToken,
	onError,
	title = "Verify this generation request",
	description = "Complete Cloudflare verification. Generation retries when a token is ready.",
}: TurnstileChallengeProps) {
	const containerRef = useRef<HTMLDivElement | null>(null);
	const widgetIdRef = useRef<string | null>(null);

	const renderWidget = useCallback(() => {
		if (
			!containerRef.current ||
			!window.turnstile ||
			widgetIdRef.current
		) {
			return;
		}

		widgetIdRef.current = window.turnstile.render(containerRef.current, {
			sitekey: siteKey,
			action: "ai-generate",
			theme: "auto",
			callback: onToken,
			"error-callback": () =>
				onError("Verification could not load. Refresh it and try again."),
			"expired-callback": () =>
				onError("Verification expired. Complete the challenge again."),
			"timeout-callback": () =>
				onError("Verification timed out. Complete the challenge again."),
		});
	}, [onError, onToken, siteKey]);

	useEffect(
		() => () => {
			if (widgetIdRef.current && window.turnstile) {
				window.turnstile.remove(widgetIdRef.current);
				widgetIdRef.current = null;
			}
		},
		[],
	);

	return (
		<section
			aria-labelledby="verification-title"
			{...stylex.props(styles.challengeBox)}
		>
			<div>
				<h2 id="verification-title" {...stylex.props(styles.challengeTitle)}>
					{title}
				</h2>
				<p {...stylex.props(styles.challengeDescription)}>
					{description}
				</p>
			</div>
			<Script
				src="https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit"
				strategy="afterInteractive"
				onReady={renderWidget}
				onError={() =>
					onError("Verification script could not load. Check your connection.")
				}
			/>
			<div ref={containerRef} aria-label="Cloudflare verification challenge" />
			<p role="status" {...stylex.props(styles.visuallyHidden)}>
				Waiting for verification.
			</p>
		</section>
	);
}
