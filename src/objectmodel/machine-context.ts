import type { ObjectModel } from "@duet3d/objectmodel";

/**
 * Runtime context describing the currently connected machine. Completion and hover providers read this to surface
 * machine-specific information (visible axes, configured extruders, object-model fields) alongside the static
 * gcode/expression datasets bundled with this package.
 *
 * Framework-agnostic: Vue, React, or any other consumer just calls `setMachineContext` when its model reference
 * becomes available or changes. The reference is expected to stay stable - providers read field values through
 * the reference at completion time so state mutations inside the object model are picked up automatically.
 */
export interface MachineContext {
	/** Live machine object-model reference. */
	readonly model: ObjectModel;

	/**
	 * Optional callback that returns a Markdown/HTML description for an object-model path (with `[]` placeholders
	 * for collection items, e.g. `move.extruders[].pressureAdvance`). Used by the hover provider to surface the
	 * DuetAPI.xml documentation. Return `null` when no description is available. May be async - the hover provider
	 * awaits the result so callbacks can lazily fetch the docs on first hover without losing the popup.
	 */
	readonly getObjectModelDescription?: (path: string) => string | null | Promise<string | null>;
}

let current: MachineContext | null = null;
const listeners = new Set<() => void>();

/**
 * Set (or clear) the runtime machine context. Pass `null` when the machine is disconnected.
 */
export function setMachineContext(context: MachineContext | null): void
{
	current = context;
	for (const listener of listeners)
	{
		try
		{
			listener();
		}
		catch (e)
		{
			// Listener threw - don't let it break other listeners
			console.error("[monacotokens] machine-context listener threw:", e);
		}
	}
}

/**
 * Get the currently installed machine context, or null when no machine is connected.
 */
export function getMachineContext(): MachineContext | null
{
	return current;
}

/**
 * Subscribe to machine-context changes. Returns an unsubscribe function.
 */
export function onMachineContextChange(listener: () => void): () => void
{
	listeners.add(listener);
	return () => listeners.delete(listener);
}