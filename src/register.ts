import type * as monaco from "monaco-editor/esm/vs/editor/editor.api";

import { gcodeFDMLanguage, gcodeCNCLanguage, gcodeLanguageConfiguration } from "./monaco-gcode";
import { stm32Language, stm32LanguageConfiguration } from "./monaco-stm32";
import { menuLanguage, menuLanguageConfiguration } from "./monaco-menu";
import { registerDuetProviders, attachGcodeSignatureHelpWatcher, attachGcodeDeprecationDecorations, attachObjectModelDeprecationDecorations } from "./providers";
import { attachLocalVariableScanner } from "./gcodes/local-variables";
import { addGcodeSearchAction } from "./gcodes/search";

/**
 * Override Monaco's built-in `vs` and `vs-dark` themes to map the tokens our tokenizer emits to VSCode's
 * TextMate-scope colours (Monaco standalone's defaults otherwise lack a dedicated "function" colour). Called
 * once by `registerDuetLanguages`; uses `inherit: true` so the base theme's other colours stay in place.
 */
function applyDuetThemeOverrides(monacoInstance: typeof monaco): void {
	monacoInstance.editor.defineTheme("vs-dark", {
		base: "vs-dark",
		inherit: true,
		rules: [
			// VSCode Dark+ entity.name.function / support.function colour
			{ token: "support.function", foreground: "DCDCAA" }
		],
		colors: {}
	});
	monacoInstance.editor.defineTheme("vs", {
		base: "vs",
		inherit: true,
		rules: [
			// VSCode Light+ entity.name.function / support.function colour
			{ token: "support.function", foreground: "795E26" }
		],
		colors: {}
	});
}

/**
 * Register all Duet-specific languages (gcode-fdm, gcode-cnc, stm32, menu) with a Monaco instance,
 * attaching their tokenizers, language configurations, and (for gcode) completion + hover providers.
 */
export function registerDuetLanguages(monacoInstance: typeof monaco): monaco.IDisposable[] {
	monacoInstance.languages.register({ id: "gcode-fdm" });
	monacoInstance.languages.setMonarchTokensProvider("gcode-fdm", gcodeFDMLanguage);
	monacoInstance.languages.setLanguageConfiguration("gcode-fdm", gcodeLanguageConfiguration);

	monacoInstance.languages.register({ id: "gcode-cnc" });
	monacoInstance.languages.setMonarchTokensProvider("gcode-cnc", gcodeCNCLanguage);
	monacoInstance.languages.setLanguageConfiguration("gcode-cnc", gcodeLanguageConfiguration);

	monacoInstance.languages.register({ id: "stm32" });
	monacoInstance.languages.setMonarchTokensProvider("stm32", stm32Language);
	monacoInstance.languages.setLanguageConfiguration("stm32", stm32LanguageConfiguration);

	monacoInstance.languages.register({ id: "menu" });
	monacoInstance.languages.setMonarchTokensProvider("menu", menuLanguage);
	monacoInstance.languages.setLanguageConfiguration("menu", menuLanguageConfiguration);

	applyDuetThemeOverrides(monacoInstance);

	return registerDuetProviders(monacoInstance);
}

/**
 * Wire up every per-editor Gcode feature in one call: the search action, signature-help watcher, deprecation
 * decorations for codes / parameters and object-model paths, and the local-variable scanner. Intended to
 * replace the separate attach/add calls at the call site. Returns a single IDisposable that releases all of
 * them when disposed.
 */
export function attachGcodeFeatures(monacoInstance: typeof monaco, editor: monaco.editor.IStandaloneCodeEditor): monaco.IDisposable {
	const disposables: monaco.IDisposable[] = [
		addGcodeSearchAction(monacoInstance, editor),
		attachGcodeSignatureHelpWatcher(editor),
		attachGcodeDeprecationDecorations(editor),
		attachObjectModelDeprecationDecorations(editor),
		attachLocalVariableScanner(editor)
	];
	return {
		dispose() {
			for (const d of disposables) {
				d.dispose();
			}
		}
	};
}