import type { IncomingHttpHeaders } from 'node:http';
import type { NextFunction, Request, RequestHandler, Response } from 'express';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function getHeader(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name.toLowerCase()];
  if (Array.isArray(value)) return value[0];
  return value;
}

export function parseJsonSafe(raw: Buffer): unknown | undefined {
  try {
    return JSON.parse(raw.toString('utf8'));
  } catch {
    return undefined;
  }
}

export function jsonString(value: unknown): string {
  return JSON.stringify(value ?? null);
}

export function asyncHandler(
  handler: (request: Request, response: Response, next: NextFunction) => Promise<unknown>
): RequestHandler {
  return (request, response, next) => {
    void handler(request, response, next).catch(next);
  };
}

export function requireUuidParam(name: string): RequestHandler {
  return (request, response, next) => {
    const value = request.params[name];
    if (typeof value !== 'string' || !uuidPattern.test(value)) {
      response.status(400).json({ error: `invalid ${name}` });
      return;
    }
    next();
  };
}
