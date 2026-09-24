/**
 * Native-module build toolchain preflight.
 *
 * `node-pty` ships prebuilt binaries for macOS (x64/arm64) and glibc Linux
 * (x64/arm64, glibc >= 2.28), so on those platforms no compiler is needed
 * (#778). Elsewhere — Alpine/musl, older glibc, 32-bit ARM — it (and
 * `better-sqlite3` without a prebuild) compiles through node-gyp, which needs
 * a C++ compiler, `make` and `python3`. When one
 * is missing the operator sees forty lines of gyp output ending in
 * `make: g++: No such file or directory` (server-install finding 11). This
 * module answers three questions with no dependencies beyond node builtins
 * — it runs from `preinstall`, before any dependency exists:
 *
 *   1. Is node-pty already built (or has a usable prebuild) for this platform?
 *   2. Which build tools are missing?
 *   3. What is the one-line package-manager command that installs them?
 *
 * @module cli/utils/native-toolchain
 */

import * as fs from 'fs';
import * as path from 'path';

/** A build tool requirement; any of the `candidates` on PATH satisfies it. */
export interface BuildToolRequirement {
	/** Human label used in messages (e.g. "g++"). */
	label: string;
	/** Executable names that satisfy the requirement, checked in order. */
	candidates: string[];
}

/** Tools node-gyp needs to compile node-pty from source. */
export const NATIVE_BUILD_TOOLS: readonly BuildToolRequirement[] = [
	{ label: 'g++', candidates: ['g++', 'c++', 'clang++'] },
	{ label: 'make', candidates: ['make', 'gmake'] },
	{ label: 'python3', candidates: ['python3', 'python'] },
];

/** Package managers and the command that installs the full toolchain. */
export const TOOLCHAIN_INSTALL_COMMANDS: ReadonlyArray<{ manager: string; command: string }> = [
	{ manager: 'apt-get', command: 'sudo apt-get update && sudo apt-get install -y build-essential python3' },
	{ manager: 'dnf', command: 'sudo dnf install -y gcc-c++ make python3' },
	{ manager: 'yum', command: 'sudo yum install -y gcc-c++ make python3' },
	{ manager: 'apk', command: 'sudo apk add --no-cache build-base python3' },
	{ manager: 'zypper', command: 'sudo zypper install -y gcc-c++ make python3' },
	{ manager: 'pacman', command: 'sudo pacman -S --needed base-devel python' },
	{ manager: 'brew', command: 'xcode-select --install   # or: brew install make python' },
];

/** Fallback hint when no known package manager is on PATH. */
const GENERIC_INSTALL_HINT = 'install a C++ compiler (g++ or clang++), make and python3 with your package manager';

/** Relative path of node-pty's compiled binding inside a package root. */
const NODE_PTY_BINDING = path.join('node_modules', 'node-pty', 'build', 'Release', 'pty.node');

/** Relative path of node-pty's prebuilds directory (`prebuilds/<platform>-<arch>/`). */
const NODE_PTY_PREBUILDS = path.join('node_modules', 'node-pty', 'prebuilds');

/**
 * Oldest glibc node-pty's Linux prebuilds run on. node-pty 1.2.0-beta.15's
 * `prebuilds/linux-{x64,arm64}/pty.node` reference `GLIBC_2.28` symbols
 * (Debian 10+, Ubuntu 18.10+, RHEL 8+).
 */
export const NODE_PTY_PREBUILD_MIN_GLIBC = '2.28';

/**
 * `<platform>-<arch>` targets node-pty's npm tarball ships prebuilds for.
 * Used at `preinstall`, before node-pty is on disk to look at.
 */
export const NODE_PTY_PREBUILT_TARGETS: readonly string[] = [
	'darwin-arm64',
	'darwin-x64',
	'linux-arm64',
	'linux-x64',
	'win32-arm64',
	'win32-x64',
];

/** C library of a Linux host; null when not Linux or unknown. */
export type LinuxLibc = { family: 'glibc'; version: string } | { family: 'musl' } | null;

/**
 * Detect the running Linux host's C library from Node's diagnostic report
 * (`header.glibcVersionRuntime` is only set on glibc).
 *
 * @param platform - Platform tag (defaults to the current one)
 * @returns glibc + version, musl, or null off Linux / when the report is unavailable
 */
