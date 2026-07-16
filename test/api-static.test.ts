import { describe, expect, it } from 'vitest';
import fs from 'node:fs';

function read(path: string): string {
  return fs.readFileSync(path, 'utf8');
}

describe('API production static guards', () => {
  it('enforces admin and ingress IP allowlists when configured', () => {
    const api = read('src/system/api-system.ts');
    expect(api).toContain('ADMIN_ALLOWED_CIDRS');
    expect(api).toContain('admin_ip_denied');
    expect(api).toContain('source.allowedCidrs');
    expect(api).toContain('ingress_ip_denied');
  });

  it('handles emergency spool failure explicitly and does not expose the spool path to providers', () => {
    const api = read('src/system/api-system.ts');
    expect(api).toContain('ingress_spool_failed');
    expect(api).toContain("res.status(503).json({ ok: false, error: 'durable storage unavailable' })");
    expect(api).toContain('res.status(202).json({ ok: true, spooled: true })');
    expect(api).not.toContain('res.status(202).json({ ok: true, spooled: true, file })');
  });
});
