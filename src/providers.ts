import type * as monaco from "monaco-editor/esm/vs/editor/editor.api";

import { gcodeData, findGcode, GcodeInfo, GcodeParameter } from "./gcodes";
import { expressionData } from "./expressions";
import { getMachineContext } from "./objectmodel/machine-context";
import { getLocalVariables } from "./gcodes/local-variables";
import { getMemberDeprecation, getPathDeprecation } from "./objectmodel/deprecations";
import { getEnumValuesForPath } from "./objectmodel/enums";
// Re-export the runtime-context helpers so consumers (Vue DWC, React DuetWebUI, ...) can install a context
// without adding a separate import path
export { getMachineContext, onMachineContextChange } from "./objectmodel/machine-context";

/**
 * Find the enclosing function call (if any) for the cursor position. Walks back from the end of `beforeCursor`
 * keeping track of paren depth so that `max(a, min(b,|` correctly reports `min` with argIndex 1, not `max`.
 * Skips string content. Returns null if the cursor is not inside a function call.
 */
function findEnclosingFunctionCall(beforeCursor: string): { name: string, argIndex: number } | null
{
	let depth = 0;
	let commas = 0;
	let inString = false;
	for (let i = beforeCursor.length - 1; i >= 0; i--)
	{
		const ch = beforeCursor[i];
		if (inString)
		{
			if (ch === "\"")
			{
				inString = false;
			}
			continue;
		}
		if (ch === "\"")
		{
			inString = true;
		}
		else if (ch === ")")
		{
			depth++;
		}
		else if (ch === "(")
		{
			if (depth === 0)
			{
				// Walk back from i to capture the function identifier
				let j = i - 1;
				while (j >= 0 && /[A-Za-z0-9_]/.test(beforeCursor[j]))
				{
					j--;
				}
				const name = beforeCursor.substring(j + 1, i);
				if (!name)
				{
					return null;
				}
				return { name, argIndex: commas };
			}
			depth--;
		}
		else if (ch === "," && depth === 0)
		{
			commas++;
		}
	}
	return null;
}

/** Parse a syntax label like `atan2(y, x)` into its function name and parameter labels. */
function parseFunctionSyntax(syntax: string): { name: string, params: string[] }
{
	const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*\(\s*(.*?)\s*\)\s*$/.exec(syntax);
	if (!m)
	{
		return { name: syntax, params: [] };
	}
	const params = m[2].length === 0 ? [] : m[2].split(/\s*,\s*/);
	return { name: m[1], params };
}

/**
 * Resolve a dotted/indexed path like `move.axes[0]` against the currently connected machine's object model
 * and local-variable scanner output. Supports the RRF scope prefixes `var` (local declarations), `global`
 * (local + runtime) and any top-level object-model key. Unknown paths return `null`.
 */
function resolveExpressionPath(path: string, model: monaco.editor.ITextModel): any
{
	const tokens: Array<string | number> = [];
	const tokRe = /\.?([A-Za-z_][\w]*)|\[(\d+)\]/g;
	let m: RegExpExecArray | null;
	while ((m = tokRe.exec(path)) !== null)
	{
		tokens.push(m[1] !== undefined ? m[1] : Number(m[2]));
	}
	if (tokens.length === 0)
	{
		return null;
	}
	const root = String(tokens[0]);
	const ctx = getMachineContext();
	const local = getLocalVariables(model);
	let current: any;
	if (root === "var")
	{
		// `var.<name>` resolves to a placeholder object carrying the locally-declared names; the value isn't
		// known statically but listing keys is enough for completion
		current = Object.fromEntries([...local.vars].map(v => [v, null]));
	}
	else if (root === "global")
	{
		const runtime: any = ctx?.model ? (ctx.model as any).global : null;
		const merged: Record<string, any> = {};
		for (const n of local.globals)
		{
			merged[n] = null;
		}
		if (runtime && typeof runtime === "object")
		{
			if (typeof runtime.keys === "function" && typeof runtime[Symbol.iterator] === "function")
			{
				for (const k of runtime.keys())
				{
					merged[String(k)] = runtime.get ? runtime.get(k) : null;
				}
			}
			else
			{
				Object.assign(merged, runtime);
			}
		}
		current = merged;
	}
	else if (root === "param")
	{
		current = null;
	}
	else
	{
		current = ctx?.model ? (ctx.model as any)[root] : null;
	}
	for (let i = 1; i < tokens.length && current != null; i++)
	{
		const key = tokens[i];
		if (typeof key === "number" && Array.isArray(current))
		{
			current = current[key];
		}
		else if (typeof current === "object")
		{
			current = current[key];
		}
		else
		{
			current = null;
		}
	}
	return current;
}

/**
 * Enumerate public member names of a value for completion. Arrays have no dotted members in RRF's expression
 * syntax - their length is obtained via the `#` prefix operator (e.g. `#move.axes`), and elements via `[n]`.
 * Plain objects return their enumerable own keys.
 */
function listMemberKeys(value: any): string[]
{
	if (value == null || Array.isArray(value))
	{
		return [];
	}
	if (typeof value === "object")
	{
		return Object.keys(value).filter(k => !k.startsWith("_"));
	}
	return [];
}

/**
 * Flatten a machine object-model snapshot into a list of dotted paths (with `[0]` placeholders for arrays).
 * Walks the entire reachable subtree; arrays contribute a single representative `[0]` entry so the list
 * doesn't explode on machines with many tools/axes. Cycles are guarded via a visited WeakSet.
 */
export function flattenObjectModel(root: any): string[]
{
	if (!root || typeof root !== "object")
	{
		return [];
	}
	const paths: string[] = [];
	const visited = new WeakSet<object>();
	const walk = (value: any, prefix: string): void =>
	{
		if (value == null || typeof value !== "object" || visited.has(value))
		{
			return;
		}
		visited.add(value);
		if (Array.isArray(value))
		{
			if (value.length > 0)
			{
				walk(value[0], `${prefix}[0]`);
			}
			return;
		}
		for (const key of Object.keys(value))
		{
			if (key.startsWith("_"))
			{
				continue;
			}
			const child = value[key];
			const path = prefix ? `${prefix}.${key}` : key;
			paths.push(path);
			if (child !== null && typeof child === "object")
			{
				walk(child, path);
			}
		}
	};
	walk(root, "");
	return paths;
}

/** Walk `beforeCursor` and report whether the cursor sits inside an unclosed `"..."` string literal. */
function isInsideStringLiteral(beforeCursor: string): boolean
{
	let inString = false;
	for (let i = 0; i < beforeCursor.length; i++)
	{
		if (beforeCursor[i] === "\"")
		{
			inString = !inString;
		}
	}
	return inString;
}

/** Walk `beforeCursor` and report whether the cursor sits past an unescaped `;` line comment marker. */
function isInsideLineComment(beforeCursor: string): boolean
{
	let inString = false;
	for (let i = 0; i < beforeCursor.length; i++)
	{
		const ch = beforeCursor[i];
		if (inString)
		{
			if (ch === "\"")
			{
				inString = false;
			}
			continue;
		}
		if (ch === "\"")
		{
			inString = true;
		}
		else if (ch === ";")
		{
			return true;
		}
	}
	return false;
}

/**
 * Detect whether the cursor sits inside an RRF expression context:
 *   - inside a balanced-but-still-open `{ ... }` span, OR
 *   - after an `=` on a `set|var|global` line (whole line is expression territory), OR
 *   - after `if|elif|while` (condition is an expression).
 */
export function isInsideExpression(beforeCursor: string): boolean
{
	// Count unmatched `{` up to cursor - quick check first
	let depth = 0;
	let inString = false;
	for (let i = 0; i < beforeCursor.length; i++)
	{
		const ch = beforeCursor[i];
		if (inString)
		{
			if (ch === "\"")
			{
				inString = false;
			}
			continue;
		}
		if (ch === "\"")
		{
			inString = true;
		}
		else if (ch === "{")
		{
			depth++;
		}
		else if (ch === "}" && depth > 0)
		{
			depth--;
		}
	}
	if (depth > 0)
	{
		return true;
	}
	// Expression-carrying meta keywords. We require plain whitespace (not `\s+\S`) so the condition is treated
	// as expression territory even when the cursor / hovered word sits exactly at the first token after the
	// keyword - e.g. hovering `fileexists` in `if fileexists(...)` inspects beforeCursor `"if "` with nothing
	// past the space, which a `\S` anchor would reject
	if (/^\s*(if|elif|while)\s/.test(beforeCursor))
	{
		return true;
	}
	if (/^\s*(set|var|global)\s+[A-Za-z_.][A-Za-z0-9_.]*\s*=/.test(beforeCursor))
	{
		return true;
	}
	if (/^\s*(echo|abort)\s+/.test(beforeCursor))
	{
		return true;
	}
	return false;
}

