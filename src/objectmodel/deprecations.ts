import deprecationsJson from "@duet3d/objectmodel/dist/deprecations.json";
import { normalisePath } from "./paths";

/**
 * Map of full object-model paths (with `[]` standing for any array index) to the deprecation message extracted
 * from the property's `@deprecated` JSDoc tag. Built by @duet3d/objectmodel's build script from its TS sources.
 */
const deprecations: Record<string, string> = deprecationsJson as Record<string, string>;

/**
 * Look up the deprecation message for a full object-model path (with literal numeric indices) or any of its
 * prefixes. Returns the deprecation message when the path itself or a containing path is deprecated (the
 * shallowest match wins so the user sees the root cause, e.g. `move.rotation.angle` reports `move.rotation`
 * as deprecated). Returns null when neither the path nor any prefix is deprecated.
 */
export function getPathDeprecation(path: string): string | null
{
	if (!path)
	{
		return null;
	}
	const key = normalisePath(path);
	// Walk prefixes from shallowest to deepest; first hit wins
	let cursor = 0;
	while (cursor < key.length)
	{
		// Advance to the next boundary (dot or closing bracket that ends a step)
		let next = key.indexOf(".", cursor);
		if (next < 0)
		{
			next = key.length;
		}
		const prefix = key.substring(0, next);
		if (Object.prototype.hasOwnProperty.call(deprecations, prefix))
		{
			return deprecations[prefix];
		}
		cursor = next + 1;
	}
	return null;
}

/**
 * Look up the deprecation message for `parentPath + "." + field`. `parentPath` is the dotted path of the parent
 * value from the root (e.g. `move.extruders[0]`), or empty for a top-level field. Returns null if not deprecated.
 */
export function getMemberDeprecation(parentPath: string, field: string): string | null
{
	const fullPath = parentPath ? `${parentPath}.${field}` : field;
	return getPathDeprecation(fullPath);
}