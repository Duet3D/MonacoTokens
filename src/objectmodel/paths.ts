/** Normalise a runtime object-model path (with literal numeric indices) to the lookup form used by
 * the deprecations / enums maps, where `[]` stands in for any array index. */
export function normalisePath(path: string): string
{
	return path.replace(/\[\d+\]/g, "[]");
}