/**
 * RRF meta-language keywords surfaced in line-start completion. Mirror of the values used by the monaco-gcode tokenizer.
 */
/** `keyword` is what the user types, `syntax` is the signature shown in the hints tooltip, `description` explains it. */
const metaKeywords: { keyword: string, syntax: string, description: string }[] = [
	{ keyword: "if", syntax: "if <condition>", description: "Conditional block" },
	{ keyword: "elif", syntax: "elif <condition>", description: "Else-if branch of a preceding if block" },
	{ keyword: "else", syntax: "else", description: "Else branch of a preceding if block" },
	{ keyword: "while", syntax: "while <condition>", description: "Loop block" },
	{ keyword: "break", syntax: "break", description: "Exit the enclosing while loop" },
	{ keyword: "continue", syntax: "continue", description: "Skip to the next iteration of the enclosing while loop" },
	{ keyword: "set", syntax: "set <name> = <expression>", description: "Assign a value to an existing variable" },
	{ keyword: "var", syntax: "var <name> = <expression>", description: "Declare a local variable" },
	{ keyword: "global", syntax: "global <name> = <expression>", description: "Declare a global variable" },
	{ keyword: "abort", syntax: "abort [<message>]", description: "Abort the running macro / queued moves with an optional message" },
	{ keyword: "echo", syntax: "echo <expression>", description: "Print an expression to the response channel" }
];

/**
 * Find the closest G/M/T-code to the left of `column` on the given line.
 * Returns the matched code (e.g. "G1") and the column where it starts, or null.
 *
 * A bare `T` is only treated as its own code when it's the first code on the line; otherwise it's a parameter
 * letter of the preceding command (e.g. `M104 T1` - the T belongs to M104, not a separate `T` code).
 */
export function findCodeAtCursor(line: string, column: number): { code: string; startColumn: number } | null
{
	// Local regex so there's no shared lastIndex state to reset between calls. Matches G/M codes with their
	// numeric suffix (e.g. G1, G38.2, M104) or a bare T. Anything after T (tool number, sign, expression) is
	// treated as T's unprecedentedParameter
	const codeRegex = /([GM]\d+(?:\.\d+)?|T(?![A-Za-z]))/g;
	let result: { code: string; startColumn: number } | null = null;
	let haveGMmatch = false;
	let m: RegExpExecArray | null;
	while ((m = codeRegex.exec(line)) !== null)
	{
		const start = m.index + 1;
		if (start > column)
		{
			break;
		}
		const code = m[1];
		if (code === "T" && haveGMmatch)
		{
			// A standalone `T` following another G/M command on the same line is a parameter of that command
			continue;
		}
		if (code[0] !== "T")
		{
			haveGMmatch = true;
		}
		result = { code, startColumn: start };
	}
	return result;
}

/**
 * Describe a dotted/bracketed identifier chain under the given 1-based cursor column, returning the segment that
 * the cursor sits on, the prefix from the chain start through that segment, and a normalised form with `[N]` -> `[]`
 * (matching the convention used by the deprecations/enums sidecars and by DuetAPI.xml lookups).
 *
 * Example: hovering `pressureAdvance` in `move.extruders[0].pressureAdvance` returns
 *   { prefix: "move.extruders[0].pressureAdvance", normalized: "move.extruders[].pressureAdvance", ... }
 *
 * Returns null if the cursor is not inside a chain that contains at least one `.` or `[n]` step.
 */
function findObjectModelHover(line: string, column: number): {
	prefix: string;
	normalized: string;
	segStartColumn: number;
	segEndColumn: number;
} | null
{
	const chainRegex = /[A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*|\[\d+\])+/g;
	let match: RegExpExecArray | null;
	while ((match = chainRegex.exec(line)) !== null)
	{
		const chainStart = match.index + 1;
		const chainEnd = chainStart + match[0].length;
		if (column < chainStart || column > chainEnd)
		{
			continue;
		}
		const chain = match[0];
		let i = 0;
		let segStart = 0;
		while (i < chain.length)
		{
			let j = i;
			while (j < chain.length && /\w/.test(chain[j]))
			{
				j++;
			}
			// Attached `[...]` subscripts stay with their preceding identifier
			while (j < chain.length && chain[j] === "[")
			{
				while (j < chain.length && chain[j] !== "]")
				{
					j++;
				}
				if (j < chain.length)
				{
					j++;
				}
			}
			const segStartColumn = chainStart + segStart;
			const segEndColumn = chainStart + j;
			if (column >= segStartColumn && column <= segEndColumn)
			{
				const prefix = chain.substring(0, j);
				return {
					prefix,
					normalized: prefix.replace(/\[\d+\]/g, "[]"),
					segStartColumn,
					segEndColumn
				};
			}
			if (chain[j] === ".")
			{
				j++;
			}
			i = j;
			segStart = i;
		}
		return null;
	}
	return null;
}

/**
 * Compute the 1-based column range (inclusive-exclusive) covered by a parameter-letter token plus its value
 * on the given line. `letterColZero` is the 0-based index of the parameter letter itself. The range starts at
 * the letter and extends to cover whatever follows it:
 *   - a `{...}` expression (brace-balanced, so nested `{a + {b}}` stays intact), OR
 *   - a `"..."` quoted string (until the matching quote, inclusive), OR
 *   - a numeric/array token made of digits, sign, decimal point, or `:` (preserves IP-like values and
 *     colon-separated arrays such as `E100:200:300`).
 * When the letter isn't followed by any of these (e.g. bare `X` in `M84 X Y Z`), the range covers just the
 * letter itself.
 */
function findParameterValueRange(line: string, letterColZero: number): { startCol: number; endCol: number }
{
	const startCol = letterColZero + 1;
	let i = letterColZero + 1;
	if (i < line.length)
	{
		const ch = line[i];
		if (ch === "{")
		{
			let depth = 1;
			i++;
			while (i < line.length && depth > 0)
			{
				if (line[i] === "{")
				{
					depth++;
				}
				else if (line[i] === "}")
				{
					depth--;
				}
				i++;
			}
		}
		else if (ch === "\"")
		{
			i++;
			while (i < line.length && line[i] !== "\"")
			{
				i++;
			}
			if (i < line.length)
			{
				i++;
			}
		}
		else
		{
			// Walk a numeric / colon-list value. Allow `e`/`E` (scientific notation) only when the preceding
			// char is a digit or dot, so `C7.06e-8` is one token; also allow `+`/`-` right after `e`/`E` so
			// the exponent sign is consumed even though a bare `-` would otherwise end a sibling param
			while (i < line.length)
			{
				const ch2 = line[i];
				if (/[0-9.:]/.test(ch2))
				{
					i++;
				}
				else if (ch2 === "+" || ch2 === "-")
				{
					const prev = i > 0 ? line[i - 1] : "";
					if (i === letterColZero + 1 || prev === "e" || prev === "E")
					{
						i++;
					}
					else
					{
						break;
					}
				}
				else if (ch2 === "e" || ch2 === "E")
				{
					const prev = i > 0 ? line[i - 1] : "";
					if (/[0-9.]/.test(prev))
					{
						i++;
					}
					else
					{
						break;
					}
				}
				else
				{
					break;
				}
			}
		}
	}
	return { startCol, endCol: i + 1 };
}

/**
 * Walk a gcode line and find which parameter letter (if any) "owns" the cursor column via its expanded value
 * range - so hovering a `100` / `{global.x}` / `"foo.g"` / `1:2:3` segment still resolves to the parameter it
 * belongs to, not just the bare letter. Honours `"..."` strings, balanced `{...}` expressions, and `;`
 * line-comments so letters inside those aren't mistaken for parameter tokens.
 *
 * `codeEndColZero` is the 0-based position right after the code identifier; `cursorColOne` is the hover's
 * 1-based column. Returns the enclosing parameter letter + its 0-based start column, or null if the cursor
 * isn't inside any parameter's range.
 */
function findParameterAtCursor(line: string, codeEndColZero: number, cursorColOne: number): { letterColZero: number; letter: string } | null
{
	let inString = false;
	let braceDepth = 0;
	let i = codeEndColZero;
	while (i < line.length)
	{
		const ch = line[i];
		if (inString)
		{
			if (ch === "\"")
			{
				inString = false;
			}
			i++;
			continue;
		}
		if (ch === "\"")
		{
			inString = true;
			i++;
			continue;
		}
		if (ch === "{")
		{
			braceDepth++;
			i++;
			continue;
		}
		if (ch === "}")
		{
			if (braceDepth > 0)
			{
				braceDepth--;
			}
			i++;
			continue;
		}
		if (braceDepth > 0)
		{
			i++;
			continue;
		}
		if (ch === ";")
		{
			return null;
		}
		if (/[A-Za-z]/.test(ch))
		{
			const prev = i > 0 ? line[i - 1] : "";
			const next = i + 1 < line.length ? line[i + 1] : "";
			if (!/[A-Za-z]/.test(prev) && !/[A-Za-z]/.test(next))
			{
				const valRange = findParameterValueRange(line, i);
				if (cursorColOne >= valRange.startCol && cursorColOne < valRange.endCol)
				{
					return { letterColZero: i, letter: ch };
				}
				i = valRange.endCol - 1;
				continue;
			}
		}
		i++;
	}
	return null;
}

