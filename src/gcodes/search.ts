import type * as monaco from "monaco-editor/esm/vs/editor/editor.api";

import { gcodeData, GcodeInfo } from ".";
import { getMachineContext } from "../objectmodel/machine-context";
import { getLocalVariables } from "./local-variables";
import { getPathDeprecation } from "../objectmodel/deprecations";
import { flattenObjectModel, isInsideExpression } from "../providers";

const widgetId = "duet.gcodeSearchWidget";

interface ActiveWidget {
	editor: monaco.editor.IStandaloneCodeEditor;
	dispose: () => void;
}

let activeWidget: ActiveWidget | null = null;

/**
 * Open the gcode search overlay anchored to the current cursor position, styled like the F2 rename widget.
 */
export function showGcodeSearch(monacoInstance: typeof monaco, editor: monaco.editor.IStandaloneCodeEditor): void
{
	if (activeWidget)
	{
		activeWidget.dispose();
	}

	const root = document.createElement("div");
	root.style.cssText = [
		"width: min(600px, 90vw)",
		"background: var(--vscode-editorWidget-background, #252526)",
		"color: var(--vscode-editorWidget-foreground, #cccccc)",
		"border: 1px solid var(--vscode-editorWidget-border, #454545)",
		"box-shadow: 0 2px 8px rgba(0,0,0,0.4)",
		"font-family: var(--monaco-monospace-font)",
		"font-size: 13px"
	].join("; ");

	const input = document.createElement("input");
	input.type = "text";
	input.placeholder = "Search G/M-code by description";
	input.style.cssText = [
		"display: block",
		"width: 100%",
		"box-sizing: border-box",
		"padding: 4px 6px",
		"background: var(--vscode-input-background, #3c3c3c)",
		"color: var(--vscode-input-foreground, #cccccc)",
		"border: none",
		"border-bottom: 1px solid var(--vscode-editorWidget-border, #454545)",
		"outline: none",
		"font: inherit"
	].join("; ");

	const listAndDetails = document.createElement("div");
	listAndDetails.style.cssText = "display: flex; max-height: 240px";

	const list = document.createElement("div");
	list.style.cssText = [
		"flex: 1",
		"overflow-y: auto",
		"min-width: 0"
	].join("; ");

	const details = document.createElement("div");
	details.style.cssText = [
		"display: none",
		"flex: 1",
		"overflow-y: auto",
		"padding: 6px 8px",
		"border-left: 1px solid var(--vscode-editorWidget-border, #454545)",
		"white-space: pre-wrap",
		"line-height: 1.4"
	].join("; ");

	listAndDetails.appendChild(list);
	listAndDetails.appendChild(details);
	root.appendChild(input);
	root.appendChild(listAndDetails);

	// Detect the active Monaco theme and pick the matching keyword blue
	const editorEl = editor.getDomNode();
	const isDarkTheme = !!(editorEl && (editorEl.classList.contains("vs-dark") || editorEl.classList.contains("hc-black")));
	const codeColor = isDarkTheme ? "#569cd6" : "#0000ff";

	let entries: GcodeInfo[] = [];
	let selectedIndex = 0;
	let rowEls: HTMLDivElement[] = [];
	let detailsVisible = false;

	function renderDetails(): void
	{
		if (!detailsVisible)
		{
			details.style.display = "none";
			return;
		}
		details.style.display = "block";
		details.innerHTML = "";
		const info = entries[selectedIndex];
		if (!info)
		{
			details.textContent = "No entry selected.";
			return;
		}
		const header = document.createElement("div");
		header.style.cssText = `font-weight: bold; color: ${codeColor}; margin-bottom: 4px`;
		header.textContent = `${info.code} - ${info.summary}`;
		details.appendChild(header);
		if (info.deprecated)
		{
			const dep = document.createElement("div");
			dep.style.cssText = "color: #cca700; margin-bottom: 4px";
			dep.textContent = `⚠ Deprecated: ${info.deprecated}`;
			details.appendChild(dep);
		}
		if (info.description)
		{
			const desc = document.createElement("div");
			desc.style.cssText = "margin-bottom: 4px; opacity: 0.9";
			desc.textContent = info.description;
			details.appendChild(desc);
		}
		if (info.parameters.length > 0)
		{
			const p = document.createElement("div");
			p.style.cssText = "margin-top: 4px";
			const heading = document.createElement("div");
			heading.style.fontWeight = "bold";
			heading.textContent = "Parameters:";
			p.appendChild(heading);
			for (const param of info.parameters)
			{
				const row = document.createElement("div");
				row.style.cssText = "margin-left: 8px";
				const letter = document.createElement("span");
				letter.style.fontWeight = "bold";
				letter.textContent = param.letter;
				row.appendChild(letter);
				row.appendChild(document.createTextNode(` - ${param.description}`));
				if (param.deprecated)
				{
					const tag = document.createElement("span");
					tag.style.cssText = "color: #cca700; margin-left: 4px";
					tag.textContent = "(deprecated)";
					row.appendChild(tag);
				}
				p.appendChild(row);
			}
			details.appendChild(p);
		}
	}

	function highlight(): void
	{
		for (let i = 0; i < rowEls.length; i++)
		{
			const active = i === selectedIndex;
			rowEls[i].style.background = active
				? "var(--vscode-list-activeSelectionBackground, #094771)"
				: "transparent";
			rowEls[i].style.color = active
				? "var(--vscode-list-activeSelectionForeground, #ffffff)"
				: "inherit";
		}
		if (rowEls[selectedIndex])
		{
			rowEls[selectedIndex].scrollIntoView({ block: "nearest" });
		}
		renderDetails();
	}

	function render(query: string): void
	{
		const q = query.trim().toLowerCase();
		entries = q.length === 0
			? gcodeData.slice()
			: gcodeData.filter(g => g.code.toLowerCase().includes(q) || g.summary.toLowerCase().includes(q));
		selectedIndex = 0;
		list.innerHTML = "";
		rowEls = [];
		for (const info of entries)
		{
			const row = document.createElement("div");
			row.style.cssText = "padding: 3px 8px; cursor: pointer; display: flex; gap: 8px; white-space: nowrap";
			const code = document.createElement("span");
			code.textContent = info.code;
			code.style.cssText = `min-width: 48px; font-weight: bold; color: ${codeColor}`;
			const desc = document.createElement("span");
			desc.textContent = info.summary;
			desc.style.cssText = "flex: 1; opacity: 0.85; overflow: hidden; text-overflow: ellipsis";
			row.appendChild(code);
			row.appendChild(desc);
			row.addEventListener("mouseenter", () =>
			{
				selectedIndex = rowEls.indexOf(row);
				highlight();
			});
			row.addEventListener("mousedown", (e) =>
			{
				// mousedown so the input doesn't lose focus before we can read selection
				e.preventDefault();
				accept();
			});
			list.appendChild(row);
			rowEls.push(row);
		}
		highlight();
	}

	function accept(): void
	{
		const choice = entries[selectedIndex];
		if (choice)
		{
			const selection = editor.getSelection();
			if (selection)
			{
				editor.executeEdits("duet-gcode-search", [{
					range: selection,
					text: choice.code,
					forceMoveMarkers: true
				}]);
				editor.pushUndoStop();
			}
		}
		close();
	}

	function close(): void
	{
		if (activeWidget && activeWidget.editor === editor)
		{
			activeWidget.dispose();
		}
		editor.focus();
	}

	input.addEventListener("input", (e) =>
	{
		e.stopPropagation();
		render(input.value);
	});
	// Stop key events from bubbling to Monaco so it doesn't run its own auto-complete / typing handlers
	const stopKey = (e: Event) => e.stopPropagation();
	input.addEventListener("keypress", stopKey);
	input.addEventListener("keyup", stopKey);
	const pageStep = 8;
	input.addEventListener("keydown", (e: KeyboardEvent) =>
	{
		e.stopPropagation();
		if (e.key === "ArrowDown")
		{
			e.preventDefault();
			selectedIndex = Math.min(selectedIndex + 1, rowEls.length - 1);
			highlight();
		}
		else if (e.key === "ArrowUp")
		{
			e.preventDefault();
			selectedIndex = Math.max(selectedIndex - 1, 0);
			highlight();
		}
		else if (e.key === "PageDown")
		{
			e.preventDefault();
			selectedIndex = Math.min(selectedIndex + pageStep, rowEls.length - 1);
			highlight();
		}
		else if (e.key === "PageUp")
		{
			e.preventDefault();
			selectedIndex = Math.max(selectedIndex - pageStep, 0);
			highlight();
		}
		else if (e.key === "Home")
		{
			e.preventDefault();
			selectedIndex = 0;
			highlight();
		}
		else if (e.key === "End")
		{
			e.preventDefault();
			selectedIndex = Math.max(0, rowEls.length - 1);
			highlight();
		}
		else if (e.key === "Enter")
		{
			e.preventDefault();
			accept();
		}
		else if (e.key === "Escape")
		{
			e.preventDefault();
			close();
		}
		else if ((e.ctrlKey || e.metaKey) && (e.key === " " || e.code === "Space"))
		{
			// Toggle the details panel, matching Monaco's suggest-widget behaviour
			e.preventDefault();
			detailsVisible = !detailsVisible;
			renderDetails();
		}
	});

	// Use an overlay widget (not a content widget) so the editor's scroll/layout aren't touched at all
	// We position it manually near the cursor by absolute-positioning `root` inside the editor overlay container
	root.style.position = "absolute";
	function positionNearCursor(): void
	{
		const cursorPos = editor.getPosition();
		if (!cursorPos)
		{
			return;
		}
		const coord = editor.getScrolledVisiblePosition(cursorPos);
		const layout = editor.getLayoutInfo();
		if (!coord)
		{
			return;
		}
		const widgetWidth = root.offsetWidth || 600;
		const widgetHeight = root.offsetHeight || 280;
		const lineHeight = editor.getOption(monacoInstance.editor.EditorOption.lineHeight);
		// Prefer below the cursor, flip above if it would overflow the editor viewport
		let top = coord.top + lineHeight;
		if (top + widgetHeight > layout.height)
		{
			top = Math.max(0, coord.top - widgetHeight);
		}
		let left = coord.left;
		if (left + widgetWidth > layout.width)
		{
			left = Math.max(0, layout.width - widgetWidth - 8);
		}
		root.style.top = `${top}px`;
		root.style.left = `${left}px`;
	}

	const widget: monaco.editor.IOverlayWidget = {
		getId: () => widgetId,
		getDomNode: () => root,
		getPosition: () => null
	};
	editor.addOverlayWidget(widget);
	positionNearCursor();
	// Re-position once the DOM has actually measured the widget (offsetWidth/Height are 0 at first paint)
	requestAnimationFrame(positionNearCursor);

	// Close on Esc anywhere in the document (even when focus has drifted to the editor)
	const onDocKeyDown = (e: KeyboardEvent) =>
	{
		if (e.key === "Escape")
		{
			e.preventDefault();
			e.stopPropagation();
			close();
		}
	};
	// Close on mousedown outside the widget
	const onDocMouseDown = (e: MouseEvent) =>
	{
		if (!root.contains(e.target as Node))
		{
			close();
		}
	};
	document.addEventListener("keydown", onDocKeyDown, true);
	document.addEventListener("mousedown", onDocMouseDown, true);

	render("");
	// preventScroll: stops the browser auto-scrolling the page when the cursor is low in the editor
	setTimeout(() => input.focus({ preventScroll: true }), 0);

	activeWidget = {
		editor,
		dispose: () =>
		{
			document.removeEventListener("keydown", onDocKeyDown, true);
			document.removeEventListener("mousedown", onDocMouseDown, true);
			editor.removeOverlayWidget(widget);
			activeWidget = null;
		}
	};
}

