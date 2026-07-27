"use client";

import { inferAdditionalFields } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";
import type { KqlAuth } from "./server";

export const authClient = createAuthClient({
	plugins: [inferAdditionalFields<KqlAuth>()],
});

export const { signIn, signOut, useSession } = authClient;
