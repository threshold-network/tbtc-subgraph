import {TransferRedeemed} from "../generated/WormholeTokenBridge/WormholeTokenBridge"
import {Withdrawal} from "../generated/StarkGateBridge/StarkGateBridge"
import {createBridgeActivity} from "./mappingBridgeActivity"
import {wormholeChainName} from "./utils/bridge-origin"
import {returnContracts, wormholePayout} from "./utils/bridge-return"

export function handleWormholeTransferRedeemed(event: TransferRedeemed): void {
    let contracts = returnContracts()
    if (contracts === null || !event.address.equals(contracts.wormhole)) return
    // Sei was never launched for tBTC and is deliberately outside this feed.
    if (event.params.emitterChainId == 32) return
    let payout = wormholePayout(event, contracts.token)
    if (payout === null || payout.recipient.equals(contracts.bitcoinRedeemer)) return

    let activity = createBridgeActivity(event, "TRANSFER_RECEIVED", "IN", "Wormhole",
        wormholeChainName(event.params.emitterChainId), "Ethereum")
    activity.sourceChainId = event.params.emitterChainId
    activity.emitterAddress = event.params.emitterAddress
    activity.sequence = event.params.sequence
    activity.recipient = payout.recipient
    activity.amount = payout.amount
    // tx.from can be a relayer/batch executor, not the source-chain sender.
    activity.save()
}

export function handleStarkGateWithdrawal(event: Withdrawal): void {
    let contracts = returnContracts()
    if (contracts === null || !event.address.equals(contracts.starkGate) ||
        !event.params.token.equals(contracts.token) || event.params.recipient.equals(contracts.bitcoinRedeemer)) return
    // StarkGate emits Withdrawal only after consuming the proven L2 message
    // and transferring this token/amount to this recipient. DepositReclaimed
    // is a different event and must never be treated as an arrival from L2.
    let activity = createBridgeActivity(event, "TRANSFER_RECEIVED", "IN", "StarkGate", "StarkNet", "Ethereum")
    activity.recipient = event.params.recipient
    activity.amount = event.params.amount
    activity.save()
}
