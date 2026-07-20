import { describe, expect, it, vi } from 'vitest';
import type { NextFunction, Request, Response } from 'express';
import { asyncHandler, requireUuidParam } from '../src/part/http.js';

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe('asyncHandler', () => {
  it('forwards rejected route promises to Express error middleware', async () => {
    const error = new Error('async route failure');
    const next = vi.fn() as unknown as NextFunction;
    const handler = asyncHandler(async () => {
      throw error;
    });

    handler({} as Request, {} as Response, next);
    await nextTurn();

    expect(next).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledWith(error);
  });

  it('does not call next when the async route resolves normally', async () => {
    const next = vi.fn() as unknown as NextFunction;
    const handler = asyncHandler(async () => undefined);

    handler({} as Request, {} as Response, next);
    await nextTurn();

    expect(next).not.toHaveBeenCalled();
  });
});

describe('requireUuidParam', () => {
  it('rejects malformed UUID parameters before a database query', () => {
    const json = vi.fn();
    const status = vi.fn(() => ({ json }));
    const next = vi.fn() as unknown as NextFunction;
    const handler = requireUuidParam('id');

    handler(
      { params: { id: 'not-a-uuid' } } as unknown as Request,
      { status } as unknown as Response,
      next
    );

    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith({ error: 'invalid id' });
    expect(next).not.toHaveBeenCalled();
  });

  it('accepts a canonical UUID', () => {
    const next = vi.fn() as unknown as NextFunction;
    const handler = requireUuidParam('id');

    handler(
      { params: { id: '2f00a0a5-1db7-4d7b-8dce-8c26b680f237' } } as unknown as Request,
      {} as Response,
      next
    );

    expect(next).toHaveBeenCalledTimes(1);
  });
});
