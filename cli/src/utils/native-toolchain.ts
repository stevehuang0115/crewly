/**
 * Native-module build toolchain preflight.
 *
 * `node-pty` (and `better-sqlite3` on platforms without a prebuild) compile
 * through node-gyp, which needs a C++ compiler, `make` and `python3`. When one
 * is missing the operator sees forty lines of gyp output ending in
 * `make: g++: No such file or directory` (server-install finding 11). This
 * module answers three questions with no dependencies beyond node builtins
 * — it runs from `preinstall`, before any dependency exists:
 *
 *   1. Is node-pty already built (or prebuilt) for this platform?
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

/** Relative path of node-pty's prebuilds directory (absent in node-pty 1.x). */
const NODE_PTY_PREBUILDS = path.join('node_modules', 'node-pty', 'prebuilds');

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
	/** `build/Release/pty.node` exists (compiled or copied from a prebuild). */
	built: boolean;
	/** A `prebuilds/<platform>-<arch>` directory exists for this platform. */
	prebuilt: boolean;
}

/**
 * Inspect node-pty's install state under a package root.
 *
 * @param packageRoot - Directory containing `node_modules/`
 * @param platform - Platform tag (defaults to the current one)
 * @param arch - Arch tag (defaults to the current one)
 * @returns Build/prebuild status
 */
export function nodePtyBuildStatus(
	packageRoot: string,
	platform: string = process.platform,
	arch: string = process.arch,
): NodePtyBuildStatus {
	return {
		built: fs.existsSync(path.join(packageRoot, NODE_PTY_BINDING)),
		prebuilt: fs.existsSync(path.join(packageRoot, NODE_PTY_PREBUILDS, `${platform}-${arch}`)),
	};
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
 * @param options.force - Report missing tools even when node-pty is already built (doctor mode)
 * @returns The check result
 */
export function checkNativeToolchain(options: {
	packageRoot: string;
	which?: (bin: string) => boolean;
	platform?: string;
	arch?: string;
	force?: boolean;
}): ToolchainCheckResult {
	const which = options.which ?? isOnPath;
	const nodePty = nodePtyBuildStatus(options.packageRoot, options.platform, options.arch);
	const missing = detectMissingBuildTools(which);
	const installHint = toolchainInstallHint(which);
	const needsBuild = !nodePty.built && !nodePty.prebuilt;

	if (missing.length === 0 || (!needsBuild && !options.force)) {
		return { ok: true, missing, installHint, nodePty, message: '' };
	}

	const message = formatToolchainMessage(missing, installHint, needsBuild);
	return { ok: false, missing, installHint, nodePty, message };
}

/**
 * Render the single warning line block.
 *
 * @param missing - Missing tool labels
 * @param installHint - Install command
 * @param needsBuild - Whether node-pty still has to be compiled
 * @returns Multi-line message
 */
export function formatToolchainMessage(missing: string[], installHint: string, needsBuild: boolean): string {
	const tools = missing.join(', ');
	const consequence = needsBuild
		? 'node-pty has no prebuilt binary for this platform and must be compiled, so `npm install` will fail in node-gyp.'
		: 'node-pty is currently built, but the next `npm rebuild` / upgrade will fail in node-gyp.';
	return [
		`[crewly] Missing native build tool${missing.length > 1 ? 's' : ''}: ${tools}.`,
		`[crewly] ${consequence}`,
		`[crewly] Install them, then re-run the install:`,
		`[crewly]   ${installHint}`,
	].join('\n');
}
