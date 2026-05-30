import * as core from '@actions/core';
import { dirname, join } from 'node:path';
import { existsSync, statSync } from 'node:fs';

const MAX_WALK_UP = 5;

function isPluginRoot(dir: string): boolean {
  return (
    existsSync(join(dir, '.tessl-plugin', 'plugin.json')) ||
    existsSync(join(dir, 'tile.json'))
  );
}

/**
 * Walk up from a file path to find the nearest plugin root directory.
 * A plugin root contains either `.tessl-plugin/plugin.json` (current) or
 * `tile.json` (legacy). Returns null if none found within MAX_WALK_UP levels.
 */
export function findPluginDir(filePath: string): string | null {
  let dir = dirname(filePath);
  for (let i = 0; i < MAX_WALK_UP; i++) {
    if (isPluginRoot(dir)) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  core.warning(
    `No plugin root found within ${MAX_WALK_UP} parent directories of ${filePath}. ` +
    `If your plugin is nested deeper, move SKILL.md closer to .tessl-plugin/plugin.json.`,
  );
  return null;
}

/**
 * Given a list of changed file paths, find unique plugin directories
 * that contain an evals/ subdirectory.
 */
export function findPluginDirsWithEvals(filePaths: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const filePath of filePaths) {
    const pluginDir = findPluginDir(filePath);
    const evalsPath = pluginDir ? join(pluginDir, 'evals') : '';
    if (pluginDir && !seen.has(pluginDir) && existsSync(evalsPath) && statSync(evalsPath).isDirectory()) {
      seen.add(pluginDir);
      result.push(pluginDir);
    }
  }

  return result;
}

/**
 * Given a list of changed file paths, find unique plugin directories
 * (regardless of whether they have an evals/ subdirectory).
 */
export function findPluginDirs(filePaths: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const filePath of filePaths) {
    const pluginDir = findPluginDir(filePath);
    if (pluginDir && !seen.has(pluginDir)) {
      seen.add(pluginDir);
      result.push(pluginDir);
    }
  }

  return result;
}
