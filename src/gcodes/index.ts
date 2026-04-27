import gcodeDataJson from "./gcodes.json";

/**
 * One enumerated value of a parameter (e.g. "1" for G1 H meaning "Stop on endstop")
 */
export interface GcodeParameterValue {
	/** Literal value as it appears in source (e.g. "0", "1", "-1") */
	value: string;
	/** Human-readable meaning */
	description: string;
}

/**
 * Description of one parameter letter that a G/M/T-code accepts
 */
export interface GcodeParameter {
	/** Single uppercase parameter letter (e.g. "X", "S") */
	letter: string;
	/** Human-readable description shown in tooltips and completion items */
	description: string;
	/** Optional enumeration of valid values, rendered as a table in tooltips */
	values?: GcodeParameterValue[];
	/** If set, this parameter is deprecated; the string is shown as the reason (e.g. "Use M18 S<timeout> instead") */
	deprecated?: string;
}

/**
 * Description of a value that follows the code letter directly without a parameter letter (e.g. the tool
 * number after T, the message after M117). Named after DSF's `UnprecedentedParameter` concept: the value
 * has no parameter letter preceding it. Accepts literals, quoted strings, or `{...}` expressions.
 */
export interface GcodeUnprecedentedParameter {
	/** Label shown in the signature, e.g. "<n>" */
	label: string;
	/** Description shown in the tooltip when this position is active */
	description: string;
}

/**
 * Description of one G/M/T-code (RRF dialect)
 */
export interface GcodeInfo {
	/** Code identifier as it appears in source, e.g. "G1", "M104", "M203" */
	code: string;
	/** One-line summary shown in the completion dropdown and in hover headers */
	summary: string;
	/** Optional longer prose description shown above the parameter list in the signature-help doc panel */
	description?: string;
	/** Optional value that follows the code letter directly (e.g. the tool number for T, the message for M117) */
	unprecedentedParameter?: GcodeUnprecedentedParameter;
	/** Parameter letters this code understands */
	parameters: GcodeParameter[];
	/** If set, this code is deprecated; the string is shown as the reason */
	deprecated?: string;
}

/**
 * Curated dataset of G/M/T-codes used to drive Monaco completion and hover providers.
 * Sourced from gcode-data.json so it can be regenerated automatically from an upstream reference (docs.duet3d.com or DuetScreen) without touching TypeScript.
 */
export const gcodeData: GcodeInfo[] = gcodeDataJson as GcodeInfo[];

/**
 * Look up an entry by code. Accepts mixed-case ("g1", "M104", ...) by upper-casing the leading letter
 * before matching against the canonical "G1" / "M104" / "T" form stored in gcodeData.
 */
export function findGcode(code: string): GcodeInfo | undefined
{
	if (!code) {
		return undefined;
	}
	const canonical = code[0].toUpperCase() + code.substring(1);
	return gcodeData.find(g => g.code === canonical);
}