export function detectLinuxLibc(platform: string = process.platform): LinuxLibc {
	if (platform !== 'linux' || process.platform !== 'linux') return null;
	try {
		const report = process.report as (NodeJS.ProcessReport & { excludeNetwork?: boolean }) | undefined;
		if (!report) return null;
		const previous = report.excludeNetwork;
		report.excludeNetwork = true;
		const header = (report.getReport() as { header?: { glibcVersionRuntime?: string } }).header;
		report.excludeNetwork = previous;
		return header?.glibcVersionRuntime
			? { family: 'glibc', version: header.glibcVersionRuntime }
			: { family: 'musl' };
	} catch {
		return null;
	}
}

/**
 * Compare dotted numeric versions.
 *
 * @returns negative, 0 or positive like `Array#sort` comparators
 */
function compareDotted(a: string, b: string): number {
	const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
	const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
		if (diff !== 0) return diff;
	}
	return 0;
}

/**
 * Why node-pty's prebuild cannot run on this libc, if it cannot.
 *
 * @param platform - Platform tag
 * @param libc - Detected libc (null = unknown, assumed compatible)
 * @returns A short reason, or null when the prebuild is usable
 */
export function prebuildLibcProblem(platform: string, libc: LinuxLibc): string | null {
	if (platform !== 'linux' || libc === null) return null;
	if (libc.family === 'musl') return 'musl libc (e.g. Alpine) — the prebuilds target glibc';
	if (compareDotted(libc.version, NODE_PTY_PREBUILD_MIN_GLIBC) < 0) {
		return `glibc ${libc.version} is older than the ${NODE_PTY_PREBUILD_MIN_GLIBC} the prebuilds need`;
	}
	return null;
}

/**
 * Check whether an executable is on PATH without spawning a shell.
 *
 * @param bin - Executable name
 * @param env - Environment to read PATH/PATHEXT from
 * @returns true when an executable file with that name exists on PATH
 */
