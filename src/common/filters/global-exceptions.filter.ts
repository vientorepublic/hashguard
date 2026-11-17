import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';

@Catch()
export class GlobalExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let message = 'Internal server error';
    let code = 'INTERNAL_ERROR';
    let retryAfter: number | undefined;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const res = exception.getResponse();
      if (typeof res === 'string') {
        message = res;
      } else if (typeof res === 'object' && res !== null) {
        const resObj = res as Record<string, unknown>;
        message = (resObj.message as string) ?? message;
        code =
          (resObj.code as string) ??
          exception.constructor.name.replace('Exception', '').toUpperCase();
        if (
          typeof resObj.retryAfter === 'number' &&
          Number.isFinite(resObj.retryAfter)
        ) {
          retryAfter = resObj.retryAfter;
        }
      }
    } else if (
      exception instanceof Error &&
      'type' in exception &&
      (exception.type === 'entity.too.large' ||
        exception.type === 'entity.parse.failed')
    ) {
      status =
        exception.type === 'entity.too.large'
          ? HttpStatus.PAYLOAD_TOO_LARGE
          : HttpStatus.BAD_REQUEST;
      code =
        exception.type === 'entity.too.large'
          ? 'PAYLOAD_TOO_LARGE'
          : 'INVALID_JSON';
      message =
        exception.type === 'entity.too.large'
          ? 'Request body exceeds the size limit'
          : 'Invalid JSON body';
    } else if (exception instanceof Error) {
      this.logger.error(
        `Unhandled error: ${exception.message}`,
        exception.stack,
      );
    }

    if (status === HttpStatus.TOO_MANY_REQUESTS) {
      const seconds =
        retryAfter != null && retryAfter > 0 ? Math.ceil(retryAfter) : 60;
      response.setHeader('Retry-After', String(seconds));
    }
    response.status(status).json({
      statusCode: status,
      code,
      message,
      timestamp: new Date().toISOString(),
      path: request.url,
    });
  }
}
