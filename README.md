# MonacoTokens

TypeScript support library for editing RepRapFirmware (RRF) files in the [Monaco editor](https://microsoft.github.io/monaco-editor/). It provides syntax highlighting, autocompletion, hover tooltips, signature help and object-model awareness for G-code and the other file formats used by Duet boards.

## Languages

`registerDuetLanguages()` registers four Monaco languages:

- `gcode-fdm` - RRF G-code in FFF/FDM mode
- `gcode-cnc` - RRF G-code in CNC and Laser mode
- `stm32` - `board.txt` hardware configuration (RRF on STM32/LPC)
- `menu` - PanelDue `menu` files

## Features

Since v3.6 the package has grown from plain tokenizers into a full editing experience:

- **One-call registration** - `registerDuetLanguages(monaco)` registers all languages with their bracket/comment configuration and theme colour overrides.
- **G-code autocompletion** - codes (G/M/T) and their parameters from a curated dictionary, including value enumerations where a parameter takes a fixed set of options.
- **Hover tooltips** - code summaries and per-parameter documentation.
- **Signature help** - a floating parameter list for the code being typed, with the active parameter highlighted.
- **Object-model awareness** - completion and hover for object-model expressions (e.g. `move.axes[0].letter`), enum values resolved from the model, and `var`/`global` local-variable completion inside meta G-code.
- **Meta G-code expressions** - functions, keywords and operators used in conditional G-code.
- **Machine-aware axis parameters** - per-axis parameters (positions, speeds, currents, ...) follow the connected machine: the suggestion list and parameter summary only offer the axes the machine actually has, while hovering or typing any supported axis still shows its documentation.
- **Deprecation hints** - deprecated codes, parameters and object-model paths are decorated in the editor and flagged in tooltips.
- **In-editor G-code search** plus a signature-help watcher that keeps the parameter popup in sync.

## Usage

Register the languages once per Monaco instance:

```ts
import { registerDuetLanguages } from "@duet3d/monacotokens";

registerDuetLanguages(monaco);
```

Attach the per-editor G-code features (search action, signature-help watcher, deprecation decorations and the local-variable scanner) to each editor:

```ts
import { attachGcodeFeatures } from "@duet3d/monacotokens";

const features = attachGcodeFeatures(monaco, editor);
// later, when disposing the editor:
features.dispose();
```

### Machine context

For object-model and machine-aware completion (including the axis parameters above), provide the live object model. The providers read through the reference at completion time, so in-place model updates are picked up automatically. Pass a fresh reference whenever your store swaps the model (e.g. on reconnect), and `null` when no machine is connected:

```ts
import { setMachineContext } from "@duet3d/monacotokens";

setMachineContext({ model: machineModel });
```

Without a machine context, axis parameters fall back to the standard letters (X, Y, Z, U, V, W, A, B, C, D), exported as `DEFAULT_AXIS_LETTERS`; the full set of valid axis identifiers is exported as `ALL_AXIS_LETTERS`.

The lower-level Monarch tokenizers (`gcodeFDMLanguage`, `gcodeCNCLanguage`, `stm32Language`, `menuLanguage`) and their language configurations remain exported for manual registration if you do not want the providers:

```ts
monaco.languages.register({ id: "gcode-fdm" });
monaco.languages.setMonarchTokensProvider("gcode-fdm", gcodeFDMLanguage);

monaco.languages.register({ id: "gcode-cnc" });
monaco.languages.setMonarchTokensProvider("gcode-cnc", gcodeCNCLanguage);
```

## Bug reports

Please use the [forum](https://forum.duet3d.com) for support requests or the [DuetWebControl](https://github.com/Duet3D/DuetWebControl) GitHub repository for feature requests and bug reports.
