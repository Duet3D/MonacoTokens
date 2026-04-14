import type * as monaco from "monaco-editor/esm/vs/editor/editor.api";

import { gcodeFDMLanguage, gcodeCNCLanguage, gcodeLanguageConfiguration } from "./monaco-gcode";
import { stm32Language, stm32LanguageConfiguration } from "./monaco-stm32";
import { menuLanguage, menuLanguageConfiguration } from "./monaco-menu";

/**
 * Register all Duet-specific languages (gcode-fdm, gcode-cnc, STM32, menu)
 * with a Monaco instance, attaching their tokenizers and language configurations.
 */
export function registerDuetLanguages(monacoInstance: typeof monaco) {
	monacoInstance.languages.register({ id: "gcode-fdm" });
	monacoInstance.languages.setMonarchTokensProvider("gcode-fdm", gcodeFDMLanguage);
	monacoInstance.languages.setLanguageConfiguration("gcode-fdm", gcodeLanguageConfiguration);

	monacoInstance.languages.register({ id: "gcode-cnc" });
	monacoInstance.languages.setMonarchTokensProvider("gcode-cnc", gcodeCNCLanguage);
	monacoInstance.languages.setLanguageConfiguration("gcode-cnc", gcodeLanguageConfiguration);

	monacoInstance.languages.register({ id: "STM32" });
	monacoInstance.languages.setMonarchTokensProvider("STM32", stm32Language);
	monacoInstance.languages.setLanguageConfiguration("STM32", stm32LanguageConfiguration);

	monacoInstance.languages.register({ id: "menu" });
	monacoInstance.languages.setMonarchTokensProvider("menu", menuLanguage);
	monacoInstance.languages.setLanguageConfiguration("menu", menuLanguageConfiguration);
}
