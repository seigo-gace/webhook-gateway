import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return entry.isFile() && full.endsWith('.ts') ? [full] : [];
  });
}

function read(file: string): string {
  return fs.readFileSync(file, 'utf8');
}

describe('five-stage modular layering guards', () => {
  it('keeps Part independent from higher layers', () => {
    for (const file of walk('src/part')) {
      const content = read(file);
      expect(content, file).not.toMatch(/from ['"]\.\.\/feature\//);
      expect(content, file).not.toMatch(/from ['"]\.\.\/component\//);
      expect(content, file).not.toMatch(/from ['"]\.\.\/system\//);
      expect(content, file).not.toMatch(/from ['"]\.\.\/application\//);
    }
  });

  it('keeps Feature from importing Component, System, or Application', () => {
    for (const file of walk('src/feature')) {
      const content = read(file);
      expect(content, file).not.toMatch(/from ['"]\.\.\/component\//);
      expect(content, file).not.toMatch(/from ['"]\.\.\/system\//);
      expect(content, file).not.toMatch(/from ['"]\.\.\/application\//);
    }
  });

  it('keeps Component from importing System or Application', () => {
    for (const file of walk('src/component')) {
      const content = read(file);
      expect(content, file).not.toMatch(/from ['"]\.\.\/system\//);
      expect(content, file).not.toMatch(/from ['"]\.\.\/application\//);
    }
  });

  it('keeps root and application entrypoints thin', () => {
    for (const file of ['src/server.ts', 'src/worker.ts', 'src/application/api.ts', 'src/application/worker.ts']) {
      const lines = read(file).split('\n').filter((line) => line.trim().length > 0);
      expect(lines.length, file).toBeLessThanOrEqual(4);
    }
  });
});
