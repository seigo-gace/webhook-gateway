import { describe, expect, it } from 'vitest';
import fs from 'node:fs';

function read(path: string): string {
  return fs.readFileSync(path, 'utf8');
}

describe('deployment hardening static guards', () => {
  it('runs containers as the non-root app user with dropped capabilities', () => {
    const dockerfile = read('Dockerfile');
    const compose = read('docker-compose.yml');
    expect(dockerfile).toContain('USER appuser');
    expect(compose).toContain('user: "10001:10001"');
    expect(compose).toContain('no-new-privileges:true');
    expect(compose).toContain('cap_drop:');
    expect(compose).toContain('- ALL');
  });

  it('does not block API startup on Redis health because Redis is only the delivery transport', () => {
    const compose = read('docker-compose.yml');
    const apiBlock = compose.slice(compose.indexOf('  api:'), compose.indexOf('  worker:'));
    expect(apiBlock).toContain('postgres:');
    expect(apiBlock).not.toContain('redis:');
  });

  it('binds the API port to localhost by default', () => {
    const compose = read('docker-compose.yml');
    expect(compose).toContain('127.0.0.1:7373:7373');
  });
});
