import "server-only";

import {
	AuthConfigurationError,
	createAuth,
	type AuthSession,
	type UserRole,
} from "./server";

type SessionSource = Request | Headers;

export type AuthErrorCode = "AUTH_REQUIRED" | "ADMIN_REQUIRED";

export interface CurrentUser {
	id: string;
	name: string;
	email: string;
	image: string | null;
	role: UserRole;
}

export class AuthError extends Error {
	readonly code: AuthErrorCode;
	readonly status: 401 | 403;

	constructor(
		code: AuthErrorCode,
		message: string,
		status: 401 | 403,
	) {
		super(message);
		this.name = "AuthError";
		this.code = code;
		this.status = status;
	}
}

function sourceHeaders(source: SessionSource): Headers {
	return source instanceof Request ? source.headers : source;
}

function currentUser(session: AuthSession): CurrentUser {
	return {
		id: session.user.id,
		name: session.user.name,
		email: session.user.email,
		image: session.user.image ?? null,
		role: session.user.role === "admin" ? "admin" : "user",
	};
}

export async function optionalSession(
	source: SessionSource,
): Promise<AuthSession | null> {
	try {
		const auth = await createAuth(source);
		return await auth.api.getSession({
			headers: sourceHeaders(source),
			query: {
				disableCookieCache: true,
			},
		});
	} catch (error) {
		if (error instanceof AuthConfigurationError) {
			return null;
		}
		throw error;
	}
}

export async function requireSession(
	source: SessionSource,
): Promise<AuthSession> {
	const session = await optionalSession(source);
	if (!session) {
		throw new AuthError(
			"AUTH_REQUIRED",
			"Sign in to continue.",
			401,
		);
	}
	return session;
}

export async function getCurrentUser(
	source: SessionSource,
): Promise<CurrentUser | null> {
	const session = await optionalSession(source);
	return session ? currentUser(session) : null;
}

export async function requireCurrentUser(
	source: SessionSource,
): Promise<CurrentUser> {
	return currentUser(await requireSession(source));
}

export async function requireAdmin(
	source: SessionSource,
): Promise<CurrentUser & { role: "admin" }> {
	const user = await requireCurrentUser(source);
	if (user.role !== "admin") {
		throw new AuthError(
			"ADMIN_REQUIRED",
			"Administrator access is required.",
			403,
		);
	}
	return user as CurrentUser & { role: "admin" };
}

export function isAuthError(error: unknown): error is AuthError {
	return error instanceof AuthError;
}
