/**
 * Supported axis letters, mirroring `Axis.Letters` in DuetAPI (DuetSoftwareFramework). This is the canonical set
 * of identifiers RepRapFirmware accepts for an axis. Kept in sync by hand - update it if DuetAPI gains new letters.
 */
export const ALL_AXIS_LETTERS: readonly string[] = [
	"X", "Y", "Z",
	"U", "V", "W",
	"A", "B", "C", "D",
	"a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l", "m",
	"n", "o", "p", "q", "r", "s", "t", "u", "v", "w", "x", "y", "z"
];

/**
 * Axis letters offered by completion when the live machine configuration is unavailable (no machine connected) or
 * when an axis parameter is non-dynamic (axis-defining codes such as M584 that may reference axes which do not
 * exist yet). Restricted to the three axes every standard machine has; additional axes (U, V, W, ...) are surfaced
 * dynamically from the connected machine's object model, and any axis can still be typed manually.
 */
export const DEFAULT_AXIS_LETTERS: readonly string[] = ["X", "Y", "Z"];
