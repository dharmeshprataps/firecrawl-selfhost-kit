import { beforeEach, describe, expect, it, vi } from "vitest";
import { transformHtml } from "@mendable/firecrawl-rs";
import { protectHtmlCode } from "./html-code-preservation";

const state = vi.hoisted(() => ({
  config: {
    HTML_TO_MARKDOWN_SERVICE_URL: undefined as string | undefined,
    USE_GO_MARKDOWN_PARSER: false,
  },
  http: vi.fn(),
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));
vi.mock("../config", () => ({ config: state.config }));
vi.mock("../services/sentry", () => ({}));
vi.mock("@sentry/node", () => ({ captureException: vi.fn() }));
vi.mock("./logger", () => ({ logger: state.logger }));
vi.mock("./html-to-markdown-client", () => ({
  convertHTMLToMarkdownWithHttpService: state.http,
}));
import { parseMarkdown } from "./html-to-markdown";
const TurndownService = require("turndown");
const convertProtected = (html: string) => new TurndownService().turndown(html);
const restore = (html: string) => {
  const code = protectHtmlCode(html);
  return code.restore(convertProtected(code.html));
};
const python = "values = [\n    n < 3 and n >= 0,\n]\nprint(values[0])\n";
const pythonHtml =
  '<div class="highlight-python notranslate"><div class="highlight"><pre><span></span><span class="n">values</span> = [\n    <span class="n">n</span> &lt; 3 and n &gt;= 0,\n]\nprint(values[0])\n</pre></div></div>';
const jsx =
  "export function App() {\n  return <button onClick={() => setN(n + 1)}>Next & more</button>;\n}";
const jsxHtml =
  '<pre><code class="language-jsx"><span class="line">export function App() {</span><span class="line">  return &lt;button onClick={() =&gt; setN(n + 1)}&gt;Next &amp; more&lt;/button&gt;;</span><span class="line">}</span></code></pre>';

const reactCodeMirror = "function MyButton() {\n  return (\n    <button>I'm a button</button>\n  );\n}\n";
const reactCodeMirrorHtml =
  '<pre class="sp-cm sp-pristine sp-javascript flex align-start"><code class="sp-pre-placeholder grow-[2]">' +
  '<div class="cm-line "><span class="sp-syntax-keyword">function</span> <span class="sp-syntax-definition">MyButton</span><span class="sp-syntax-punctuation">(</span><span class="sp-syntax-punctuation">)</span> <span class="sp-syntax-punctuation">{</span><br></div>' +
  '<div class="cm-line ">  <span class="sp-syntax-keyword">return</span> <span class="sp-syntax-punctuation">(</span><br></div>' +
  '<div class="cm-line ">    &lt;button&gt;I\'m a button&lt;/button&gt;<br></div>' +
  '<div class="cm-line ">  );<br></div><div class="cm-line ">}<br></div></code></pre>';

beforeEach(() => {
  vi.clearAllMocks();
  state.config.HTML_TO_MARKDOWN_SERVICE_URL = undefined;
  state.config.USE_GO_MARKDOWN_PARSER = false;
  state.http.mockImplementation(async (html: string) => convertProtected(html));
});

describe("literal HTML code preservation", () => {
  it("preserves Sphinx syntax spans, operators, indentation and bracketed newlines", () => {
    expect(restore(pythonHtml)).toBe("```python\n" + python + "```");
  });
  it("separates React highlighted lines without joining their words", () => {
    expect(restore(jsxHtml)).toBe("```jsx\n" + jsx + "\n```");
  });
  it("retains blank highlighted lines and explicit br line breaks", () => {
    expect(
      restore(
        '<pre><code><span class="line">one</span><span class="line"></span><span class="line">  three</span></code></pre>',
      ),
    ).toBe("```\none\n\n  three\n```");
    expect(restore("<pre>one<br>  two</pre>")).toBe("```\none\n  two\n```");
  });
  it("preserves actual React CodeMirror lines with terminal BR exactly once", () => {
    expect(restore(reactCodeMirrorHtml)).toBe("```javascript\n" + reactCodeMirror + "```");
    expect(restore('<pre><code><div class="cm-line">one<br></div>\n<div class="cm-line"><br></div>\n<div class="cm-line">three<br></div></code></pre>'))
      .toBe("```\none\n\nthree\n```");
    expect(restore('<pre><code><div class="cm-line">one<br></div><div class="cm-line"></div><div class="cm-line">three</div></code></pre>'))
      .toBe("```\none\n\nthree\n```");
  });
  it("decodes entities once and preserves code-like literal entity text", () => {
    expect(
      restore("<pre>const text = &quot;&amp;lt;tag&amp;gt;&quot;;\n</pre>"),
    ).toBe('```\nconst text = "&lt;tag&gt;";\n```');
  });
  it("chooses fences longer than backticks inside source code", () => {
    expect(
      restore('<pre class="language-js">const ticks = "```";\n</pre>'),
    ).toBe('````js\nconst ticks = "```";\n````');
    expect(
      restore("<p>Use <code>`value` &lt; other &amp;&amp; n[0]</code>.</p>"),
    ).toBe("Use `` `value` < other && n[0] ``.");
  });
  it("does not mistake the document's human language for code language", () => {
    expect(
      restore('<html lang="en"><body><pre>hello</pre></body></html>'),
    ).toBe("```\nhello\n```");
  });
  it("preserves existing spaces in inline code with safe CommonMark padding", () => {
    expect(restore("<p><code> a &lt; b </code></p>")).toBe("`  a < b  `");
  });
  it("retains list/blockquote indentation around restored fences", () => {
    const code = protectHtmlCode("<pre>  nested</pre>");
    const token = code.html.match(/FCODE[a-f0-9]+ITEM0END/)![0];
    expect(code.restore("> " + token)).toBe("> ```\n>   nested\n> ```");
    expect(code.restore("- " + token)).toBe("- ```\n    nested\n  ```");
  });
  it("rejects a converter that discards protected code", () => {
    const code = protectHtmlCode(pythonHtml);
    expect(() => code.restore("partial document without source code")).toThrow(
      "discarded protected source code",
    );
  });
  it("leaves documents without code unchanged", () => {
    const original = "<p>Plain &amp; useful text.</p>";
    const code = protectHtmlCode(original);
    expect(code.html).toBe(original);
    expect(code.restore("Plain & useful text.")).toBe("Plain & useful text.");
  });
});

describe("every HTML-to-Markdown conversion path", () => {
  it.each(["Turndown", "Go", "HTTP"])(
    "preserves literal code after native postprocessing through %s",
    async (route) => {
      state.config.USE_GO_MARKDOWN_PARSER = route === "Go";
      state.config.HTML_TO_MARKDOWN_SERVICE_URL =
        route === "HTTP" ? "http://127.0.0.1:0" : undefined;
      const input =
        '<main><h1>Source examples</h1><a href="#skip">Skip to Content</a>' +
        pythonHtml +
        jsxHtml +
        reactCodeMirrorHtml +
        "<p>Use <code>a &lt; b &amp;&amp; n[0]</code>.</p></main>";
      // Exercise the same native HTML sanitizer that runs before parseMarkdown.
      const cleaned = await transformHtml({
        html: input,
        url: "https://example.com/docs",
        onlyMainContent: true,
        includeTags: [],
        excludeTags: [],
      });
      const result = await parseMarkdown(cleaned);
      expect(result).toContain("```python\n" + python + "```");
      expect(result).toContain("```jsx\n" + jsx + "\n```");
      expect(result).toContain("```javascript\n" + reactCodeMirror + "```");
      expect(result).toContain("`a < b && n[0]`");
      expect(result).not.toContain("\\\n");
      expect(result).toContain("Source examples");
      expect(state.logger.error).not.toHaveBeenCalled();
      expect(state.logger.warn).not.toHaveBeenCalled();
      if (route === "HTTP") {
        expect(state.http).toHaveBeenCalledTimes(1);
        expect(state.http.mock.calls[0][0]).not.toContain("values");
      }
    },
  );
  it("falls back when an HTTP converter silently omits source code", async () => {
    state.config.HTML_TO_MARKDOWN_SERVICE_URL = "http://127.0.0.1:0";
    state.http.mockResolvedValue("partial result");
    expect(await parseMarkdown(pythonHtml)).toContain(
      "```python\n" + python + "```",
    );
    expect(state.logger.error).toHaveBeenCalled();
  });
  it("does not remove skip-link-like strings that are source code", async () => {
    const result = await parseMarkdown(
      '<a href="#skip">Skip to Content</a><pre>[Skip to Content](#not-a-link-in-source)\nitems = [\n    1,\n]\n</pre>',
    );
    expect(result).toContain(
      "[Skip to Content](#not-a-link-in-source)\nitems = [\n    1,\n]\n",
    );
    expect(result).not.toContain("\\\n");
    expect(result.match(/\[Skip to Content\]/g)).toHaveLength(1);
  });
});
