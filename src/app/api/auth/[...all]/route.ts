import { createAuth } from "@/lib/auth/server";
import { toNextJsHandler } from "better-auth/next-js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const handlers = toNextJsHandler(async (request) =>
	(await createAuth(request)).handler(request),
);

export const GET = handlers.GET;
export const POST = handlers.POST;
