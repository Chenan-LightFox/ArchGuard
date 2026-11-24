import { HttpException, HttpStatus } from '@nestjs/common'

export type DomainErrorCode =
  | 'VALIDATION_ERROR'
  | 'NOT_AUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'REVISION_CONFLICT'
  | 'STATE_CONFLICT'
  | 'IDEMPOTENCY_CONFLICT'
  | 'ALREADY_DECIDED'
  | 'BASELINE_EXPIRED'
  | 'NOT_READY'
  | 'INTERNAL_ERROR'

export class DomainError extends Error {
  constructor(
    readonly code: DomainErrorCode,
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'DomainError'
  }
}

export function fail(code: DomainErrorCode, status: number, message: string): never {
  throw new DomainError(code, status, message)
}

export function toHttpException(error: unknown): HttpException {
  if (error instanceof DomainError) {
    return new HttpException({ code: error.code, message: error.message }, error.status)
  }
  if (error instanceof HttpException) return error
  return new HttpException(
    { code: 'INTERNAL_ERROR', message: '处理请求时发生内部错误。' },
    HttpStatus.INTERNAL_SERVER_ERROR,
  )
}
