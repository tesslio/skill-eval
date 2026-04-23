import { dirname, join } from 'node:path';
import { existsSync, statSync } from 'node:fs';

const MAX_WALK_UP = 5;

/**
 * Walk up from a file path to find the nearest directory containing tile.json.
 * Returns null if none found within MAX_WALK_UP levels.
 */
export function findTileDir(filePath: string): string | null {
  let dir = dirname(filePath);
  for (let i = 0; i < MAX_WALK_UP; i++) {
    if (existsSync(join(dir, 'tile.json'))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Given a list of changed file paths, find unique tile directories
 * that contain an evals/ subdirectory.
 */
export function findTileDirsWithEvals(filePaths: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const filePath of filePaths) {
    const tileDir = findTileDir(filePath);
    const evalsPath = tileDir ? join(tileDir, 'evals') : '';
    if (tileDir && !seen.has(tileDir) && existsSync(evalsPath) && statSync(evalsPath).isDirectory()) {
      seen.add(tileDir);
      result.push(tileDir);
    }
  }

  return result;
}

/**
 * Given a list of changed file paths, find unique tile directories
 * (regardless of whether they have an evals/ subdirectory).
 */
export function findTileDirs(filePaths: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const filePath of filePaths) {
    const tileDir = findTileDir(filePath);
    if (tileDir && !seen.has(tileDir)) {
      seen.add(tileDir);
      result.push(tileDir);
    }
  }

  return result;
}
