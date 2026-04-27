import type * as monaco from "monaco-editor/esm/vs/editor/editor.api";

/**
 * Generate a Monarch language for RRF-style G-code
 * @param cncMode If true, comments in parentheses are allowed
 */
function generateMonarchLanguage(fdmMode: boolean): monaco.languages.IMonarchLanguage {
	return {
		consts: ["true", "false", "iterations", "line", "null", "pi", "result", "input"],
		functions: ["abs", "acos", "asin", "atan", "atan2", "ceil", "cos", "datetime", "degrees", "drop", "exists", "exp", "fileexists", "fileread",
			"find", "floor", "isnan", "log", "max", "min", "mod", "pow", "radians", "random", "round", "sin", "sqrt", "square", "take", "tan", "vector"],
		// Non-flow meta keywords that take an expression after (abort/echo/set) - render as regular keywords (blue)
		keywords: ["abort", "echo", "set"],
		// Flow-control keywords that take a condition/expression - render in Monaco's flow-keyword purple (matches VSCode)
		flowExprKeywords: ["if", "elif", "while"],
		// Flow-control keywords that stand alone - render in the same purple as flowExprKeywords
		flowNoArgKeywords: ["else", "break", "continue"],
		varKeywords: ["global", "var"],
		symbols: /[=><!~?:&|+\-*#\/\^%]+/,
		operators: ['*', '/', '+', '-', "==", "!=", '=', "<=", '<', ">=", ">>>", ">>", '>', '!', "&&", '&', "||", '|', '^', '?', ':'],
		includeLF: true,
		tokenizer: {
			root: [
				// line numbers
				[/[nN]\d+/, "type"],

				// G53 acting as a same-line prefix (e.g. "G53 G1 X10") - highlight as a modifier, distinct from both
				// line numbers (type) and regular codes (keyword)
				[/[gG]53(?=[\s]+[gGmMtT][0-9-])/, "regexp", "afterG53"],

				// G/M/T-codes (including bare G53 on its own line, which behaves like a regular command)
				[/[gG][0123](?=\D)/, "keyword", fdmMode ? "normalGcode" : "moveGcode"],
				[/[gGmM]\d+(\.\d+)?/, "keyword", "normalGcode"],
				[/[tT](?=\{)/, "keyword", "normalGcodeWithT"],
				[/[tT]-?\d+/, "keyword", "normalGcodeWithT"],

				// meta keywords
				[/[a-z_$][\w$]*/, {
					cases: {
						"@keywords": { token: "keyword", next: "@lineExpression" },
						"@flowExprKeywords": { token: "keyword.flow", next: "@lineExpression" },
						"@flowNoArgKeywords": { token: "keyword.flow" },
						"@varKeywords": { token: "keyword", next: "varName" }
					}
				}],

				// numbers
				[/\d*\.\d+([eE][\-+]?\d+)?/, "number.float"],
				[/0[xX][0-9a-fA-F]+/, "number.hex"],
				[/\d+/, "number"],

				// strings
				[/"(.|\"\")*?"/, "string"],
				[/"[^"\n]*/, "invalid"],

				// comments
				[/;.*/, "comment"],
				[/\(.*\)/, fdmMode ? "invalid" : "comment"]
			],
			afterG53: [
				// whitespace between the G53 prefix and the following G/M/T-code
				[/[ \t]+/, ""],

				// next G/M/T-code - replace this state with the code's own state so its parameters
				// are parsed normally and any trailing T letters are treated as parameters, not T-codes
				[/[gG][0123](?=\D)/, { token: "keyword", switchTo: fdmMode ? "@normalGcode" : "@moveGcode" }],
				[/[gGmM]\d+(\.\d+)?/, { token: "keyword", switchTo: "@normalGcode" }],
				[/[tT](?=\{)/, { token: "keyword", switchTo: "@normalGcodeWithT" }],
				[/[tT]-?\d+/, { token: "keyword", switchTo: "@normalGcodeWithT" }]
			],
			gcode: [
				// checksums
				[/\*\d+/, "type"],

				// parameter letters
				[/'?[a-zA-Z]/, "keyword"],

				// unterminated expression (no closing brace before end of line)
				[/\{(?![^\n]*\})/, "invalid", "@unterminatedCurly"],

				// expressions
				[/{/, "operator", "@curlyBracket"],

				// enclosed comments
				[/\(.*\)/, "comment"],

				// parameter expressions
				[/T?{/, "expression", "@expression"],

				// include defaults
				{ include: "root" }
			],
			moveGcode: [
				// stop if a T-code or a potential meta G-code command follows
				[/(?=([tT]|[a-zA-Z][a-zA-Z]))/, "keyword", "@popall"],

				// include normal gcode
				{ include: "gcode" }
			],
			normalGcode: [
				// include normal gcode
				{ include: "gcode" },

				// EOL
				[/\n/, "", "@popall"]
			],
			normalGcodeWithT: [
				// already had a T parameter, starting a new T-code
				[/(?=T)/, "keyword", "@popall"],

				// include normal gcode
				{ include: "normalGcode" }
			],
			expression: [
				// variables
				[/(global|param|var)\.[a-zA-Z_$][\w$]*/, "variable.name"],

				// Member access after `]` or any other punctuator (e.g. `fans[1].max`): always a property name,
				// not a function call - so it must win over the function rule below even if the member name
				// happens to match a function identifier (`max`, `min`, ...).
				[/(\.)([a-zA-Z_$][\w$]*)/, ["delimiter", "variable"]],

				// consts and functions need to match before the generic identifier rule below, otherwise
				// `cos` / `pi` / etc. get consumed as plain variables and never reach this check
				// `support.function` is the TextMate scope used by VSCode's Dark+/Light+ themes for built-in
				// function calls; Monaco's default themes have no rule for it, so our `registerDuetLanguages`
				// theme overrides are unambiguously applied (yellow #DCDCAA dark / #795E26 light).
				[/[a-z]\w*/, {
					cases: {
						"@consts": "constant",
						"@functions": "support.function",
						"@default": "variable"
					}
				}],

				// object model properties with dotted paths (e.g. move.axes)
				[/\w+(\.\w+)*/, "variable"],

				// unterminated nested expressions
				[/\{(?![^\n]*\})/, "invalid", "@unterminatedCurly"],
				[/\[(?![^\n]*\])/, "invalid", "@unterminatedSquare"],

				// unterminated nested expressions
				[/\{(?![^\n]*\})/, "invalid", "@unterminatedCurly"],
				[/\[(?![^\n]*\])/, "invalid", "@unterminatedSquare"],

				// nested expressions
				[/{/, "operator", "@curlyBracket"],
				[/\[/, "operator", "@squareBracket"],

				// numbers
				[/\d*\.\d+([eE][\-+]?\d+)?/, "number.float"],
				[/0[xX][0-9a-fA-F]+/, "number.hex"],
				[/\d+/, "number"],

				// strings and chars
				[/"(.|\"\")*?"/, "string"],
				[/"[^"\n]*/, "invalid"],
				[/'.'/, "string"],

				// operators
				[/@symbols/, {
					cases: {
						"@operators": "operator",
						"@default": ""
					}
				}],

				// final comment
				[/;.*/, "comment"],

				// EOL
				[/\n/, "", "@popall"],
			],
			lineExpression: [
				// comments
				[/;.*/, "comment"],

				// line expressions are basically expressions
				{ include: "expression" }
			],
			curlyBracket: [
				// unterminated brace
				[/\n/, "invalid", "@popall"],

				// curly brackets contain expressions
				{ include: "expression" },

				// terminate when reaching a closing bracket
				[/}/, "operator", "@pop"],
			],
			squareBracket: [
				// unterminated bracket
				[/\n/, "invalid", "@popall"],

				// square brackets contain expressions
				{ include: "expression" },

				// terminate when reaching a closing bracket
				[/\]/, "operator", "@pop"],
			],
			unterminatedCurly: [
				// color remainder of line as invalid, then pop
				[/[^\n]+/, "invalid"],
				[/\n/, "", "@popall"]
			],
			unterminatedSquare: [
				[/[^\n]+/, "invalid"],
				[/\n/, "", "@popall"]
			],
			varName: [
				// variable name being declared by `var` / `global` - render as a parameter so the name stands out from generic identifier colour
				[/[a-zA-Z_$][\w$]*/, "variable.parameter", "@expression"],

				// EOL
				[/\n/, "", "@popall"]
			]
		}
	};
}

export const gcodeFDMLanguage: monaco.languages.IMonarchLanguage = generateMonarchLanguage(true);
export const gcodeCNCLanguage: monaco.languages.IMonarchLanguage = generateMonarchLanguage(false);

export const gcodeLanguageConfiguration: monaco.languages.LanguageConfiguration = {
	comments: {
		lineComment: ";"
	},
	brackets: [
		["{", "}"],
		["[", "]"],
		["(", ")"]
	],
	autoClosingPairs: [
		{ open: "{", close: "}" },
		{ open: "[", close: "]" },
		{ open: "(", close: ")" },
		{ open: "\"", close: "\"" }
	],
	surroundingPairs: [
		{ open: "{", close: "}" },
		{ open: "[", close: "]" },
		{ open: "(", close: ")" },
		{ open: "\"", close: "\"" }
	],
	// Python-style block indentation: pressing Enter after if/elif/else/while indents the next line one level deeper
	indentationRules: {
		increaseIndentPattern: /^\s*(if|elif|else|while)\b.*$/,
		// `elif|else` dedent so they align with the matching `if`; `break|continue` end the surrounding while-block
		decreaseIndentPattern: /^\s*(elif|else|break|continue)\b.*$/
	}
};
