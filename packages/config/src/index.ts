import deepMerge from 'deepmerge'
import { loadEnvConfig, loadFileConfigs } from './loader'
import { normalizeConfig } from './normalize'
import { ServerConfigSchema } from './types'

export * from './env'
export * from './normalize'
export * from './types'

const parsedConfig = ServerConfigSchema.parse(
  deepMerge.all([...loadFileConfigs(), loadEnvConfig()])
)

if (
  parsedConfig.freezeTime !== undefined &&
  (parsedConfig.freezeTime < parsedConfig.startTime ||
    parsedConfig.freezeTime > parsedConfig.endTime)
) {
  throw new Error('freezeTime must be between startTime and endTime')
}

export const config = normalizeConfig(parsedConfig)
