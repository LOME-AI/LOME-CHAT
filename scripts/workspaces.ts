/**
 * Workspace discovery for monorepo scripts.
 * Reads pnpm-workspace.yaml and discovers all packages dynamically.
 * No hardcoded paths - auto-discovers as new packages are added.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

export interface Workspace {
  /** Short name derived from package name (e.g., "web", "api", "ui") */
  name: string;
  /** Relative path from root (e.g., "apps/web", "packages/ui") */
  path: string;
  /** Full package name from package.json (e.g., "@hushbox/web") */
  fullName: string;
}

function extractPattern(line: string): string | undefined {
  const match = /^-\s*['"]?([^'"]+?)['"]?\s*$/.exec(line);
  return match?.[1];
}

function isEndOfPackagesSection(line: string): boolean {
  return Boolean(line) && !line.startsWith('-') && !line.startsWith('#');
}

/**
 * Parse pnpm-workspace.yaml and return the package patterns.
 */
export function parseWorkspaceYaml(rootDirectory: string): string[] {
  const yamlPath = path.join(rootDirectory, 'pnpm-workspace.yaml');
  if (!existsSync(yamlPath)) return [];

  const content = readFileSync(yamlPath, 'utf8');
  const lines = content.split('\n').map((l) => l.trim());
  const packagesIndex = lines.indexOf('packages:');
  if (packagesIndex === -1) return [];

  const patterns: string[] = [];
  for (let index = packagesIndex + 1; index < lines.length; index++) {
    const line = lines[index];
    /* v8 ignore next -- index < lines.length, so the element is always present */
    if (line === undefined) continue;
    if (isEndOfPackagesSection(line)) break;

    const pattern = extractPattern(line);
    if (pattern) patterns.push(pattern);
  }

  return patterns;
}

function expandGlob(pattern: string, rootDirectory: string): string[] {
  const parts = pattern.split('*');
  /* v8 ignore next -- split always yields at least one element, so index 0 is always present */
  const baseDirectory = parts[0]?.replace(/\/$/, '') ?? '';
  const basePath = path.join(rootDirectory, baseDirectory);

  if (!existsSync(basePath)) return [];

  return readdirSync(basePath)
    .filter((entry) => statSync(path.join(basePath, entry)).isDirectory())
    .map((entry) => (baseDirectory ? `${baseDirectory}/${entry}` : entry));
}

function checkDirectPath(pattern: string, rootDirectory: string): string[] {
  const directPath = path.join(rootDirectory, pattern);
  const isValidDir = existsSync(directPath) && statSync(directPath).isDirectory();
  return isValidDir ? [pattern] : [];
}

/**
 * Expand a glob pattern to actual directory paths.
 * Supports simple patterns like "apps/*" or "packages/*".
 * Non-glob patterns are returned as-is if the directory exists.
 */
export function expandGlobPattern(pattern: string, rootDirectory: string): string[] {
  return pattern.includes('*')
    ? expandGlob(pattern, rootDirectory)
    : checkDirectPath(pattern, rootDirectory);
}

/**
 * Extract short name from package name or path.
 * "@hushbox/web" -> "web"
 * "myapp" -> "myapp"
 */
function extractShortName(packageName: string, directoryPath: string): string {
  if (packageName.includes('/')) {
    const afterSlash = packageName.split('/').pop();
    if (afterSlash) {
      return afterSlash;
    }
  }

  return path.basename(directoryPath);
}

/**
 * Read package.json from a directory and return package name.
 */
function readPackageName(directoryPath: string): string | undefined {
  const packageJsonPath = path.join(directoryPath, 'package.json');

  if (!existsSync(packageJsonPath)) {
    return undefined;
  }

  const content = readFileSync(packageJsonPath, 'utf8');
  const packageJson = JSON.parse(content) as { name?: string };

  return packageJson.name;
}

/**
 * Discover all workspaces by reading pnpm-workspace.yaml and expanding globs.
 */
export function discoverWorkspaces(rootDirectory?: string): Workspace[] {
  const root = rootDirectory ?? process.cwd();
  const patterns = parseWorkspaceYaml(root);
  const workspaces: Workspace[] = [];

  for (const pattern of patterns) {
    const paths = expandGlobPattern(pattern, root);

    for (const relativePath of paths) {
      const absolutePath = path.join(root, relativePath);
      const packageName = readPackageName(absolutePath);

      if (packageName) {
        workspaces.push({
          name: extractShortName(packageName, relativePath),
          path: relativePath,
          fullName: packageName,
        });
      }
    }
  }

  return workspaces;
}

/**
 * Get workspace by short name.
 * Returns undefined if not found.
 */
export function getWorkspaceByName(name: string, rootDirectory?: string): Workspace | undefined {
  const workspaces = discoverWorkspaces(rootDirectory);
  return workspaces.find((workspace) => workspace.name === name);
}

/**
 * Get all workspace paths.
 */
export function getWorkspacePaths(rootDirectory?: string): string[] {
  const workspaces = discoverWorkspaces(rootDirectory);
  return workspaces.map((workspace) => workspace.path);
}
