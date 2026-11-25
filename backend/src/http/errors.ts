import type { ErrorRequestHandler } from 'express'
import { Prisma } from '../generated/prisma/client.ts'
import { ZodError } from 'zod'
import { formLimitErrorMessage } from '../contracts/form-limits.ts'

export class ApiError extends Error {
  status: number
  code: string
  constructor(status: number, code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

export const errors: ErrorRequestHandler = (
  error: unknown,
  _request,
  response,
  _next,
) => {
  void _next // Express identifies error middleware by its four-argument signature.
  let failure = new ApiError(503, 'UNAVAILABLE', '服务暂时不可用，请稍后重试')
  if (error instanceof ApiError) failure = error
  else if (error instanceof ZodError || error instanceof SyntaxError)
    failure = new ApiError(
      400,
      'INVALID_INPUT',
      formLimitErrorMessage(error) ?? '请检查输入字段和格式',
    )
  else if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === 'P2002')
      failure = new ApiError(409, 'EMAIL_EXISTS', '登录邮箱已被使用')
    if (error.code === 'P2034')
      failure = new ApiError(409, 'CONFLICT', '操作发生冲突，请重试')
  } else if (
    error &&
    typeof error === 'object' &&
    'status' in error &&
    error.status === 413
  )
    failure = new ApiError(413, 'PAYLOAD_TOO_LARGE', '请求内容过大')
  // Never serialize Zod inputs, Prisma errors, password hashes or request bodies.
  response.status(failure.status).json({
    error: {
      code: failure.code,
      message: failure.message,
      requestId: response.locals.requestId,
    },
  })
}
