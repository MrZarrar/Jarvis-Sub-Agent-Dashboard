/**
 * @file yaml.js
 * @description A tiny, dependency-free YAML-subset parser for skill frontmatter
 * (Phase H). Skills need one level more structure than notes' frontmatter
 * (server/lib/notes.js): `params:` and `steps:` are each a block list of flat
 * mappings, e.g.
 *
 *   steps:
 *     - type: shell
 *       command: "ls"
 *     - type: notify
 *       message: "done"
 *
 * Rather than special-case that one shape, this is a small indentation-based
 * recursive-descent parser that handles scalars, inline `[a, b]` arrays, block
 * scalars (`|`), block lists of scalars, block lists of mappings, and nested
 * mappings. Per the plan's "no arbitrary nesting" rule for skills, callers only
 * ever feed it shallow documents (frontmatter + two one-level-nested lists), but
 * the parser itself is generic over any depth since bounding it artificially
 * would just move the edge cases around rather than remove them.
 *
 * Kept separate from notes.js's parser: that one is intentionally simpler
 * (flat maps only) and is a stable, tested contract other modules already read;
 * this one is a superset built for skills' nested shape.
 */

function tokenize(text) {
  const lines = String(text || "").split(/\r?\n/);
  return lines.map((raw) => {
    const expanded = raw.replace(/\t/g, "    ");
    const trimmed = expanded.replace(/\s+$/, "");
    const indentMatch = trimmed.match(/^ */);
    const indent = indentMatch ? indentMatch[0].length : 0;
    const content = trimmed.slice(indent);
    const blank = content === "" || content.startsWith("#");
    return { indent, content, blank };
  });
}

/** Parse a YAML-subset document into a plain JS value (object/array/scalar). */
function parseYaml(text) {
  const lines = tokenize(text);
  const cursor = { i: 0 };
  skipBlank(lines, cursor);
  if (cursor.i >= lines.length) return {};
  return parseNode(lines, cursor, lines[cursor.i].indent);
}

function skipBlank(lines, cursor) {
  while (cursor.i < lines.length && lines[cursor.i].blank) cursor.i++;
}

function parseNode(lines, cursor, indent) {
  skipBlank(lines, cursor);
  if (cursor.i >= lines.length || lines[cursor.i].indent < indent) return null;
  const line = lines[cursor.i];
  if (line.content === "-" || line.content.startsWith("- ")) {
    return parseSeq(lines, cursor, indent);
  }
  return parseMap(lines, cursor, indent);
}

function parseSeq(lines, cursor, indent) {
  const arr = [];
  for (;;) {
    skipBlank(lines, cursor);
    if (cursor.i >= lines.length) break;
    const line = lines[cursor.i];
    if (line.indent !== indent) break;
    if (!(line.content === "-" || line.content.startsWith("- "))) break;
    const rest = line.content === "-" ? "" : line.content.slice(2);
    cursor.i++;
    if (rest === "") {
      skipBlank(lines, cursor);
      if (cursor.i < lines.length && lines[cursor.i].indent > indent) {
        arr.push(parseNode(lines, cursor, lines[cursor.i].indent));
      } else {
        arr.push(null);
      }
      continue;
    }
    const kv = matchKV(rest);
    if (kv) {
      const map = {};
      setKV(map, kv.key, kv.value, lines, cursor, indent + 2);
      for (;;) {
        skipBlank(lines, cursor);
        if (cursor.i >= lines.length || lines[cursor.i].indent !== indent + 2) break;
        const kv2 = matchKV(lines[cursor.i].content);
        if (!kv2) break;
        cursor.i++;
        setKV(map, kv2.key, kv2.value, lines, cursor, indent + 2);
      }
      arr.push(map);
    } else {
      arr.push(parseScalar(rest));
    }
  }
  return arr;
}

function parseMap(lines, cursor, indent) {
  const map = {};
  for (;;) {
    skipBlank(lines, cursor);
    if (cursor.i >= lines.length) break;
    const line = lines[cursor.i];
    if (line.indent !== indent) break;
    const kv = matchKV(line.content);
    if (!kv) break;
    cursor.i++;
    setKV(map, kv.key, kv.value, lines, cursor, indent);
  }
  return map;
}

function matchKV(content) {
  const m = content.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
  if (!m) return null;
  return { key: m[1], value: m[2] };
}

/** Assign `map[key]`, consuming any nested block from `lines` the value implies. */
function setKV(map, key, value, lines, cursor, ownIndent) {
  if (value === "|" || value === "|-" || value === ">") {
    skipBlank(lines, cursor);
    const blockIndent = cursor.i < lines.length ? lines[cursor.i].indent : ownIndent + 2;
    const collected = [];
    while (
      cursor.i < lines.length &&
      (lines[cursor.i].blank || lines[cursor.i].indent >= blockIndent)
    ) {
      const l = lines[cursor.i];
      collected.push(l.blank ? "" : " ".repeat(Math.max(0, l.indent - blockIndent)) + l.content);
      cursor.i++;
    }
    // Trim trailing blank lines the tokenizer/loop swept up past the block's end.
    while (collected.length && collected[collected.length - 1] === "") collected.pop();
    map[key] = collected.join("\n");
    return;
  }
  if (value === "") {
    skipBlank(lines, cursor);
    if (cursor.i < lines.length && lines[cursor.i].indent > ownIndent) {
      map[key] = parseNode(lines, cursor, lines[cursor.i].indent);
    } else {
      map[key] = null;
    }
    return;
  }
  map[key] = parseScalar(value);
}

function parseScalar(value) {
  const v = value.trim();
  if (v.startsWith("[") && v.endsWith("]")) {
    return v
      .slice(1, -1)
      .split(",")
      .map((s) => unquote(s.trim()))
      .filter((s) => s !== "");
  }
  return unquote(v);
}

function unquote(s) {
  if (s.length >= 2 && ((s[0] === '"' && s.endsWith('"')) || (s[0] === "'" && s.endsWith("'")))) {
    return s.slice(1, -1);
  }
  if (s === "true") return true;
  if (s === "false") return false;
  if (s === "null" || s === "~" || s === "") return s === "" ? "" : null;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  return s;
}

module.exports = { parseYaml };
