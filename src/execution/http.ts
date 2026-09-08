import { ExecutionError, opaqueId } from './types.js'
import type { TaskExecutionService } from './runner.js'

/** Runs behind the existing Host API's Origin, Fetch-Site, body limit and CSRF guards. */
export const EXECUTION_METHODS = new Set(['execution.preview','execution.start','execution.status','execution.stop','execution.acknowledge'])
const exact = (value: unknown, keys: string[]): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length
  && keys.every(key => Object.hasOwn(value, key))
export function executionApi(service: TaskExecutionService) {
  return {
    async handle(method: string, args: unknown): Promise<unknown> {
      if (method === 'execution.start') {
        if (!exact(args, ['previewId','intentId']) || !opaqueId(args.previewId) || !opaqueId(args.intentId)) throw new ExecutionError('execution.arguments', '启动参数无效。')
        return service.start(args.previewId, args.intentId)
      }
      if (method === 'execution.preview' || method === 'execution.status') {
        if (!exact(args, ['taskId']) || !opaqueId(args.taskId)) throw new ExecutionError('execution.arguments', '任务参数无效。')
        return method === 'execution.preview' ? service.preview(args.taskId) : service.status(args.taskId)
      }
      if (method === 'execution.stop' || method === 'execution.acknowledge') {
        const keys = method === 'execution.acknowledge' ? ['taskId','runId','confirmed'] : ['taskId','runId']
        if (!exact(args, keys) || !opaqueId(args.taskId) || !opaqueId(args.runId) || (method === 'execution.acknowledge' && args.confirmed !== true)) throw new ExecutionError('execution.arguments', '停止或核对参数无效。')
        return method === 'execution.stop' ? service.stop(args.taskId, args.runId) : service.acknowledge(args.taskId, args.runId)
      }
      throw new ExecutionError('execution.method-not-allowed', '不支持此执行操作。')
    },
  }
}
