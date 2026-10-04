/**
 * Run a body parser for every request except a few paths.
 *
 * The app-wide JSON / urlencoded parsers run before authentication. A path
 * that takes a large body (Crewly Apps publish) is skipped here and parsed
 * by its own router only after the caller is authenticated, so an
 * unauthenticated client cannot make the server buffer and parse it.
 *
 * @module middleware/body-parser-except
 */

import type { NextFunction, Request, RequestHandler, Response } from 'express';

/**
 * Wrap a parser so it skips the given exact paths.
 *
 * @param paths - Exact request paths (no query) to skip, e.g. `/api/apps/publish`
 * @param parser - The body parser
 * @returns Middleware
 *
 * @example
 * ```ts
 * app.use(bodyParserExcept(['/api/apps/publish'], express.json({ limit: '10mb' })));
 * ```
 */
export function bodyParserExcept(paths: readonly string[], parser: RequestHandler): RequestHandler {
  const skip = new Set(paths.map((p) => p.replace(/\/+$/, '')));
  return (req: Request, res: Response, next: NextFunction): void => {
    if (skip.has(req.path.replace(/\/+$/, ''))) {
      next();
      return;
    }
    parser(req, res, next);
  };
}