export function isOnPath(bin: string, env: NodeJS.ProcessEnv = process.env): boolean {
	const dirs = (env.PATH ?? '').split(path.delimiter).filter(Boolean);
	const exts = process.platform === 'win32' ? (env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : [''];
	for (const dir of dirs) {
		for (const ext of exts) {
			const candidate = path.join(dir, bin + ext);
			try {
				fs.accessSync(candidate, fs.constants.X_OK);
				if (fs.statSync(candidate).isFile()) return true;
			} catch {
				// not here — keep looking
			}
		}
	}
	return false;
}

/**
 * Determine which build tools are missing.
 *
 * @param which - PATH lookup (injectable for tests)
 * @returns Labels of the missing requirements, in {@link NATIVE_BUILD_TOOLS} order
 */
export function detectMissingBuildTools(which: (bin: string) => boolean = isOnPath): string[] {
	// Call with a single argument: Array#some would otherwise pass (value, index,
	// array) and the index would land in isOnPath's `env` parameter.
	return NATIVE_BUILD_TOOLS.filter((req) => !req.candidates.some((bin) => which(bin))).map((req) => req.label);
}

/**
 * Pick the install command for the first known package manager on PATH.
 *
 * @param which - PATH lookup (injectable for tests)
 * @returns The install command, or a generic hint when none is recognised
 */
export function toolchainInstallHint(which: (bin: string) => boolean = isOnPath): string {
	const match = TOOLCHAIN_INSTALL_COMMANDS.find((entry) => which(entry.manager));
	return match ? match.command : GENERIC_INSTALL_HINT;
}

/** Whether node-pty is usable without compiling. */
export interface NodePtyBuildStatus {
	/** `build/Release/pty.node` exists (compiled from source). */
	built: boolean;
	/** A `prebuilds/<platform>-<arch>` directory exists AND its binary can run on this libc. */
	prebuilt: boolean;
	/** Set when a prebuild directory exists but cannot run here (musl, old glibc). */
	prebuildProblem?: string;
}

/**
 * Inspect node-pty's install state under a package root. Before node-pty is
 * installed (the `preinstall` preflight) the prebuild answer comes from
 * {@link NODE_PTY_PREBUILT_TARGETS} instead of the filesystem.
 *
 * @param packageRoot - Directory containing `node_modules/`
 * @param platform - Platform tag (defaults to the current one)
 * @param arch - Arch tag (defaults to the current one)
 * @param libc - Host libc (defaults to detection; null = unknown, assumed compatible)
 * @returns Build/prebuild status
 */
export function nodePtyBuildStatus(
	packageRoot: string,
	platform: string = process.platform,
	arch: string = process.arch,
	libc: LinuxLibc = detectLinuxLibc(platform),
): NodePtyBuildStatus {
	const built = fs.existsSync(path.join(packageRoot, NODE_PTY_BINDING));
	const installed = fs.existsSync(path.join(packageRoot, 'node_modules', 'node-pty'));
	const hasPrebuildDir = installed
		? fs.existsSync(path.join(packageRoot, NODE_PTY_PREBUILDS, `${platform}-${arch}`))
		: NODE_PTY_PREBUILT_TARGETS.includes(`${platform}-${arch}`);
	const problem = hasPrebuildDir ? prebuildLibcProblem(platform, libc) : null;
	return problem
		? { built, prebuilt: false, prebuildProblem: problem }
		: { built, prebuilt: hasPrebuildDir };
}

/** Outcome of the preflight. */
export interface ToolchainCheckResult {
	/** True when nothing needs to be reported. */
	ok: boolean;
	/** Missing tool labels (empty when the toolchain is complete). */
	missing: string[];
	/** Package-manager command that installs the missing tools. */
	installHint: string;
	/** node-pty state at check time. */
	nodePty: NodePtyBuildStatus;
	/** Single, human-readable message (empty when ok). */
	message: string;
}

/**
 * Run the preflight: when node-pty has to be compiled and the toolchain is
 * incomplete, produce ONE message naming the missing tools and the exact
 * install command.
 *
 * @param options - Injection points
 * @param options.packageRoot - Directory containing `node_modules/` (used to detect an existing build)
 * @param options.which - PATH lookup
 * @param options.platform - Platform tag for prebuild detection
 * @param options.arch - Arch tag for prebuild detection
 * @param options.libc - Host libc for prebuild detection (defaults to detection)
 * @param options.force - Report missing tools even when node-pty is already built (doctor mode)
 * @returns The check result
 */
export function checkNativeToolchain(options: {
	packageRoot: string;
	which?: (bin: string) => boolean;
	platform?: string;
	arch?: string;
	libc?: LinuxLibc;
	force?: boolean;
}): ToolchainCheckResult {
	const which = options.which ?? isOnPath;
	const nodePty = nodePtyBuildStatus(
		options.packageRoot,
		options.platform,
		options.arch,
		options.libc === undefined ? detectLinuxLibc(options.platform) : options.libc,
	);
	const missing = detectMissingBuildTools(which);
	const installHint = toolchainInstallHint(which);
	const needsBuild = !nodePty.built && !nodePty.prebuilt;

	if (missing.length === 0 || (!needsBuild && !options.force)) {
		return { ok: true, missing, installHint, nodePty, message: '' };
	}

	const message = formatToolchainMessage(missing, installHint, needsBuild, nodePty.prebuildProblem);
	return { ok: false, missing, installHint, nodePty, message };
}

/**
 * Render the single warning line block.
 *
 * @param missing - Missing tool labels
 * @param installHint - Install command
 * @param needsBuild - Whether node-pty still has to be compiled
 * @param prebuildProblem - Why the shipped prebuild cannot be used here, if that is the reason
 * @returns Multi-line message
 */
export function formatToolchainMessage(
	missing: string[],
	installHint: string,
	needsBuild: boolean,
	prebuildProblem?: string,
): string {
	const tools = missing.join(', ');
	const noPrebuild = prebuildProblem
		? `node-pty's prebuilt binary cannot run here (${prebuildProblem})`
		: 'node-pty has no prebuilt binary for this platform';
	const consequence = needsBuild
		? `${noPrebuild} and must be compiled, so \`npm install\` will fail in node-gyp.`
		: 'node-pty is currently built from source, but the next `npm rebuild` / upgrade will fail in node-gyp.';
	return [
		`[crewly] Missing native build tool${missing.length > 1 ? 's' : ''}: ${tools}.`,
		`[crewly] ${consequence}`,
		`[crewly] Install them, then re-run the install:`,
		`[crewly]   ${installHint}`,
	].join('\n');
}
