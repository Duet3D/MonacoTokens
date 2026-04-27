import type * as monaco from "monaco-editor/esm/vs/editor/editor.api";

/** Debounce delay for rescanning a model's `var` / `global` declarations on content change (ms). */
const LOCAL_VARIABLE_RESCAN_DEBOUNCE_MS = 250;

/**
 * Names declared inside the currently-edited model via RRF's meta language (`var foo = ...`, `global bar = ...`).
 * Populated by `attachLocalVariableScanner(editor)` and consulted by the expression completion provider when
 * the user types `var.` / `global.`.
 */
export interface LocalVariables
{
	/** `var <name>` declarations seen on any line of the model. */
	readonly vars: ReadonlySet<string>;
	/** `global <name>` declarations seen on any line of the model. */
	readonly globals: ReadonlySet<string>;
}

const empty: LocalVariables = { vars: new Set<string>(), globals: new Set<string>() };
// WeakMap so dispose is automatic when Monaco's model is garbage-collected
const scans = new WeakMap<monaco.editor.ITextModel, LocalVariables>();

// Matches `var name`, `global name` optionally followed by `=` (trailing assignment not required for the capture)
const declRegex = /^\s*(var|global)\s+([A-Za-z_][\w]*)/;

function scan(model: monaco.editor.ITextModel, maxLines: number): LocalVariables
{
	const vars = new Set<string>();
	const globals = new Set<string>();
	const lineCount = Math.min(model.getLineCount(), maxLines);
	for (let line = 1; line <= lineCount; line++)
	{
		const text = model.getLineContent(line);
		const m = declRegex.exec(text);
		if (m)
		{
			(m[1] === "var" ? vars : globals).add(m[2]);
		}
	}
	return { vars, globals };
}

/**
 * Attach a background scanner that keeps track of `var` and `global` declarations in the given editor's model.
 * Re-runs on every content change, debounced to avoid churn on large files. The result is consumed by the
 * expression completion provider through `getLocalVariables(model)`.
 *
 * Scans up to `maxLines` lines (default 5000) - well beyond typical macro size but bounded for generated
 * G-code exports that would otherwise pay a per-keystroke cost.
 */
export function attachLocalVariableScanner(editor: monaco.editor.IStandaloneCodeEditor, maxLines: number = 5000): monaco.IDisposable
{
	let timeout: ReturnType<typeof setTimeout> | null = null;
	const rescan = () =>
	{
		const model = editor.getModel();
		if (model)
		{
			scans.set(model, scan(model, maxLines));
		}
	};
	const schedule = () =>
	{
		if (timeout !== null)
		{
			clearTimeout(timeout);
		}
		timeout = setTimeout(rescan, LOCAL_VARIABLE_RESCAN_DEBOUNCE_MS);
	};
	rescan();
	const contentListener = editor.onDidChangeModelContent(schedule);
	const modelListener = editor.onDidChangeModel(rescan);
	return {
		dispose: () =>
		{
			if (timeout !== null)
			{
				clearTimeout(timeout);
			}
			contentListener.dispose();
			modelListener.dispose();
		}
	};
}

/**
 * Return the most recently scanned `var`/`global` declarations for the given model, or empty sets if no
 * scanner is attached (or the first scan hasn't completed yet).
 */
export function getLocalVariables(model: monaco.editor.ITextModel): LocalVariables
{
	return scans.get(model) ?? empty;
}