/**
 * Open a variant of the search overlay that lists object-model paths instead of G/M-codes. The model is
 * flattened once on open (up to depth 3) and cached in the widget for the duration of the session; arrays
 * are represented by their first element with an `[0]` placeholder. Local `var` / `global` declarations
 * scanned from the current editor model are folded in as `var.<name>` / `global.<name>` entries.
 */
export function showObjectModelSearch(monacoInstance: typeof monaco, editor: monaco.editor.IStandaloneCodeEditor): void
{
	if (activeWidget)
	{
		activeWidget.dispose();
	}

	const root = document.createElement("div");
	root.style.cssText = [
		"width: min(600px, 90vw)",
		"background: var(--vscode-editorWidget-background, #252526)",
		"color: var(--vscode-editorWidget-foreground, #cccccc)",
		"border: 1px solid var(--vscode-editorWidget-border, #454545)",
		"box-shadow: 0 2px 8px rgba(0,0,0,0.4)",
		"font-family: var(--monaco-monospace-font)",
		"font-size: 13px"
	].join("; ");

	const input = document.createElement("input");
	input.type = "text";
	input.placeholder = "Search object-model path...";
	input.style.cssText = [
		"display: block",
		"width: 100%",
		"box-sizing: border-box",
		"padding: 4px 6px",
		"background: var(--vscode-input-background, #3c3c3c)",
		"color: var(--vscode-input-foreground, #cccccc)",
		"border: none",
		"border-bottom: 1px solid var(--vscode-editorWidget-border, #454545)",
		"outline: none",
		"font: inherit"
	].join("; ");

	const list = document.createElement("div");
	list.style.cssText = "display: block; max-height: 240px; overflow-y: auto";

	root.appendChild(input);
	root.appendChild(list);

	const editorEl = editor.getDomNode();
	const isDarkTheme = !!(editorEl && (editorEl.classList.contains("vs-dark") || editorEl.classList.contains("hc-black")));
	const pathColor = isDarkTheme ? "#9CDCFE" : "#001080";

	// Collect all paths once - model-derived paths plus the local scanner's var/global declarations
	const allPaths = new Set<string>();
	const ctx = getMachineContext();
	if (ctx?.model)
	{
		for (const p of flattenObjectModel(ctx.model))
		{
			allPaths.add(p);
		}
	}
	const model = editor.getModel();
	if (model)
	{
		const locals = getLocalVariables(model);
		for (const n of locals.vars)
		{
			allPaths.add(`var.${n}`);
		}
		for (const n of locals.globals)
		{
			allPaths.add(`global.${n}`);
		}
	}
	const flatPaths = Array.from(allPaths).sort();

	let entries: string[] = [];
	let selectedIndex = 0;
	let rowEls: HTMLDivElement[] = [];

	function highlight(): void
	{
		for (let i = 0; i < rowEls.length; i++)
		{
			const active = i === selectedIndex;
			rowEls[i].style.background = active
				? "var(--vscode-list-activeSelectionBackground, #094771)"
				: "transparent";
			rowEls[i].style.color = active
				? "var(--vscode-list-activeSelectionForeground, #ffffff)"
				: "inherit";
		}
		if (rowEls[selectedIndex])
		{
			rowEls[selectedIndex].scrollIntoView({ block: "nearest" });
		}
	}

	function render(query: string): void
	{
		const q = query.trim().toLowerCase();
		entries = q.length === 0 ? flatPaths.slice() : flatPaths.filter(p => p.toLowerCase().includes(q));
		selectedIndex = 0;
		list.innerHTML = "";
		rowEls = [];
		const ctxModel = ctx?.model ?? null;
		for (const path of entries)
		{
			const row = document.createElement("div");
			row.style.cssText = "padding: 3px 8px; cursor: pointer; white-space: nowrap; overflow: hidden; display: flex; gap: 8px; align-items: baseline";
			const pathSpan = document.createElement("span");
			pathSpan.textContent = path;
			pathSpan.style.cssText = `color: ${pathColor}; flex: 1; overflow: hidden; text-overflow: ellipsis`;
			const deprecation = ctxModel ? getPathDeprecation(path) : null;
			if (deprecation !== null)
			{
				pathSpan.style.textDecoration = "line-through";
				pathSpan.style.opacity = "0.7";
				const tag = document.createElement("span");
				tag.textContent = deprecation ? `deprecated - ${deprecation}` : "deprecated";
				tag.style.cssText = "color: #cca700; font-style: italic; flex-shrink: 1; overflow: hidden; text-overflow: ellipsis";
				row.title = `Deprecated${deprecation ? ": " + deprecation : ""}`;
				row.appendChild(pathSpan);
				row.appendChild(tag);
			}
			else
			{
				row.appendChild(pathSpan);
			}
			row.addEventListener("mouseenter", () =>
			{
				selectedIndex = rowEls.indexOf(row);
				highlight();
			});
			row.addEventListener("mousedown", (e) =>
			{
				e.preventDefault();
				accept();
			});
			list.appendChild(row);
			rowEls.push(row);
		}
		highlight();
	}

	function accept(): void
	{
		const choice = entries[selectedIndex];
		if (choice)
		{
			const selection = editor.getSelection();
			if (selection)
			{
				editor.executeEdits("duet-om-search", [{
					range: selection,
					text: choice,
					forceMoveMarkers: true
				}]);
				editor.pushUndoStop();
			}
		}
		close();
	}

	function close(): void
	{
		if (activeWidget && activeWidget.editor === editor)
		{
			activeWidget.dispose();
		}
		editor.focus();
	}

	input.addEventListener("input", (e) =>
	{
		e.stopPropagation();
		render(input.value);
	});
	const stopKey = (e: Event) => e.stopPropagation();
	input.addEventListener("keypress", stopKey);
	input.addEventListener("keyup", stopKey);
	const pageStep = 8;
	input.addEventListener("keydown", (e: KeyboardEvent) =>
	{
		e.stopPropagation();
		if (e.key === "ArrowDown")
		{
			e.preventDefault();
			selectedIndex = Math.min(selectedIndex + 1, rowEls.length - 1);
			highlight();
		}
		else if (e.key === "ArrowUp")
		{
			e.preventDefault();
			selectedIndex = Math.max(selectedIndex - 1, 0);
			highlight();
		}
		else if (e.key === "PageDown")
		{
			e.preventDefault();
			selectedIndex = Math.min(selectedIndex + pageStep, rowEls.length - 1);
			highlight();
		}
		else if (e.key === "PageUp")
		{
			e.preventDefault();
			selectedIndex = Math.max(selectedIndex - pageStep, 0);
			highlight();
		}
		else if (e.key === "Home")
		{
			e.preventDefault();
			selectedIndex = 0;
			highlight();
		}
		else if (e.key === "End")
		{
			e.preventDefault();
			selectedIndex = Math.max(0, rowEls.length - 1);
			highlight();
		}
		else if (e.key === "Enter")
		{
			e.preventDefault();
			accept();
		}
		else if (e.key === "Escape")
		{
			e.preventDefault();
			close();
		}
	});

	root.style.position = "absolute";
	function positionNearCursor(): void
	{
		const cursorPos = editor.getPosition();
		if (!cursorPos)
		{
			return;
		}
		const coord = editor.getScrolledVisiblePosition(cursorPos);
		const layout = editor.getLayoutInfo();
		if (!coord)
		{
			return;
		}
		const widgetWidth = root.offsetWidth || 600;
		const widgetHeight = root.offsetHeight || 280;
		const lineHeight = editor.getOption(monacoInstance.editor.EditorOption.lineHeight);
		let top = coord.top + lineHeight;
		if (top + widgetHeight > layout.height)
		{
			top = Math.max(0, coord.top - widgetHeight);
		}
		let left = coord.left;
		if (left + widgetWidth > layout.width)
		{
			left = Math.max(0, layout.width - widgetWidth - 8);
		}
		root.style.top = `${top}px`;
		root.style.left = `${left}px`;
	}

	const widget: monaco.editor.IOverlayWidget = {
		getId: () => widgetId,
		getDomNode: () => root,
		getPosition: () => null
	};
	editor.addOverlayWidget(widget);
	positionNearCursor();
	requestAnimationFrame(positionNearCursor);

	const onDocKeyDown = (e: KeyboardEvent) =>
	{
		if (e.key === "Escape")
		{
			e.preventDefault();
			e.stopPropagation();
			close();
		}
	};
	const onDocMouseDown = (e: MouseEvent) =>
	{
		if (!root.contains(e.target as Node))
		{
			close();
		}
	};
	document.addEventListener("keydown", onDocKeyDown, true);
	document.addEventListener("mousedown", onDocMouseDown, true);

	render("");
	setTimeout(() => input.focus({ preventScroll: true }), 0);

	activeWidget = {
		editor,
		dispose: () =>
		{
			document.removeEventListener("keydown", onDocKeyDown, true);
			document.removeEventListener("mousedown", onDocMouseDown, true);
			editor.removeOverlayWidget(widget);
			activeWidget = null;
		}
	};
}

/**
 * Register the F4 search action on a freshly created editor instance.
 * Call this once per editor right after `monaco.editor.create(...)`.
 */
export function addGcodeSearchAction(monacoInstance: typeof monaco, editor: monaco.editor.IStandaloneCodeEditor): monaco.IDisposable
{
	return editor.addAction({
		id: "duet.searchGcode",
		label: "Search G/M-code or object-model path",
		keybindings: [monacoInstance.KeyCode.F4],
		run: () =>
		{
			// Hide the suggest widget and parameter-hints tooltip so our overlay doesn't visually compete with them
			editor.trigger("gcode-search", "hideSuggestWidget", null);
			editor.trigger("gcode-search", "closeParameterHints", null);

			// Switch to object-model search when the cursor is inside an expression context
			const model = editor.getModel();
			const position = editor.getPosition();
			if (model && position)
			{
				const lineContent = model.getLineContent(position.lineNumber);
				const beforeCursor = lineContent.substring(0, position.column - 1);
				if (isInsideExpression(beforeCursor))
				{
					showObjectModelSearch(monacoInstance, editor);
					return;
				}
			}
			showGcodeSearch(monacoInstance, editor);
		}
	});
}