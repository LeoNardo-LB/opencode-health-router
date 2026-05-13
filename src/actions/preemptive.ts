import type { Config, ModelKey } from "../types.js"
import type { HealthStore } from "../health/store.js"
import type { Logger } from "../logging/logger.js"
import { splitModelKey } from "../types.js"

interface ChatMessageInput {
  sessionID: string
  agent?: string
  model?: { providerID: string; modelID: string }
  messageID?: string
  variant?: string
}

interface ChatMessageOutput {
  message: { model?: { providerID: string; modelID: string }; [key: string]: unknown }
  parts: unknown[]
}

export function handleChatMessage(
  input: ChatMessageInput,
  output: ChatMessageOutput,
  store: HealthStore,
  config: Config,
  logger?: Logger,
): void {
  if (!input.model?.providerID || !input.model?.modelID) return

  const currentKey: ModelKey = `${input.model.providerID}/${input.model.modelID}`
  const agentName = input.agent || "*"
  const agentConfig = config.agents[agentName] ?? config.agents["*"]
  if (!agentConfig || agentConfig.fallbackModels.length === 0) {
    logger?.debug("preemptive.skip_no_chain", { agent: agentName, model: currentKey })
    return
  }

  const chain: ModelKey[] = [currentKey, ...agentConfig.fallbackModels]
  const sorted = store.sort(chain)
  const best = sorted[0]

  if (best === currentKey) {
    logger?.debug("preemptive.no_switch", { agent: agentName, model: currentKey, score: store.get(currentKey) })
    return
  }

  const { providerID, modelID } = splitModelKey(best)
  output.message.model = { providerID, modelID }
  logger?.info("preemptive.switched", {
    sessionID: input.sessionID,
    agent: agentName,
    from: currentKey,
    to: best,
    fromScore: store.get(currentKey),
    toScore: store.get(best),
  })
}
