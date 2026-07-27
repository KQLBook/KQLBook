import { CodeBlock } from "@astryxdesign/core/CodeBlock";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { tokenizeKql } from "./tokenize";

describe("Astryx CodeBlock KQL compatibility", () => {
	it("renders KQL tokens through the CodeBlock span highlighter", () => {
		const markup = renderToStaticMarkup(
			<CodeBlock
				code={'SigninLogs\n| where ResultType != 0\n| take 10'}
				language="kql"
				tokenizer={tokenizeKql}
				highlightMode="spans"
				hasCopyButton={false}
			/>,
		);

		expect(markup).toContain("astryx-token-keyword");
		expect(markup).toContain("astryx-token-operator");
		expect(markup).toContain("astryx-token-number");
		expect(markup).toContain("SigninLogs");
	});
});
