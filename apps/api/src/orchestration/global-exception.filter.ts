import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';

/**
 * GlobalExceptionFilter
 *
 * Catches ALL unhandled exceptions across the application.
 * - HTTP requests: returns a structured error JSON.
 * - Non-HTTP contexts (events, schedulers): logs and swallows — never crashes.
 *
 * This ensures the autonomous agent keeps running even if one fixture's data
 * is malformed, a single on-chain call fails, or MongoDB has a transient hiccup.
 */
@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('GlobalExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctxType = host.getType();

    if (ctxType === 'http') {
      const ctx = host.switchToHttp();
      const response = ctx.getResponse<Response>();
      const request = ctx.getRequest<Request>();

      const status =
        exception instanceof HttpException ? exception.getStatus() : 500;
      const message =
        exception instanceof HttpException
          ? exception.message
          : 'Internal server error';

      this.logger.error(
        `[HTTP ${request.method} ${request.url}] ${status}: ${String(exception)}`,
      );

      response.status(status).json({
        statusCode: status,
        message,
        path: request.url,
        timestamp: new Date().toISOString(),
      });
    } else {
      // Non-HTTP context (event handlers, schedulers, lifecycle hooks)
      // Log the error but do NOT rethrow — the agent must stay alive.
      this.logger.error(
        `[${ctxType}] Unhandled exception caught (swallowed to keep agent alive): ${String(exception)}`,
      );
      if (exception instanceof Error && exception.stack) {
        this.logger.error(exception.stack);
      }
    }
  }
}
