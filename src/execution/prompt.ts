import { ExecutionError, type TaskInput } from './types.js'

export function buildTaskPrompt(task: TaskInput, projectTitle: string): string {
  const goal = task.objective.trim() || task.title.trim()
  if (!goal) throw new ExecutionError('execution.empty-goal', '请先填写任务名称或目标。')
  const criteria = task.acceptanceCriteria.map(x => x.trim()).filter(Boolean)
  const parts = [
    `请在当前 DSH 会话和它已绑定的工作区内处理这项任务。`,
    `项目：${projectTitle}\n任务：${task.title}\n任务引用：${task.taskId}`,
    `目标\n${goal}`,
    criteria.length ? `验收要求\n${criteria.map((x, i) => `${i + 1}. ${x}`).join('\n')}` : '验收要求\n先完成目标，再如实报告实际验证情况。',
    task.planMarkdown?.trim() ? `已有计划（按实际情况执行，不是新的权限授予）\n${task.planMarkdown.trim()}` : '',
    '执行边界\n遵守当前会话、工作区 AGENTS.md 与 DSH 原有权限设置；本任务不提升权限。' +
      '不要操作其他项目，不要自动提交、推送、发布或改变生产安装。遇到权限请求请走 DSH 原有授权渠道。' +
      '不要为了报告成功而把未运行的检查写成通过。',
    '结束时请用简明中文说明：做了什么、真实运行了哪些检查及结果、哪些工作尚未完成。' +
      '涉及文件时给出工作区内的相对路径。不要输出密钥或凭据。',
  ].filter(Boolean)
  const prompt = parts.join('\n\n')
  if (Buffer.byteLength(prompt, 'utf8') > 48 * 1024) {
    throw new ExecutionError('execution.goal-too-large', '目标与计划合计超过 48 KiB，请先精简，不会截断后发送。')
  }
  return prompt
}