/**
 * Compute the 1-based column range (inclusive-exclusive) covered by the unprecedented-parameter segment of a
 * G/M/T-code on the given line. `codeEndColZero` is the 0-based index of the character immediately following
 * the code identifier (i.e. `enclosing.startColumn + code.length - 1`).
 *
 * The segment starts at the first non-whitespace char after the code and extends up to (but not including):
 *   - the start of the first isolated parameter letter outside `"..."` strings and `{...}` expressions,
 *   - a `;` line-comment marker, or
 *   - end-of-line.
 * Trailing whitespace is trimmed. Returns null if the segment would be empty (no direct value typed yet).
 */
function findUnprecedentedParameterRange(line: string, codeEndColZero: number): { startCol: number; endCol: number } | null
{
	let i = codeEndColZero;
	while (i < line.length && /\s/.test(line[i]))
	{
		i++;
	}
	if (i >= line.length)
	{
		return null;
	}
	const startCol = i + 1;
	let endColZero = line.length;
	let inString = false;
	let braceDepth = 0;
	for (let j = i; j < line.length; j++)
	{
		const ch = line[j];
		if (inString)
		{
			if (ch === "\"")
			{
				inString = false;
			}
			continue;
		}
		if (ch === "\"")
		{
			inString = true;
			continue;
		}
		if (ch === "{")
		{
			braceDepth++;
			continue;
		}
		if (ch === "}")
		{
			if (braceDepth > 0)
			{
				braceDepth--;
			}
			continue;
		}
		if (braceDepth > 0)
		{
			continue;
		}
		if (ch === ";")
		{
			endColZero = j;
			break;
		}
		if (/[A-Za-z]/.test(ch))
		{
			const prev = j > 0 ? line[j - 1] : "";
			const next = j + 1 < line.length ? line[j + 1] : "";
			if (!/[A-Za-z]/.test(prev) && !/[A-Za-z]/.test(next))
			{
				endColZero = j;
				break;
			}
		}
	}
	while (endColZero > i && /\s/.test(line[endColZero - 1]))
	{
		endColZero--;
	}
	if (endColZero <= i)
	{
		return null;
	}
	return { startCol, endCol: endColZero + 1 };
}

/** VSCode-style warning colour used for deprecation notices (matches the editorWarning.foreground token).
 * Monaco's markdown sanitizer only accepts `style` with a trailing semicolon and a restricted set of properties. */
const deprecatedHtml = (message: string) => `<span style="color:#cca700;">⚠ <b>Deprecated:</b> ${message}</span>`;
const deprecatedInlineHtml = "<span style=\"color:#cca700;\"><i>(deprecated)</i></span>";

/**
 * Build a Markdown documentation block for a code (used by both completion and hover).
 */
function buildCodeDoc(code: string): string
{
	const info = findGcode(code);
	if (!info)
	{
		return "";
	}
	let md = `**${info.code}** - ${info.summary}`;
	if (info.deprecated)
	{
		md += `\n\n${deprecatedHtml(info.deprecated)}`;
	}
	// Unprefixed (unprecedentedParameter) slot. Rendered as "Parameter" rather than the raw label (e.g. `"<message>"`)
	// because the user can pass a literal, a quoted string, or an expression, and the literal notation
	// misleads readers into thinking they must quote. The prose description already makes the intent clear
	if (info.unprecedentedParameter)
	{
		md += `\n\n**Parameter** - ${info.unprecedentedParameter.description}`;
	}
	if (info.parameters.length > 0)
	{
		md += "\n\nParameters:";
		// Non-deprecated parameters first, deprecated ones at the end - keeps the active list uncluttered
		const sorted = info.parameters.slice().sort((a, b) => (a.deprecated ? 1 : 0) - (b.deprecated ? 1 : 0));
		for (const p of sorted)
		{
			const tag = p.deprecated ? ` ${deprecatedInlineHtml}` : "";
			md += `\n- **${p.letter}** - ${p.description}${tag}`;
		}
	}
	return md;
}

/**
 * Build a Markdown documentation block for a single parameter: description, optional value enumeration and a
 * deprecation notice last (parameter-level if set, otherwise inherited from the surrounding code).
 */
function buildParameterDoc(info: GcodeInfo, p: GcodeParameter): string
{
	let md = `**${info.code} ${p.letter}** - ${p.description}`;
	if (p.values && p.values.length > 0)
	{
		md += "\n\n**Values:**";
		for (const v of p.values)
		{
			md += `\n- \`${v.value}\` - ${v.description}`;
		}
	}
	const deprecationNote = p.deprecated ?? info.deprecated;
	if (deprecationNote)
	{
		md += `\n\n${deprecatedHtml(deprecationNote)}`;
	}
	return md;
}

/** Wrap a Markdown string as a Monaco IMarkdownString with HTML support enabled (needed for the coloured deprecation notice). */
function md(value: string): monaco.IMarkdownString
{
	return { value, supportHtml: true };
}

let suggestWidgetStyleInstalled = false;

/**
 * Ensure the Monaco suggest-widget is wide enough to display the full summary column without truncation.
 * Installed once globally the first time a language is registered.
 */
function installSuggestWidgetWidth(): void
{
	if (suggestWidgetStyleInstalled || typeof document === "undefined")
	{
		return;
	}
	const style = document.createElement("style");
	// Cap the widened widget at 90vw so narrow screens (phones) aren't forced to overflow horizontally
	// Also relax Monaco's built-in max-height on the parameter-hints widget so our summary doc (which lists
	// all parameters when no parameter is active) can grow vertically instead of getting an internal scrollbar
	style.textContent = [
		".monaco-editor .suggest-widget { min-width: min(600px, 90vw); }",
		".monaco-editor .suggest-widget .monaco-list { min-width: min(600px, 90vw); }",
		".monaco-editor .parameter-hints-widget { max-width: min(600px, 90vw) !important; }",
		".monaco-editor .parameter-hints-widget > .phwrapper { max-width: min(600px, 90vw) !important; }",
		// Hover widget: widen to match the suggest-widget (90vw cap so phones don't overflow), and cap height
		// at 50vh so Monaco's positioning math always finds a fit either above or below the cursor. Without
		// a height cap it can compute a height that doesn't fit above when hovering near the top of the file,
		// leaving the tooltip clipped at negative Y. Long docs (M106, M950) scroll internally, which is the
		// right trade-off - forcing inner containers to ignore the computed max-height makes the widget grow
		// past its reserved slot and overlap the source line, hiding the cursor
		".monaco-editor .monaco-hover, .monaco-editor-hover { max-width: min(600px, 90vw) !important; max-height: 50vh !important; }",
		".monaco-editor .monaco-hover .hover-contents, .monaco-editor-hover .hover-contents { overflow-wrap: break-word; }",
		// Pin every box in the hover to the same integer pixel height (19 px - matches Monaco's intended
		// `1.35714 * 14` line-height, just rounded). Monaco's default ratio resolves to 18.99996 px at 14 px
		// font; inline phrasing elements (<code>, <strong>, ...) have their own intrinsic metrics that
		// resolve to different fractions (e.g. 16.6667 px for <strong>); and <li> picks up another fraction
		// from the browser's em-based padding (~17.4167 px). Each fraction cascades back into the row height
		// and triggers a phantom scrollbar (M550, M569 D, M918, ...). Forcing integer line-height + sized
		// inline blocks + an explicit <li> height kills the rounding mismatch at every level. Also mirror
		// the implicit left gutter (from the <ul> bullet indent) on the right so text doesn't butt up against
		// the tooltip edge
		".monaco-editor .monaco-hover .monaco-hover-content, .monaco-editor-hover .monaco-hover-content { line-height: 19px !important; box-sizing: border-box; overflow-x: hidden; }",
		// Add right-side padding only when the hover renders more than a single line (multi-paragraph
		// content, or a bullet/numbered list). Single-line hovers (just one `<p>`) don't need it and the
		// extra gutter would look off-balance against the natural left margin
		".monaco-editor .monaco-hover .monaco-hover-content:has(p + p, ul, ol), .monaco-editor-hover .monaco-hover-content:has(p + p, ul, ol) { padding-right: 12px; }",
		// Pin <li> height to a clean 19 px integer (matches the parent's pinned line-height). Browser default
		// padding/margin gives a fractional ~17.4167 px row that, in lists with many items, accumulates into a
		// half-pixel overflow at the bottom and brings back the phantom scrollbar
		".monaco-editor .monaco-hover li, .monaco-editor-hover li { height: 19px !important; box-sizing: border-box; }"
	].join(" ");
	document.head.appendChild(style);
	suggestWidgetStyleInstalled = true;
}

