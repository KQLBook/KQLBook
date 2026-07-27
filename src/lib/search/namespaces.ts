const PUBLIC_NAMESPACE = "public";
const PRIVATE_NAMESPACE_PREFIX = "private:";
const MAX_NAMESPACE_BYTES = 64;

export function publicSearchNamespace(): string {
	return PUBLIC_NAMESPACE;
}

export function privateSearchNamespace(userId: string): string {
	const normalized = userId.trim();
	const namespace = `${PRIVATE_NAMESPACE_PREFIX}${normalized}`;
	if (
		!normalized ||
		!/^[A-Za-z0-9_-]+$/.test(normalized) ||
		new TextEncoder().encode(namespace).length > MAX_NAMESPACE_BYTES
	) {
		throw new Error("Cannot derive a private search namespace from this user ID.");
	}
	return namespace;
}

export function namespacesForViewer(userId: string | null): string[] {
	return userId
		? [publicSearchNamespace(), privateSearchNamespace(userId)]
		: [publicSearchNamespace()];
}
