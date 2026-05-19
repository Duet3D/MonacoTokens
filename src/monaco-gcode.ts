import * as monaco from "monaco-editor/esm/vs/editor/editor.api";

/**
 * Generate a Monarch language for RRF-style G-code
 * @param cncMode If true, comments in parentheses are allowed
 */
function generateMonarchLanguage(fdmMode: boolean): monaco.languages.IMonarchLanguage {
	return {
		consts: ["true", "false", "iterations", "line", "null", "pi", "result", "input"],
		functions: ["abs", "acos", "asin", "atan", "atan2", "cos", "degrees", "exists", "fileexists", "fileread", "floor", "isnan", "max",
			"min", "mod", "radians", "random", "sin", "square", "sqrt", "tan", "vector", "take", "drop", "find"],
		keywords: ["abort", "echo", "if", "elif", "while", "set"],
		noArgKeywords: ["else", "break", "continue"],
		varKeywords: ["global", "var"],
		symbols: /[=><!~?:&|+\-*#\/\^%]+/,
		operators: ['*', '/', '+', '-', "==", "!=", '=', "<=", '<', ">=", ">>>", ">>", '>', '!', "&&", '&', "||", '|', '^', '?', ':'],
		includeLF: true,
		tokenizer: {
			root: [
				// G/M/T-codes - M-codes use their own state because T is a valid M-code parameter letter,
				// whereas inside a G-code's parameter list T starts a new T-code on the same line
				[/[gG][0123](?=\D)/, "keyword", fdmMode ? "normalGcode" : "moveGcode"],
				[/[gG]\d+(\.\d+)?/, "keyword", "normalGcode"],
				[/[mM]\d+(\.\d+)?/, "keyword", "normalMcode"],
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

				// comments
				[/;.*/, "comment"],
				[/\(.*\)/, fdmMode ? "invalid" : "comment"]
			],
			gcode: [
				// next G/M-code on the same line (T re-entry is handled per-state - see normalGcode)
				[/[gG][0123](?=\D)/, "keyword", "moveGcode"],
				[/[gG]\d+(\.\d*)?/, "keyword", "normalGcode"],
				[/[mM]\d+(\.\d*)?/, "keyword", "normalMcode"],

				// parameter letters
				[/'?[a-zA-Z]/, "keyword"],

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
				// T inside a G-code parameter list starts a new T-code (T is not a valid G-code parameter)
				[/[tT](?=\{)/, "keyword", "normalGcodeWithT"],
				[/[tT]-?\d+/, "keyword", "normalGcodeWithT"],

				// include normal gcode
				{ include: "gcode" },

				// EOL
				[/\n/, "", "@popall"]
			],
			normalMcode: [
				// T is a parameter letter inside an M-code, not a new T-code - so this state intentionally
				// omits the T-code re-entry rules that normalGcode has
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

				// nested expressions
				[/{/, "operator", "@curlyBracket"],
				[/\[/, "operator", "@squareBracket"],

				// numbers
				[/\d*\.\d+([eE][\-+]?\d+)?/, "number.float"],
				[/0[xX][0-9a-fA-F]+/, "number.hex"],
				[/\d+/, "number"],

				// strings and chars
				[/"(.|\"\")*?"/, "string"],
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
				// curly brackets contain expressions
				{ include: "expression" },

				// terminate whern reaching a closing bracket
				[/}/, "operator", "@pop"],
			],
			squareBracket: [
				// square brackets contain expressions
				{ include: "expression" },

				// terminate whern reaching a closing bracket
				[/\]/, "operator", "@pop"],
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