/**
 * Register Duet-specific completion and hover providers for a language id.
 */
export function registerProvidersFor(monacoInstance: typeof monaco, languageId: string): monaco.IDisposable[]
{
	installSuggestWidgetWidth();
	const disposables: monaco.IDisposable[] = [];

	// Completion: codes when typing G/M/T at line start, parameter letters after a known code
	disposables.push(monacoInstance.languages.registerCompletionItemProvider(languageId, {
		triggerCharacters: ["G", "M", "T", "g", "m", "t", " ", "{", ".", "=", "!", "\""],
		provideCompletionItems: (model, position, context) =>
		{
			const lineContent = model.getLineContent(position.lineNumber);
			const beforeCursor = lineContent.substring(0, position.column - 1);
			// A manual Ctrl+Space (Invoke) always shows the list; an auto-trigger (TriggerCharacter or
			// TriggerForIncompleteCompletions) is allowed to skip in expression mode if we're mid-identifier
			const isManualInvoke = context?.triggerKind === monacoInstance.languages.CompletionTriggerKind.Invoke;
			const insideExpression = isInsideExpression(beforeCursor);
			const insideString = isInsideStringLiteral(beforeCursor);

			// Expression context - suggest RRF functions, constants, scope prefixes and object-model namespaces
			if (insideExpression)
			{
				// Enum / string-literal comparison: `<om path> == ` or `<om path> != ` (optional `"` already typed).
				// Suggest the valid values for that path and nothing else, so the user isn't distracted by the
				// general vocabulary. Runs ahead of the member-access branch so typed paths don't fall through
				const eqMatch = /([A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*|\[\d+\])*)\s*(?:==|!=)\s*"?([A-Za-z_][\w]*)?$/.exec(beforeCursor);
				if (eqMatch)
				{
					const values = getEnumValuesForPath(eqMatch[1]);
					if (values)
					{
						const wordInfo = model.getWordUntilPosition(position);
						const range: monaco.IRange = {
							startLineNumber: position.lineNumber,
							endLineNumber: position.lineNumber,
							startColumn: wordInfo.startColumn,
							endColumn: wordInfo.endColumn
						};
						const suggestions: monaco.languages.CompletionItem[] = values.map(v =>
						({
							label: `"${v}"`,
							kind: monacoInstance.languages.CompletionItemKind.EnumMember,
							// Insert surrounding quotes only if the user hasn't typed an opening quote already
							insertText: beforeCursor.endsWith("\"") ? v + "\"" : `"${v}"`,
							range
						}));
						return { suggestions };
					}
				}
			}

			// Outside the eqMatch above, no completions should fire when the cursor sits inside a `"..."`
			// string literal - the user is typing prose, not code. Without this, stray `!` / `"` triggers
			// inside echo strings or a code's S"..." parameter still produce suggestions (for M118's
			// remaining parameter letters etc) because the post-eqMatch branches don't know about strings
			if (insideString)
			{
				return { suggestions: [] };
			}

			if (insideExpression)
			{
				// Member-access chain (e.g. `move.axes[0].` or `global.myvar.`). Walk the object-model from the chain root
				// and list the value's keys at the current path. Evaluated first so the auto-trigger gate below doesn't
				// suppress this case (the `.` itself wouldn't pass it)
				const chainMatch = /([A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*|\[\d+\])*)\.(\w*)$/.exec(beforeCursor);
				if (chainMatch)
				{
					const wordInfo = model.getWordUntilPosition(position);
					const range: monaco.IRange = {
						startLineNumber: position.lineNumber,
						endLineNumber: position.lineNumber,
						startColumn: wordInfo.startColumn,
						endColumn: wordInfo.endColumn
					};
					const value = resolveExpressionPath(chainMatch[1], model);
					const suggestions: monaco.languages.CompletionItem[] = [];
					for (const name of listMemberKeys(value))
					{
						const deprecation = getMemberDeprecation(chainMatch[1], name);
						// Using the structured label form puts the `deprecated - <reason>` string in the description
						// column (right-aligned dim text) so it's visible on every row, not only the highlighted one
						const deprecationLabel = deprecation === null
							? undefined
							: deprecation.length > 0 ? `deprecated - ${deprecation}` : "deprecated";
						suggestions.push({
							label: deprecationLabel !== undefined ? { label: name, description: deprecationLabel } : name,
							kind: monacoInstance.languages.CompletionItemKind.Variable,
							insertText: name,
							range,
							tags: deprecation !== null ? [monacoInstance.languages.CompletionItemTag.Deprecated] : undefined,
							detail: deprecationLabel
						});
					}
					return { suggestions };
				}
				// Auto-trigger only at the start of a new expression fragment or immediately after an operator -
				// otherwise the popup would fire on every keystroke mid-identifier. Manual Ctrl+Space bypasses this
				// so the user can still summon the list whenever they want
				if (!isManualInvoke)
				{
					const wordStart = model.getWordUntilPosition(position).startColumn;
					const beforeWord = lineContent.substring(0, wordStart - 1).trimEnd();
					const lastChar = beforeWord.charAt(beforeWord.length - 1);
					// `(` and `,` are intentionally excluded: inside function calls the signature-help tooltip is the
					// relevant cue, not the general function/constant list. Users can still Ctrl+Space manually
					const autoAllowed = beforeWord.length === 0 || "+-*/%&|^~!<>=?:{".indexOf(lastChar) >= 0;
					if (!autoAllowed)
					{
						return { suggestions: [] };
					}
				}
				const wordInfo = model.getWordUntilPosition(position);
				const range: monaco.IRange = {
					startLineNumber: position.lineNumber,
					endLineNumber: position.lineNumber,
					startColumn: wordInfo.startColumn,
					endColumn: wordInfo.endColumn
				};
				const suggestions: monaco.languages.CompletionItem[] = [];
				for (const f of expressionData.functions)
				{
					suggestions.push({
						label: { label: f.name, description: f.syntax },
						kind: monacoInstance.languages.CompletionItemKind.Function,
						detail: f.syntax,
						documentation: md(`**${f.syntax}** - ${f.description}`),
						insertText: f.name,
						range
					});
				}
				for (const c of expressionData.constants)
				{
					suggestions.push({
						label: { label: c.name, description: c.description },
						kind: monacoInstance.languages.CompletionItemKind.Constant,
						detail: c.description,
						documentation: md(`**${c.name}** - ${c.description}`),
						insertText: c.name,
						range
					});
				}
				for (const s of expressionData.scopes)
				{
					suggestions.push({
						label: { label: s.name, description: s.description },
						kind: monacoInstance.languages.CompletionItemKind.Module,
						detail: s.description,
						documentation: md(`**${s.name}** - ${s.description}`),
						insertText: s.name,
						range
					});
				}
				for (const ns of expressionData.objectModel)
				{
					// No description here - sub-keys don't carry any either (see comment in listMemberKeys),
					// so keep the top level consistent rather than teasing docs the deeper levels can't match
					suggestions.push({
						label: ns.name,
						kind: monacoInstance.languages.CompletionItemKind.Module,
						insertText: ns.name,
						range
					});
				}
				return { suggestions };
			}

			// At the start of a (possibly indented) line: suggest codes and meta keywords
			if (/^\s*([a-zA-Z]\w*)?$/.test(beforeCursor))
			{
				const wordInfo = model.getWordUntilPosition(position);
				const range: monaco.IRange = {
					startLineNumber: position.lineNumber,
					endLineNumber: position.lineNumber,
					startColumn: wordInfo.startColumn,
					endColumn: wordInfo.endColumn
				};
				const triggerHints: monaco.languages.Command = { id: "editor.action.triggerParameterHints", title: "Trigger Parameter Hints" };
				const suggestions: monaco.languages.CompletionItem[] = gcodeData.map(info =>
				({
					label: { label: info.code, description: info.summary },
					kind: monacoInstance.languages.CompletionItemKind.Function,
					detail: info.summary,
					documentation: md(buildCodeDoc(info.code)),
					insertText: info.code,
					range,
					// Open the signature-help tooltip as soon as the user picks a code that has parameters or a direct value
					command: (info.parameters.length > 0 || info.unprecedentedParameter) ? triggerHints : undefined,
					tags: info.deprecated ? [monacoInstance.languages.CompletionItemTag.Deprecated] : undefined
				}));
				for (const k of metaKeywords)
				{
					suggestions.push({
						label: { label: k.keyword, description: k.description },
						kind: monacoInstance.languages.CompletionItemKind.Keyword,
						detail: k.description,
						documentation: md(`**${k.keyword}** - ${k.description}`),
						insertText: k.keyword,
						range
					});
				}
				return { suggestions };
			}

			// Inside a code call: suggest parameter letters (excluding ones already present on the line)
			const code = findCodeAtCursor(lineContent, position.column - 1);
			if (code)
			{
				const info = findGcode(code.code);
				if (info && info.parameters.length > 0)
				{
					const wordInfo = model.getWordUntilPosition(position);
					const range: monaco.IRange = {
						startLineNumber: position.lineNumber,
						endLineNumber: position.lineNumber,
						startColumn: wordInfo.startColumn,
						endColumn: wordInfo.endColumn
					};
					// Collect isolated parameter letters already on the line so we don't suggest duplicates
					// The letter directly at the cursor position is also considered "used": if the user has
					// just typed it, Monaco should show nothing (so the widget auto-closes) rather than list
					// the very letter that was just typed as the only match
					const fullTail = lineContent.substring(code.startColumn - 1 + code.code.length);
					const used = new Set<string>();
					const re = /(?<![A-Za-z])[A-Za-z](?![A-Za-z])/g;
					let m: RegExpExecArray | null;
					while ((m = re.exec(fullTail)) !== null)
					{
						used.add(m[0].toUpperCase());
					}
					const triggerHints: monaco.languages.Command = { id: "editor.action.triggerParameterHints", title: "Trigger Parameter Hints" };
					const suggestions: monaco.languages.CompletionItem[] = info.parameters
						.filter(p => !used.has(p.letter.toUpperCase()))
						.map(p =>
					({
						label: { label: p.letter, description: p.description },
						kind: monacoInstance.languages.CompletionItemKind.Property,
						detail: p.description,
						documentation: md(buildParameterDoc(info, p)),
						insertText: p.letter,
						range,
						// Re-open the signature help tooltip after accepting a parameter letter (Monaco otherwise
						// closes parameter hints when any completion item is accepted without a command)
						command: triggerHints,
						tags: p.deprecated ? [monacoInstance.languages.CompletionItemTag.Deprecated] : undefined
					}));
					// isIncomplete forces Monaco to re-call the provider on every keystroke instead of filtering a
					// cached list. That way once the user types the only remaining parameter letter the `used` set
					// has just caught it, we return an empty list, and Monaco closes the widget
					return { suggestions, incomplete: true };
				}
			}

			return { suggestions: [] };
		}
	}));

	// Signature help: floating tooltip enumerating all parameters of the current code, similar to console.log() in VSCode
	disposables.push(monacoInstance.languages.registerSignatureHelpProvider(languageId, {
		signatureHelpTriggerCharacters: [" ", "(", ","],
		// Re-evaluate on every character that signals "parameter value finished" so dismissal fires immediately
		signatureHelpRetriggerCharacters: [" ", "\t", "}", "\"", ";", "(", ",", ")"],
		provideSignatureHelp: (model, position) =>
		{
			const lineContent = model.getLineContent(position.lineNumber);
			const beforeCursor = lineContent.substring(0, position.column - 1);

			// Cursor inside a `"..."` string literal: no signature help applies (the user is typing prose,
			// not a parameter token), so bail to keep the tooltip from following the caret into strings
			if (isInsideStringLiteral(beforeCursor))
			{
				return null;
			}
			// Cursor past a `;` on the same line: we're inside a line comment (e.g. after bksp joins a line
			// onto a previous commented line like "M106 P1 S255 ; note"). No signature help applies there,
			// and without this guard Monaco would keep the previous parameter's tooltip floating over prose.
			if (isInsideLineComment(beforeCursor))
			{
				return null;
			}
			// In an expression context the only meaningful signature help is the enclosing function call -
			// suppress the outer command/keyword tooltip so it doesn't keep flashing while the user types values
			const fnCall = findEnclosingFunctionCall(beforeCursor);
			if (isInsideExpression(beforeCursor) && !fnCall)
			{
				return null;
			}
			// Function call inside an expression (e.g. `sin(|` or `atan2(y,|`) takes precedence
			if (fnCall)
			{
				const fn = expressionData.functions.find(f => f.name === fnCall.name);
				if (fn)
				{
					const parsed = parseFunctionSyntax(fn.syntax);
					const params: monaco.languages.ParameterInformation[] = parsed.params.map(p =>
					({
						label: p,
						documentation: md(`**${p}** - argument of **${fn.syntax}**`)
					}));
					return {
						value: {
							signatures: [{
								label: fn.syntax,
								documentation: md(`**${fn.syntax}** - ${fn.description}`),
								parameters: params
							}],
							activeSignature: 0,
							activeParameter: Math.min(fnCall.argIndex, Math.max(0, params.length - 1))
						},
						dispose: () => {}
					};
				}
			}

			// Keywords take precedence when the line starts with one (e.g. `if`, `while`, `set`)
			const keywordMatch = /^\s*([a-z]+)(\s|$)/.exec(lineContent);
			if (keywordMatch)
			{
				const keyword = metaKeywords.find(k => k.keyword === keywordMatch[1]);
				if (keyword)
				{
					return {
						value: {
							signatures: [{
								label: keyword.syntax,
								documentation: md(`**${keyword.keyword}** - ${keyword.description}`),
								parameters: []
							}],
							activeSignature: 0,
							activeParameter: -1
						},
						dispose: () => {}
					};
				}
			}

			const code = findCodeAtCursor(lineContent, position.column - 1);
			if (!code)
			{
				return null;
			}
			const info = findGcode(code.code);
			if (!info || (info.parameters.length === 0 && !info.unprecedentedParameter))
			{
				return null;
			}

			// Dismiss the tooltip once the user has finished typing a parameter value: trailing whitespace,
			// a closing `}` of a balanced expression, or a closing `"` of a balanced string. Keep it visible
			// right after the bare code (no value typed yet) so the full signature is offered
			const tailForDismissal = beforeCursor.substring(code.startColumn - 1 + code.code.length);
			const lastChar = beforeCursor.charAt(beforeCursor.length - 1);
			if (/\S/.test(tailForDismissal))
			{
				if (lastChar === " " || lastChar === "\t")
				{
					return null;
				}
				if (lastChar === "}" && (tailForDismissal.match(/\{/g) || []).length === (tailForDismissal.match(/\}/g) || []).length)
				{
					return null;
				}
				if (lastChar === "\"" && ((tailForDismissal.match(/"/g) || []).length % 2) === 0)
				{
					return null;
				}
			}

			// Build a signature like "T Parameter P R" or "G1 X Y Z E F" with one slot per argument so Monaco
			// can highlight the active one. The unprecedented-parameter slot is labelled "Parameter" rather
			// than the literal notation from the dataset (e.g. `"<message>"`) since the user can pass a
			// literal, a quoted string, or an expression - the literal-looking label misleads readers
			let label = info.code;
			const parameters: monaco.languages.ParameterInformation[] = [];
			if (info.unprecedentedParameter)
			{
				const start = label.length + 1;
				label += " Parameter";
				let doc = `**Parameter** - ${info.unprecedentedParameter.description}`;
				if (info.deprecated)
				{
					doc += `\n\n${deprecatedHtml(info.deprecated)}`;
				}
				parameters.push({
					label: [start, label.length],
					documentation: md(doc)
				});
			}
			for (const p of info.parameters)
			{
				const start = label.length + 1;
				label += " " + p.letter;
				parameters.push({
					label: [start, label.length],
					documentation: md(buildParameterDoc(info, p))
				});
			}

			// Active parameter: the last isolated single letter between the code and the cursor (e.g. the H in "G1 X10 H1");
			// for codes with a unprecedentedParameter, sit on slot 0 while the user is typing that value (no parameter letter typed yet)
			const tail = tailForDismissal;
			let activeParameter = -1;
			const seen = tail.match(/(?<![A-Za-z])[A-Za-z](?![A-Za-z])/g);
			const unprecedentedOffset = info.unprecedentedParameter ? 1 : 0;
			if (seen && seen.length > 0)
			{
				const last = seen[seen.length - 1].toUpperCase();
				const idx = info.parameters.findIndex(p => p.letter.toUpperCase() === last);
				if (idx >= 0)
				{
					activeParameter = idx + unprecedentedOffset;
				}
				else
				{
					// User typed a letter that isn't a documented parameter for this code - hide the popup
					// rather than falling back to the generic summary view, which would be misleading
					return null;
				}
			}
			else if (info.unprecedentedParameter)
			{
				activeParameter = 0;
			}

			// When no parameter is active yet, show "<code> - <summary>" as the top line. The labelled parameter
			// signature "M203 X Y Z E I" only reappears once the user is typing a parameter. The doc panel
			// renders, in order: optional multi-line description, deprecation notice, parameter list. The
			// one-line summary is already shown in the label so it isn't repeated in the doc
			if (activeParameter < 0)
			{
				const docParts: string[] = [];
				if (info.deprecated)
				{
					docParts.push(deprecatedHtml(info.deprecated));
				}
				if (info.description)
				{
					docParts.push(info.description);
				}
				if (info.unprecedentedParameter)
				{
					docParts.push(`**Parameter** - ${info.unprecedentedParameter.description}`);
				}
				if (info.parameters.length > 0)
				{
					let params = "Parameters:";
					// Non-deprecated parameters first, deprecated ones at the end
					const sorted = info.parameters.slice().sort((a, b) => (a.deprecated ? 1 : 0) - (b.deprecated ? 1 : 0));
					for (const p of sorted)
					{
						const tag = p.deprecated ? ` ${deprecatedInlineHtml}` : "";
						params += `\n- **${p.letter}** - ${p.description}${tag}`;
					}
					docParts.push(params);
				}
				return {
					value: {
						signatures: [{
							label: `${info.code} - ${info.summary}`,
							documentation: docParts.length > 0 ? md(docParts.join("\n\n")) : undefined,
							parameters: []
						}],
						activeSignature: 0,
						activeParameter: -1
					},
					dispose: () => {}
				};
			}
			return {
				value: {
					signatures: [{
						label,
						documentation: undefined,
						parameters
					}],
					activeSignature: 0,
					activeParameter
				},
				dispose: () => {}
			};
		}
	}));

	// Hover: show code summary or parameter description under the cursor
	disposables.push(monacoInstance.languages.registerHoverProvider(languageId, {
		provideHover: async (model, position) =>
		{
			const lineContent = model.getLineContent(position.lineNumber);
			const word = model.getWordAtPosition(position);
			if (!word)
			{
				// No identifier-shaped word under the cursor (e.g. cursor on `*` in `M586 C"*"`, on `?` etc.).
				// Try to resolve the cursor as a parameter value position via findParameterAtCursor; if it
				// sits inside a known parameter's value range, show that parameter's doc
				const enclosingCode = findCodeAtCursor(lineContent, position.column);
				if (enclosingCode)
				{
					const info = findGcode(enclosingCode.code);
					const paramAtCursor = info ? findParameterAtCursor(lineContent, enclosingCode.startColumn + enclosingCode.code.length - 1, position.column) : null;
					if (info && paramAtCursor)
					{
						const param = info.parameters.find(p => p.letter.toUpperCase() === paramAtCursor.letter.toUpperCase());
						if (param)
						{
							const valueRange = findParameterValueRange(lineContent, paramAtCursor.letterColZero);
							return {
								range: new monacoInstance.Range(position.lineNumber, valueRange.startCol, position.lineNumber, valueRange.endCol),
								contents: [md(buildParameterDoc(info, param))]
							};
						}
					}
				}
				return null;
			}
			// Note: we deliberately do NOT bail when the cursor is inside a `"..."` string. The string is
			// usually the value of a parameter (e.g. `M308 P"temp0"`, `M308 Y"thermistor"`) and we want to
			// show the parameter's hover info while the cursor sits on the value. The narrower check that
			// prevents `"M104 done"` style false matches lives down at the wordIsCode branch
			const beforeWordForString = lineContent.substring(0, word.startColumn - 1);
			const insideString = isInsideStringLiteral(beforeWordForString);
			// Suppress hover inside `;` line-comments - the tokeniser colours them as comments but the hover
			// provider runs independently and would otherwise match G/M-code letters that appear in comment text
			const semi = lineContent.indexOf(";");
			if (semi >= 0 && word.startColumn - 1 >= semi)
			{
				return null;
			}
			// Determine up-front whether the word sits inside an expression context - used to route hover between
			// the gcode-parameter flavour (outside expressions) and the function/constant flavour (inside)
			const beforeWord = lineContent.substring(0, word.startColumn - 1);
			const insideExpression = isInsideExpression(beforeWord);
			// Determine what the word actually is: findCodeAtCursor tells us the nearest code at or before the
			// given column. Passing `word.startColumn` (inclusive) rather than `word.startColumn - 1` means the
			// word itself is considered - so `M84` alone resolves to code=M84 startColumn=1, and the check below
			// can tell it's the code (not a parameter of some earlier code). For `M104 T0` hovering T0, the
			// lookup still returns M104 because `findCodeAtCursor`'s T-rule treats a bare T after G/M as that
			// code's parameter, letting us test T-as-parameter before T-as-code
			const enclosing = !insideExpression ? findCodeAtCursor(lineContent, word.startColumn) : null;
			const wordIsCode = enclosing && enclosing.startColumn === word.startColumn && /^[A-Za-z]/.test(word.word);
			const firstLetter = word.word[0];
			// Hover on a parameter letter belonging to the nearest preceding code. Monaco's default word regex
			// bundles the letter with its trailing value (e.g. `S0` / `X10.5` / `E20` / the `T0` in `M104 T0`)
			// into one word, so we check the leading letter rather than requiring a bare single-letter word
			// Codes with a unprecedentedParameter (M117's message, T's tool number, ...) can also expose text in an
			// unprefixed slot between the code and the first parameter letter. If the hovered word isn't a
			// recognised parameter letter AND the cursor sits in the direct-value segment, fall through to
			// the unprecedentedParameter hover instead of returning nothing
			if (enclosing && !wordIsCode)
			{
				const info = findGcode(enclosing.code);
				// First try: cursor sits anywhere inside a parameter's expanded value range (e.g. on the
				// `100` of `S100`, inside `{global.x}` of `E{global.x}`, inside `"foo.g"` of `P"foo.g"`, or
				// inside `1:2:3` of `E1:2:3`). This covers hovers that don't land on the letter itself
				const paramAtCursor = findParameterAtCursor(lineContent, enclosing.startColumn + enclosing.code.length - 1, position.column);
				if (info && paramAtCursor)
				{
					const param = info.parameters.find(p => p.letter.toUpperCase() === paramAtCursor.letter.toUpperCase());
					if (param)
					{
						const valueRange = findParameterValueRange(lineContent, paramAtCursor.letterColZero);
						return {
							range: new monacoInstance.Range(position.lineNumber, valueRange.startCol, position.lineNumber, valueRange.endCol),
							contents: [md(buildParameterDoc(info, param))]
						};
					}
				}
				// Fallback: hovered word starts with a parameter letter (e.g. bare `X` in `M84 X Y Z`, where
				// the letter has no value after it so findParameterAtCursor may stop before reaching it)
				if (info && /^[A-Za-z]/.test(word.word))
				{
					const param = info.parameters.find(p => p.letter.toUpperCase() === firstLetter.toUpperCase());
					if (param)
					{
						const valueRange = findParameterValueRange(lineContent, word.startColumn - 1);
						return {
							range: new monacoInstance.Range(position.lineNumber, valueRange.startCol, position.lineNumber, valueRange.endCol),
							contents: [md(buildParameterDoc(info, param))]
						};
					}
				}
			}
			// Hover on an unprecedented-parameter argument: M117's `"Hello World"`, T's `0`, or any expression
			// `{...}` / quoted string passed in the same slot. Fires when the hovered word sits past the code
			// but strictly before any parameter-letter token on the line, so hovering `P1` of `T0 P1` still
			// routes through the param branch above. The hover's range expands from the first non-whitespace
			// char after the code to the start of the first param letter (or end-of-line / start of comment),
			// so the tooltip stays visible while the cursor moves anywhere inside the expression - useful for
			// multi-token values like `{global.tool}` or `"Hello World"`
			if (enclosing && !wordIsCode)
			{
				const info = findGcode(enclosing.code);
				if (info?.unprecedentedParameter)
				{
					const segment = findUnprecedentedParameterRange(lineContent, enclosing.startColumn + enclosing.code.length - 1);
					if (segment && word.startColumn >= segment.startCol && word.endColumn <= segment.endCol)
					{
						let doc = `**Parameter** - ${info.unprecedentedParameter.description}`;
						if (info.deprecated)
						{
							doc += `\n\n${deprecatedHtml(info.deprecated)}`;
						}
						return {
							range: new monacoInstance.Range(position.lineNumber, segment.startCol, position.lineNumber, segment.endCol),
							contents: [md(doc)]
						};
					}
				}
			}
			// Hover on a G/M/T-code itself. For T we always feed the bare "T" identifier into `buildCodeDoc`
			// regardless of any trailing tool number baked into the word ("T", "T0", "T1", ...) since the data
			// entry keys off the single letter and treats the number as an unprecedentedParameter. When the
			// code carries an unprecedentedParameter we also extend the hover range to cover any signed int
			// or `{...}` expression that follows, so hovering `T-1` or `T{global.tool}` highlights the whole
			// token rather than just `T`
			// Exception: M911's P parameter holds a string of G-code to run on power-loss (e.g.
			// `M911 ... P"M913 X0 Y0 G91 G1 Z3"`) so codes nested inside its quoted value SHOULD resolve to
			// their hover info. To detect this, find the column where the current string opens and look up
			// the code that precedes it. Other in-string matches (e.g. `"M104 done"` in M118's S parameter)
			// stay suppressed
			let openQuoteCol = -1;
			let inStr = false;
			for (let i = 0; i < beforeWordForString.length; i++)
			{
				if (beforeWordForString[i] === "\"")
				{
					if (!inStr)
					{
						inStr = true;
						openQuoteCol = i + 1;
					}
					else
					{
						inStr = false;
						openQuoteCol = -1;
					}
				}
			}
			const outerCode = openQuoteCol > 0 ? findCodeAtCursor(lineContent, openQuoteCol) : null;
			const isPowerLossString = insideString && outerCode?.code === "M911";
			const wordCodeSuppressedByString = insideString && !isPowerLossString;
			if (wordIsCode && !wordCodeSuppressedByString)
			{
				const canonical = enclosing!.code;
				const doc = buildCodeDoc(canonical);
				if (doc)
				{
					const info = findGcode(canonical);
					let endCol = word.endColumn;
					if (info?.unprecedentedParameter)
					{
						const segment = findUnprecedentedParameterRange(lineContent, enclosing!.startColumn + enclosing!.code.length - 1);
						if (segment)
						{
							endCol = Math.max(endCol, segment.endCol);
						}
					}
					return {
						range: new monacoInstance.Range(position.lineNumber, word.startColumn, position.lineNumber, endCol),
						contents: [md(doc)]
					};
				}
			}
			// Hover on a built-in expression function (sin, abs, vector, ...) or constant (pi, iterations, ...)
			// when the cursor is inside an expression context. Checked before the OM chain so `sin` alone (no
			// `.` / `[n]`) is covered; `fans[0].max` stays on the OM chain path since that match wins anyway
			if (insideExpression)
			{
				const fn = expressionData.functions.find(f => f.name === word.word);
				if (fn)
				{
					return {
						range: new monacoInstance.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn),
						contents: [md(`**${fn.syntax}**\n\n${fn.description}`)]
					};
				}
				const constant = expressionData.constants.find(c => c.name === word.word);
				if (constant)
				{
					return {
						range: new monacoInstance.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn),
						contents: [md(`**${constant.name}**\n\n${constant.description}`)]
					};
				}
			}
			// Hover on an object-model path segment: look up the description via the machine context's
			// optional `getObjectModelDescription` callback (DWC wires this to DuetAPI.xml). Even without a
			// callback we surface the @deprecated note if one applies to the hovered prefix
			const omHover = findObjectModelHover(lineContent, position.column);
			if (omHover)
			{
				const ctx = getMachineContext();
				const description = ctx?.getObjectModelDescription
					? await Promise.resolve(ctx.getObjectModelDescription(omHover.normalized))
					: null;
				const deprecation = getPathDeprecation(omHover.prefix);
				if (description || deprecation !== null)
				{
					let body = `\`${omHover.normalized}\``;
					if (description)
					{
						body += `\n\n${description}`;
					}
					if (deprecation !== null)
					{
						body += `\n\n${deprecatedHtml(deprecation || "This field is deprecated")}`;
					}
					return {
						range: new monacoInstance.Range(position.lineNumber, omHover.segStartColumn, position.lineNumber, omHover.segEndColumn),
						contents: [md(body)]
					};
				}
			}
			return null;
		}
	}));

	return disposables;
}

/**
 * Register Duet completion and hover providers for both gcode-fdm and gcode-cnc languages.
 */
export function registerDuetProviders(monacoInstance: typeof monaco): monaco.IDisposable[]
{
	return [
		...registerProvidersFor(monacoInstance, "gcode-fdm"),
		...registerProvidersFor(monacoInstance, "gcode-cnc")
	];
}

/**
 * Attach a per-editor cursor-position watcher that closes the signature-help tooltip immediately when the cursor
 * moves to a position where our provider would return null (between parameters, before the code, on a different line).
 * Monaco only re-invokes the signature-help provider on content changes, so this bridges arrow-key / click movement.
 * Call this once per editor right after `monaco.editor.create(...)`.
 */
export function attachGcodeSignatureHelpWatcher(editor: monaco.editor.IStandaloneCodeEditor): monaco.IDisposable
{
	// Close parameter hints when the suggest widget transitions from hidden to visible, so the two popups don't
	// overlap while the user is typing. We only react on the visible-edge and skip the action if parameter hints
	// is currently open because that means Monaco just invoked it (e.g. after Enter on a completion item) and we
	// would otherwise swallow it
	const editorDom = editor.getDomNode();
	const isWidgetVisible = (sel: string): boolean =>
	{
		if (!editorDom)
		{
			return false;
		}
		const w = editorDom.querySelector(sel);
		return !!(w && !w.classList.contains("hidden") && getComputedStyle(w).display !== "none");
	};
	// Shared helper: decides, based on cursor position, whether parameter hints should be dismissed, opened, or left alone
	function reevaluateHints(): void
	{
		const model = editor.getModel();
		const position = editor.getPosition();
		if (!model || !position)
		{
			return;
		}
		const lineContent = model.getLineContent(position.lineNumber);
		const beforeCursor = lineContent.substring(0, position.column - 1);
		const code = findCodeAtCursor(lineContent, position.column - 1);
		const keywordMatch = /^\s*([a-z]+)(\s|$)/.exec(lineContent);
		const onKeyword = !!(keywordMatch && metaKeywords.some(k => k.keyword === keywordMatch[1]));
		const insideExpression = isInsideExpression(beforeCursor);
		const insideFunctionCall = insideExpression && findEnclosingFunctionCall(beforeCursor) !== null;
		let shouldDismiss = false;
		if (!code && !onKeyword)
		{
			shouldDismiss = true;
		}
		else if (code)
		{
			const info = findGcode(code.code);
			if (!info || (info.parameters.length === 0 && !info.unprecedentedParameter))
			{
				shouldDismiss = true;
			}
			else
			{
				const tail = beforeCursor.substring(code.startColumn - 1 + code.code.length);
				const lastChar = beforeCursor.charAt(beforeCursor.length - 1);
				if (/\S/.test(tail))
				{
					if (lastChar === " " || lastChar === "\t")
					{
						shouldDismiss = true;
					}
					else if (lastChar === "}" && (tail.match(/\{/g) || []).length === (tail.match(/\}/g) || []).length)
					{
						shouldDismiss = true;
					}
					else if (lastChar === "\"" && ((tail.match(/"/g) || []).length % 2) === 0)
					{
						shouldDismiss = true;
					}
				}
			}
		}
		// In an expression but not inside a function call, hide the tooltip - the user is typing values, not a code/parameter
		if (insideExpression && !insideFunctionCall)
		{
			editor.trigger("gcode", "closeParameterHints", null);
		}
		else if (shouldDismiss)
		{
			editor.trigger("gcode", "closeParameterHints", null);
		}
		else if ((insideFunctionCall || code) && !isWidgetVisible(".suggest-widget"))
		{
			// Cursor landed on/inside a known code or function call - open parameter hints so the summary is visible
			// Keywords are intentionally omitted so the user has to invoke via Ctrl+Space to see the expression syntax;
			// otherwise the tooltip would keep popping up while editing `if|while|elif` conditions. We also skip when
			// the suggest widget is visible so the two popups don't overlap; once suggest closes the mutation observer
			// calls us again to catch up
			editor.trigger("gcode", "editor.action.triggerParameterHints", null);
		}
	}

	let observer: MutationObserver | null = null;
	if (editorDom && typeof MutationObserver !== "undefined")
	{
		let lastSuggestVisible = isWidgetVisible(".suggest-widget");
		observer = new MutationObserver(() =>
		{
			const suggestVisible = isWidgetVisible(".suggest-widget");
			if (suggestVisible && !lastSuggestVisible)
			{
				editor.trigger("gcode", "closeParameterHints", null);
			}
			else if (!suggestVisible && lastSuggestVisible)
			{
				// Suggest just closed - parameter hints may need to open now if the cursor is parked on a code
				// (e.g. the user typed the only remaining parameter letter, which dismissed the suggest list
				// but didn't move the cursor to produce another onDidChangeCursorPosition event)
				reevaluateHints();
			}
			lastSuggestVisible = suggestVisible;
		});
		observer.observe(editorDom, { subtree: true, attributes: true, attributeFilter: ["class", "style"] });
	}

	const cursorDisposable = editor.onDidChangeCursorPosition(reevaluateHints);
	return {
		dispose: () =>
		{
			cursorDisposable.dispose();
			observer?.disconnect();
		}
	};
}

/**
 * Apply a strikethrough decoration (class `duet-deprecated-code`) to every occurrence of a deprecated G/M/T-code
 * (e.g. `M557`) and to every deprecated parameter letter belonging to any G/M/T-code on that line (e.g. the `S` in
 * `M84 S`). Re-runs on every content change; hover tooltip carries the deprecation reason.
 * Call once per editor; the returned IDisposable removes the listener and clears the decorations.
 */
export function attachGcodeDeprecationDecorations(editor: monaco.editor.IStandaloneCodeEditor): monaco.IDisposable
{
	// Codes with `deprecated` flag: the code identifier itself gets struck through
	const deprecatedCodes = gcodeData.filter(g => !!g.deprecated);
	const deprecatedCodeAlternation = deprecatedCodes.length > 0
		? deprecatedCodes.map(g => g.code.replace(/[.\\$^*+?()[\]{}|]/g, "\\$&")).join("|")
		: null;
	const deprecatedCodeRegex = deprecatedCodeAlternation
		? new RegExp("(?:^|[^\\w])(" + deprecatedCodeAlternation + ")(?=$|[^\\w])", "g")
		: null;

	return attachDecorationsFromModelScan(editor, model =>
	{
		// Every G/M/T code on a line, so we can locate the segment that may hold deprecated parameter letters
		// Mirrors the primary `codeRegex` / `findCodeAtCursor` T-rule: a bare `T` following another G/M on the
		// same line is treated as that preceding code's parameter, not as a new code
		const anyCodeRegex = /([GM]\d+(?:\.\d+)?|T(?![A-Za-z]))/g;
		const paramLetterRegex = /(^|[\s])([A-Za-z])(?=[\s]|$|[-+0-9.\"'{])/g;
		const newDecorations: monaco.editor.IModelDeltaDecoration[] = [];
		for (let lineNumber = 1; lineNumber <= model.getLineCount(); lineNumber++)
		{
			const text = model.getLineContent(lineNumber);
			// Strip the `;` line-comment so we never mark letters inside comments
			const semi = text.indexOf(";");
			const effective = semi >= 0 ? text.substring(0, semi) : text;
			// Deprecated codes themselves
			if (deprecatedCodeRegex)
			{
				deprecatedCodeRegex.lastIndex = 0;
				let m: RegExpExecArray | null;
				while ((m = deprecatedCodeRegex.exec(text)) !== null)
				{
					const code = m[1];
					const startColumn = m.index + (m[0].length - code.length) + 1;
					const endColumn = startColumn + code.length;
					newDecorations.push({
						range: { startLineNumber: lineNumber, endLineNumber: lineNumber, startColumn, endColumn },
						options: { inlineClassName: "duet-deprecated-code" }
					});
				}
			}
			// Deprecated parameter letters: enumerate all codes on the line, then scan their trailing segment
			const codeOccurrences: { code: string; startColumn: number; endColumn: number }[] = [];
			let haveGMmatch = false;
			anyCodeRegex.lastIndex = 0;
			let cm: RegExpExecArray | null;
			while ((cm = anyCodeRegex.exec(effective)) !== null)
			{
				const code = cm[1];
				if (code === "T" && haveGMmatch)
				{
					continue;
				}
				if (code[0] !== "T")
				{
					haveGMmatch = true;
				}
				codeOccurrences.push({
					code,
					startColumn: cm.index + 1,
					endColumn: cm.index + 1 + code.length
				});
			}
			for (let i = 0; i < codeOccurrences.length; i++)
			{
				const occ = codeOccurrences[i];
				const canonical = occ.code[0].toUpperCase() + occ.code.substring(1);
				const info = findGcode(canonical);
				if (!info)
				{
					continue;
				}
				const deprecatedParams = info.parameters.filter(p => !!p.deprecated);
				if (deprecatedParams.length === 0)
				{
					continue;
				}
				const segStart = occ.endColumn - 1;
				const segEnd = i + 1 < codeOccurrences.length ? codeOccurrences[i + 1].startColumn - 1 : effective.length;
				const segText = effective.substring(segStart, segEnd);
				paramLetterRegex.lastIndex = 0;
				let pm: RegExpExecArray | null;
				while ((pm = paramLetterRegex.exec(segText)) !== null)
				{
					const letter = pm[2].toUpperCase();
					const param = deprecatedParams.find(p => p.letter.toUpperCase() === letter);
					if (!param)
					{
						continue;
					}
					const absColumn = segStart + pm.index + pm[1].length + 1;
					newDecorations.push({
						range: { startLineNumber: lineNumber, endLineNumber: lineNumber, startColumn: absColumn, endColumn: absColumn + 1 },
						options: { inlineClassName: "duet-deprecated-code" }
					});
				}
			}
		}
		return newDecorations;
	});
}

/**
 * Shared lifecycle skeleton for per-editor decoration attachers: runs `compute(model)` up front, re-runs it
 * on every content change and on model switches, and clears the decorations on disposal. Installs the
 * shared strikethrough CSS once. Extracted from the G-code and object-model deprecation attachers, which
 * both wanted the same scaffolding.
 */
function attachDecorationsFromModelScan(
	editor: monaco.editor.IStandaloneCodeEditor,
	compute: (model: monaco.editor.ITextModel) => monaco.editor.IModelDeltaDecoration[]
): monaco.IDisposable
{
	installDeprecatedCodeStyle();
	let decorations: string[] = [];
	let pendingTimer: ReturnType<typeof setTimeout> | null = null;
	let disposed = false;
	const refresh = (): void =>
	{
		if (disposed)
		{
			return;
		}
		const model = editor.getModel();
		if (!model)
		{
			return;
		}
		decorations = editor.deltaDecorations(decorations, compute(model));
	};
	// Defer to a microtask so we don't call deltaDecorations from inside Monaco's own edit cycle
	// Without this, every `onDidChangeModelContent` callback that mutates decorations triggers Monaco's
	// "Invoking deltaDecorations recursively could lead to leaking decorations" warning
	const scheduleRefresh = (): void =>
	{
		if (pendingTimer !== null)
		{
			return;
		}
		pendingTimer = setTimeout(() =>
		{
			pendingTimer = null;
			refresh();
		}, 0);
	};
	refresh();
	const modelListener = editor.onDidChangeModelContent(scheduleRefresh);
	const modelSwitchListener = editor.onDidChangeModel(scheduleRefresh);
	return {
		dispose: () =>
		{
			disposed = true;
			if (pendingTimer !== null)
			{
				clearTimeout(pendingTimer);
				pendingTimer = null;
			}
			modelListener.dispose();
			modelSwitchListener.dispose();
			editor.deltaDecorations(decorations, []);
		}
	};
}

let deprecatedCodeStyleInstalled = false;
function installDeprecatedCodeStyle(): void
{
	if (deprecatedCodeStyleInstalled || typeof document === "undefined")
	{
		return;
	}
	const style = document.createElement("style");
	style.textContent = ".duet-deprecated-code { text-decoration: line-through; }";
	document.head.appendChild(style);
	deprecatedCodeStyleInstalled = true;
}

/**
 * Strike-through deprecated object-model paths that appear in the editor. Matches dotted chains like
 * `move.extruders[0].pressureAdvance`, normalises the bracket indices to `[]`, and highlights the chain if
 * the normalised path is present in the deprecations map shipped by @duet3d/objectmodel. Re-runs on every
 * content change; hover tooltip carries the deprecation reason.
 */
export function attachObjectModelDeprecationDecorations(editor: monaco.editor.IStandaloneCodeEditor): monaco.IDisposable
{
	// Identifier chain with at least one `.` or `[n]` step. Non-greedy on boundaries so adjacent text
	// (e.g. trailing brackets / punctuation) isn't consumed
	const chainRegex = /[A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*|\[\d+\])+/g;

	return attachDecorationsFromModelScan(editor, model =>
	{
		const newDecorations: monaco.editor.IModelDeltaDecoration[] = [];
		for (let lineNumber = 1; lineNumber <= model.getLineCount(); lineNumber++)
		{
			const text = model.getLineContent(lineNumber);
			chainRegex.lastIndex = 0;
			let m: RegExpExecArray | null;
			while ((m = chainRegex.exec(text)) !== null)
			{
				const deprecation = getPathDeprecation(m[0]);
				if (deprecation === null)
				{
					continue;
				}
				const startColumn = m.index + 1;
				const endColumn = startColumn + m[0].length;
				newDecorations.push({
					range: { startLineNumber: lineNumber, endLineNumber: lineNumber, startColumn, endColumn },
					options: { inlineClassName: "duet-deprecated-code" }
				});
			}
		}
		return newDecorations;
	});
}
