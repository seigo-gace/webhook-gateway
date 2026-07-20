import { describe, expect, it, vi } from 'vitest';
import type { NextFunction, Request, Response } from 'express';
import { asyncHandler } from '../src/part/http.js';

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
