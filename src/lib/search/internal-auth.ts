import { timingSafeEqual } from "node:crypto";

function bearerToken(authorization: string | null): string | null {
	if (!authorization) {
		return null;
	}
	const match = /^Bearer ([^\s]+)$/i.exec(authorization);
	return match?.[1] ?? null;
}

async function sha256(value: string): Promise<Uint8Array> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(value),
	);
	return new Uint8Array(digest);
}

export async function hasValidBearerSecret(
	authorization: string | null,
	expectedSecret: string,
): Promise<boolean> {
	const token = bearerToken(authorization);
	if (!token) {
		// Hash a fixed placeholder so malformed and incorrect credentials still
		// take the same comparison path.
		const [providedDigest, expectedDigest] = await Promise.all([
			sha256("missing-bearer-token"),
			sha256(expectedSecret),
		]);
		return timingSafeEqual(providedDigest, expectedDigest) && false;
	}

	const [providedDigest, expectedDigest] = await Promise.all([
		sha256(token),
		sha256(expectedSecret),
	]);
	return timingSafeEqual(providedDigest, expectedDigest);
}

