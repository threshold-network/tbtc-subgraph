import { TokensSeized } from "../generated/TokenStakingTelemetry/TokenStakingTelemetry"
import { getOrCreateOperator, getOrCreateOperatorEvent } from "./utils/helper"

// Preserve the emitted signal without interpreting it as a current token loss.
// Application fault handlers own fault counters; counting here would duplicate them.
export function handleTokensSeized(event: TokensSeized): void {
    let eventEntity = getOrCreateOperatorEvent(event, "SLASHED")
    eventEntity.amount = event.params.amount
    eventEntity.discrepancy = event.params.discrepancy
    eventEntity.isRandomBeaconEvent = false
    eventEntity.save()

    let operator = getOrCreateOperator(event.params.stakingProvider)
    let events = operator.events
    events.push(eventEntity.id)
    operator.events = events
    operator.save()
}
