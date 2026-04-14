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
		keywords: ["abort", "echo", "if", "elif", "while", "set"],
		noArgKeywords: ["else", "break", "continue"],
		varKeywords: ["global", "var"],
		symbols: /[=><!~?:&|+\-*#\/\^%]+/,
		operators: ['*', '/', '+', '-', "==", "!=", '=', "<=", '<', ">=", ">>>", ">>", '>', '!', "&&", '&', "||", '|', '^', '?', ':'],
		includeLF: true,
		tokenizer: {
			root: [
				// line numbers
				[/[nN]\d+/, "type"],

				// G/M/T-codes
				[/[gG][0123](?=\D)/, "keyword", fdmMode ? "normalGcode" : "moveGcode"],
				[/[gGmM]\d+(\.\d+)?/, "keyword", "normalGcode"],
				[/[tT](?=\{)/, "keyword", "normalGcodeWithT"],
				[/[tT]-?\d+/, "keyword", "normalGcodeWithT"],

				// meta keywords
				[/[a-z_$][\w$]*/, {
					cases: {
						"@keywords": { token: "keyword", next: "@lineExpression" },
						"@noArgKeywords": { token: "keyword" },
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
			gcode: [
				// next G/M/T-code
				[/[gG][0123](?=\D)/, "keyword", "moveGcode"],
				[/[gGmM]\d+(\.\d*)?/, "keyword", "normalGcode"],
				[/[tT](?=\{)/, "keyword", "normalGcodeWithT"],
				[/[tT]-?\d+/, "keyword", "normalGcodeWithT"],

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

				// object model properties
				[/\w+(\.\w+)*/, "variable"],

				// consts and functions
				[/[a-z]\w*/, {
					cases: {
						"@consts": "constant",
						"@functions": "keyword"
					}
				}],

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
				// variable name
				[/[a-zA-Z_$][\w$]*/, "variable.name", "@expression"],

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
		decreaseIndentPattern: /^\s*(break|continue)\b.*$/
	}
};
