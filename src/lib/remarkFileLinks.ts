/**
 * Remark plugin: turn bare file paths in prose into links.
 *
 * The model often writes a path as plain text
 * (`D:\project\renders\out.mp4`) instead of markdown link syntax, so it never
 * became clickable and the preview panel could not be opened for it.
 *
 * Only `text` nodes are visited, so fenced code blocks and inline code are left
 * untouched. The resulting link url is the raw path; StreamMessage routes
 * non-http links to the file preview panel.
 */

const EXTENSIONS = [
  "md",
  "markdown",
  "mp4",
  "mov",
  "webm",
  "m4v",
  "png",
  "jpe?g",
  "gif",
  "webp",
  "svg",
  "json",
  "jsonl",
  "txt",
  "log",
  "csv",
  "tsv",
  "ts",
  "tsx",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "py",
  "rs",
  "go",
  "java",
  "sh",
  "ps1",
  "sql",
  "html",
  "css",
  "ya?ml",
  "toml",
  "mp3",
  "wav",
  "m4a",
].join("|");

// A path must contain at least one separator, which keeps ordinary words out.
// The first segment may be bare (`renders/out.md`) or a drive (`D:\...`).
const SEG = `[^\\s"'\`<>|*?，。；：、（）【】]`;
const PATH_PATTERN = new RegExp(
  `(?:[A-Za-z]:)?${SEG}*[\\\\/]${SEG}*\\.(?:${EXTENSIONS})\\b`,
  "gi"
);

interface MdNode {
  type: string;
  value?: string;
  url?: string;
  children?: MdNode[];
}

function linkifyText(value: string): MdNode[] | null {
  const matches = Array.from(value.matchAll(PATH_PATTERN)).filter((match) => {
    // Never touch URLs: `https://host/a.png` must stay a normal link.
    const raw = match[0];
    if (raw.includes("://")) return false;
    if (raw.startsWith("//")) return false;
    return true;
  });

  if (matches.length === 0) return null;

  const out: MdNode[] = [];
  let cursor = 0;

  for (const match of matches) {
    const start = match.index ?? 0;
    const raw = match[0];

    if (start > cursor) {
      out.push({ type: "text", value: value.slice(cursor, start) });
    }
    out.push({
      type: "link",
      url: raw,
      children: [{ type: "text", value: raw }],
    });
    cursor = start + raw.length;
  }

  if (cursor < value.length) {
    out.push({ type: "text", value: value.slice(cursor) });
  }

  return out;
}

function walk(node: MdNode): void {
  if (!node.children) return;

  for (let i = 0; i < node.children.length; i += 1) {
    const child = node.children[i];

    if (child.type === "text" && typeof child.value === "string") {
      const replaced = linkifyText(child.value);
      if (replaced) {
        node.children.splice(i, 1, ...replaced);
        i += replaced.length - 1;
      }
      continue;
    }

    // Do not descend into existing links or code.
    if (child.type === "link" || child.type === "code" || child.type === "inlineCode") {
      continue;
    }

    walk(child);
  }
}

export function remarkFileLinks() {
  return (tree: MdNode) => {
    walk(tree);
  };
}
