import { randomUUID } from "node:crypto";
import { load, type AnyNode } from "cheerio";

type ProtectedCode = { token: string; markdown: string; block: boolean };

function isLine(node: AnyNode): boolean {
  if (!("attribs" in node)) return false;
  return (
    ["div", "p"].includes(node.name) ||
    /(?:^|\s)(?:line|cm-line|code-line|line-content)(?:\s|$)/.test(
      node.attribs.class ?? "",
    ) ||
    "data-line" in node.attribs
  );
}

/** Browser DOM text with explicit breaks and highlighted line containers intact. */
function codeText(node: AnyNode): string {
  if (node.type === "text") return node.data;
  if ("attribs" in node) {
    if (node.name === "br") return "\n";
    if (["button", "svg", "script", "style"].includes(node.name)) return "";
    if (/\b(?:linenos|lineno|line-numbers)\b/.test(node.attribs.class ?? ""))
      return "";
  }
  if (!("children" in node)) return "";
  const children = node.children;
  const lineIndexes = children
    .map((child, index) =>
      child.type === "comment" ||
      (child.type === "text" && /^\s*$/.test(child.data))
        ? -1
        : index,
    )
    .filter((index) => index >= 0);
  if (
    lineIndexes.length &&
    lineIndexes.every((index) => isLine(children[index]))
  ) {
    let value = children.slice(0, lineIndexes[0]).map(codeText).join("");
    for (let i = 0; i < lineIndexes.length; i++) {
      if (i > 0) {
        const separator = children
          .slice(lineIndexes[i - 1] + 1, lineIndexes[i])
          .map(codeText)
          .join("");
        const previous = codeText(children[lineIndexes[i - 1]]);
        // CodeMirror/React lines already end in BR. That break and the line
        // container boundary describe the same LF, not an extra blank line.
        // Inspect the previous line itself so a genuinely empty line wrapper
        // still contributes its own boundary even when value already ends in LF.
        value += separator.includes("\n")
          ? previous.endsWith("\n") ? separator.replace("\n", "") : separator
          : (previous.endsWith("\n") ? "" : "\n") + separator;
      }
      value += codeText(children[lineIndexes[i]]);
    }
    return (
      value +
      children
        .slice(lineIndexes.at(-1)! + 1)
        .map(codeText)
        .join("")
    );
  }
  return children.map(codeText).join("");
}

function fence(text: string, minimum: number): string {
  const runs: string[] = text.match(/`+/g) ?? [];
  const longest = runs.reduce<number>((max, run) => Math.max(max, run.length), 0);
  return "`".repeat(Math.max(minimum, longest + 1));
}

function inlineCode(text: string): string {
  const value = text.replace(/\r\n?|\n/g, " ");
  const delimiter = fence(value, 1);
  const pad =
    value.startsWith("`") ||
    value.endsWith("`") ||
    (value.startsWith(" ") && value.endsWith(" ") && /\S/.test(value));
  return delimiter + (pad ? " " : "") + value + (pad ? " " : "") + delimiter;
}

/** Protect source code until every converter and Markdown postprocessor is done. */
export function protectHtmlCode(html: string): {
  html: string;
  restore(markdown: string): string;
} {
  if (!/<(?:pre|code)\b/i.test(html))
    return { html, restore: (markdown) => markdown };
  // Cheerio decodes entities once. Code is restored directly into Markdown and
  // must never pass through an HTML/entity decoder or Markdown cleanup again.
  const $ = load(html);
  const protectedCode: ProtectedCode[] = [];
  const prefix = "FCODE" + randomUUID().replaceAll("-", "");
  const token = () => prefix + "ITEM" + protectedCode.length + "END";

  function language(node: AnyNode): string {
    const code = $(node).find("code").first().get(0);
    const candidates = [code, node, ...$(node).parents().toArray()].filter(
      Boolean,
    ) as AnyNode[];
    for (const candidate of candidates) {
      if (
        !("attribs" in candidate) ||
        ["html", "body"].includes(candidate.name)
      )
        continue;
      for (const name of [
        "data-language",
        "data-lang",
        ...(candidate === node || candidate === code ? ["lang"] : []),
      ]) {
        const value = candidate.attribs[name];
        if (value && /^[\w.+-]{1,32}$/.test(value)) return value;
      }
      for (const name of (candidate.attribs.class ?? "").split(/\s+/)) {
        const match = name.match(
          /^(?:language-|lang-|highlight-(?:source-)?)([\w.+-]{1,32})$/,
        );
        if (match) return match[1];
        const sandpack = name.match(/^sp-(javascript|typescript|jsx|tsx|css|html|json)$/);
        if (sandpack) return sandpack[1];
      }
    }
    return "";
  }

  $("pre").each((_, node) => {
    if ($(node).parents("pre").length) return;
    if ($(node).parents(".linenos, .line-numbers").length) {
      $(node).remove();
      return;
    }
    const text = codeText(node).replace(/\r\n?/g, "\n");
    const delimiter = fence(text, 3);
    const marker = token();
    protectedCode.push({
      token: marker,
      block: true,
      markdown:
        delimiter +
        language(node) +
        "\n" +
        text +
        (text.endsWith("\n") ? "" : "\n") +
        delimiter,
    });
    $(node).replaceWith("<div>" + marker + "</div>");
  });
  $("code").each((_, node) => {
    if ($(node).parents("code").length) return;
    const marker = token();
    protectedCode.push({
      token: marker,
      block: false,
      markdown: inlineCode(codeText(node)),
    });
    $(node).replaceWith(marker);
  });
  if (!protectedCode.length) return { html, restore: (markdown) => markdown };

  return {
    html: $.html(),
    restore(markdown) {
      const byToken = new Map(protectedCode.map((code) => [code.token, code]));
      const restored = new Set<string>();
      const value = markdown.replace(
        new RegExp(prefix + "ITEM\\d+END", "g"),
        (marker, offset) => {
          const code = byToken.get(marker);
          if (!code) return marker;
          restored.add(marker);
          let replacement = code.markdown;
          if (code.block) {
            const lineStart = markdown.lastIndexOf("\n", offset - 1) + 1;
            const context = markdown.slice(lineStart, offset);
            if (/^[ \t>]*(?:(?:[-+*]|\d+[.)])[ \t]+)?$/.test(context)) {
              const continuation = context.replace(
                /(?:[-+*]|\d+[.)])[ \t]+$/,
                (match) => " ".repeat(match.length),
              );
              replacement = replacement.replaceAll("\n", "\n" + continuation);
            } else replacement = "\n\n" + replacement + "\n\n";
          }
          return replacement;
        },
      );
      if (restored.size !== protectedCode.length)
        throw new Error("HTML converter discarded protected source code");
      return value;
    },
  };
}
