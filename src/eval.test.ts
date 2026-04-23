import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ---------------------------------------------------------------------------
// 1. findTileDir / findTileDirsWithEvals
// ---------------------------------------------------------------------------

describe('findTileDir', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = join(tmpdir(), `eval-test-${Date.now()}`);
    mkdirSync(tmp, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test('finds tile.json in immediate parent', async () => {
    writeFileSync(join(tmp, 'tile.json'), '{}');
    mkdirSync(join(tmp, 'skills', 'foo'), { recursive: true });
    writeFileSync(join(tmp, 'skills', 'foo', 'SKILL.md'), '');

    const { findTileDir } = await import('./find-tiles.ts');
    expect(findTileDir(join(tmp, 'skills', 'foo', 'SKILL.md'))).toBe(tmp);
  });

  test('returns null when no tile.json exists', async () => {
    mkdirSync(join(tmp, 'skills', 'foo'), { recursive: true });
    writeFileSync(join(tmp, 'skills', 'foo', 'SKILL.md'), '');

    const { findTileDir } = await import('./find-tiles.ts');
    expect(findTileDir(join(tmp, 'skills', 'foo', 'SKILL.md'))).toBeNull();
  });
});

describe('findTileDirsWithEvals', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = join(tmpdir(), `eval-test-${Date.now()}`);
    mkdirSync(tmp, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test('returns tile dir when evals/ exists', async () => {
    writeFileSync(join(tmp, 'tile.json'), '{}');
    mkdirSync(join(tmp, 'evals', 'scenario-a'), { recursive: true });
    mkdirSync(join(tmp, 'skills', 'foo'), { recursive: true });
    writeFileSync(join(tmp, 'skills', 'foo', 'SKILL.md'), '');

    const { findTileDirsWithEvals } = await import('./find-tiles.ts');
    const dirs = findTileDirsWithEvals([join(tmp, 'skills', 'foo', 'SKILL.md')]);
    expect(dirs).toEqual([tmp]);
  });

  test('skips tile dir when no evals/ exists', async () => {
    writeFileSync(join(tmp, 'tile.json'), '{}');
    mkdirSync(join(tmp, 'skills', 'foo'), { recursive: true });
    writeFileSync(join(tmp, 'skills', 'foo', 'SKILL.md'), '');

    const { findTileDirsWithEvals } = await import('./find-tiles.ts');
    const dirs = findTileDirsWithEvals([join(tmp, 'skills', 'foo', 'SKILL.md')]);
    expect(dirs).toEqual([]);
  });

  test('deduplicates when multiple skills share a tile', async () => {
    writeFileSync(join(tmp, 'tile.json'), '{}');
    mkdirSync(join(tmp, 'evals', 'scenario-a'), { recursive: true });
    mkdirSync(join(tmp, 'skills', 'foo'), { recursive: true });
    mkdirSync(join(tmp, 'skills', 'bar'), { recursive: true });
    writeFileSync(join(tmp, 'skills', 'foo', 'SKILL.md'), '');
    writeFileSync(join(tmp, 'skills', 'bar', 'SKILL.md'), '');

    const { findTileDirsWithEvals } = await import('./find-tiles.ts');
    const dirs = findTileDirsWithEvals([
      join(tmp, 'skills', 'foo', 'SKILL.md'),
      join(tmp, 'skills', 'bar', 'SKILL.md'),
    ]);
    expect(dirs).toEqual([tmp]);
  });
});
