import { describe, expect, it } from "vitest";

import type { QueryRecord } from "../../../lib/db/types";
import { KqlSyntaxValidationError } from "../../../lib/kql/syntax-validation";
import {
  createQuerySchema,
  handleApiError,
  historyClickSchema,
  parseJson,
  parseListOptions,
  publicApiJson,
  queryIdSchema,
  queryResponse,
  requireSameOrigin,
  updateQuerySchema,
} from "./_shared";

describe("query API validation", () => {
  it("defaults a newly saved query to private", () => {
    const input = createQuerySchema.parse({
      title: "  Rare process launches  ",
      kql: "  DeviceProcessEvents | take 10  ",
      aiMetadataAcknowledged: true,
    });

    expect(input).toMatchObject({
      title: "Rare process launches",
      kql: "DeviceProcessEvents | take 10",
      visibility: "private",
      explanation: "",
      aiMetadataAcknowledged: true,
    });
  });

  it("allows an explicit public selection at creation time", () => {
    const input = createQuerySchema.parse({
      title: "Failed sign-ins",
      kql: "SigninLogs | take 10",
      visibility: "public",
      aiMetadataAcknowledged: true,
    });

    expect(input.visibility).toBe("public");
  });

  it("requires an explicit AI metadata acknowledgement", () => {
    expect(() =>
      createQuerySchema.parse({
        title: "Failed sign-ins",
        kql: "SigninLogs | take 10",
      }),
    ).toThrow();
  });

  it.each([
    "description",
    "dialect",
    "tables",
    "operators",
    "tags",
    "assumptions",
    "ownerId",
  ])("keeps server-owned field %s out of the create payload", (field) => {
    expect(() =>
      createQuerySchema.parse({
        title: "Failed sign-ins",
        kql: "SigninLogs | take 10",
        aiMetadataAcknowledged: true,
        [field]: field === "dialect" ? "sentinel" : [],
      }),
    ).toThrow();
  });

  it("accepts a dialect confirmation after AI asks for one", () => {
    const input = createQuerySchema.parse({
      title: "Resource inventory",
      kql: "Resources | take 10",
      aiMetadataAcknowledged: true,
      confirmedDialect: "azure-resource-graph",
    });

    expect(input.confirmedDialect).toBe("azure-resource-graph");
  });

  it("keeps ownership and visibility out of the general update payload", () => {
    expect(() =>
      updateQuerySchema.parse({
        title: "Changed",
        ownerId: crypto.randomUUID(),
      }),
    ).toThrow();
    expect(() =>
      updateQuerySchema.parse({
        visibility: "public",
      }),
    ).toThrow();
  });

  it("requires at least one editable field", () => {
    expect(() => updateQuerySchema.parse({})).toThrow();
  });

  it("accepts saved and imported query IDs", () => {
    const savedId = crypto.randomUUID();
    const importedId = "imported_query_d78188549920d5f192d5ad1872e45ec7";

    expect(queryIdSchema.parse(savedId)).toBe(savedId);
    expect(queryIdSchema.parse(importedId)).toBe(importedId);
    expect(historyClickSchema.parse({ queryId: importedId })).toEqual({
      queryId: importedId,
    });
  });

  it("rejects unrecognized query ID formats", () => {
    expect(() => queryIdSchema.parse("imported_query_../../admin")).toThrow();
    expect(() =>
      queryIdSchema.parse("imported_version_d78188549920d5f192d5ad1872e45ec7"),
    ).toThrow();
  });
});

describe("query API response", () => {
  it("exposes the current immutable version as the query's editable fields", () => {
    const queryId = crypto.randomUUID();
    const versionId = crypto.randomUUID();
    const query = {
      id: queryId,
      ownerId: crypto.randomUUID(),
      visibility: "private",
      moderationStatus: "visible",
      currentVersionId: versionId,
      starCount: 0,
      sourceRepository: "Azure/Azure-Sentinel",
      sourceRepositoryUrl: "https://github.com/Azure/Azure-Sentinel",
      starredByViewer: false,
      createdAt: "2026-07-26T00:00:00.000Z",
      updatedAt: "2026-07-26T00:00:00.000Z",
      publishedAt: null,
      provenance: null,
      currentVersion: {
        id: versionId,
        queryId,
        versionNumber: 2,
        title: "Rare process launches",
        kql: "DeviceProcessEvents | take 10",
        description: "Find uncommon processes.",
        explanation: "Review rare process names.",
        dialect: "defender-xdr",
        tables: ["DeviceProcessEvents"],
        operators: ["take"],
        tags: ["process"],
        assumptions: [],
        validationWarnings: [],
        aiGenerated: false,
        generationModel: null,
        contentHash: "example-content-hash",
        createdByUserId: crypto.randomUUID(),
        createdAt: "2026-07-26T00:01:00.000Z",
      },
    } satisfies QueryRecord;

    expect(queryResponse(query)).toMatchObject({
      id: queryId,
      title: "Rare process launches",
      kql: "DeviceProcessEvents | take 10",
      dialect: "defender-xdr",
      tables: ["DeviceProcessEvents"],
      sourceRepository: "Azure/Azure-Sentinel",
      sourceRepositoryUrl: "https://github.com/Azure/Azure-Sentinel",
      versionNumber: 2,
      currentVersion: {
        id: versionId,
      },
    });
  });

  it("serializes KQL parser failures as private 422 responses", async () => {
    const response = handleApiError(
      new KqlSyntaxValidationError([
        {
          code: "KS006",
          message: "Missing expression",
          severity: "error",
          start: 19,
          length: 0,
          line: 1,
          column: 20,
        },
      ]),
    );

    expect(response.status).toBe(422);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "invalid_kql",
        message: "Fix the KQL errors and try again.",
        details: {
          diagnostics: [
            {
              code: "KS006",
              message: "Missing expression",
              severity: "error",
              start: 19,
              length: 0,
              line: 1,
              column: 20,
            },
          ],
        },
      },
    });
  });
});

describe("request protections", () => {
  it("rejects cross-origin mutations", () => {
    const request = new Request("https://kqlbook.com/api/queries", {
      headers: {
        origin: "https://attacker.example",
        "sec-fetch-site": "cross-site",
      },
    });

    expect(() => requireSameOrigin(request)).toThrowError(
      expect.objectContaining({
        status: 403,
        code: "cross_origin_request",
      }),
    );
  });

  it("accepts same-origin mutations", () => {
    const request = new Request("https://kqlbook.com/api/queries", {
      headers: {
        origin: "https://kqlbook.com",
        "sec-fetch-site": "same-origin",
      },
    });

    expect(() => requireSameOrigin(request)).not.toThrow();
  });

  it("requires JSON when a route accepts a body", async () => {
    const request = new Request("https://kqlbook.com/api/queries", {
      method: "POST",
      body: "title=Example",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
    });

    await expect(parseJson(request, createQuerySchema)).rejects.toMatchObject({
      status: 415,
      code: "unsupported_media_type",
    });
  });

  it("bounds list pagination", () => {
    const request = new Request(
      "https://kqlbook.com/api/queries?limit=101",
    );

    expect(() => parseListOptions(request)).toThrowError(
      expect.objectContaining({
        status: 422,
        code: "validation_error",
      }),
    );
  });

  it("allows shared caching for the anonymous public feed", () => {
    const response = publicApiJson({ items: [] });

    expect(response.headers.get("cache-control")).toContain("public");
    expect(response.headers.get("cache-control")).toContain("s-maxage=300");
  });
});
