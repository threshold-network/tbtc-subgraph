import {
    Banned,
    Unbanned,
    VetoFinalized,
} from "../generated/RedemptionWatchtower/RedemptionWatchtower"
import * as Utils from "./utils/utils"
import {getIDFromEvent} from "./utils/utils"
import * as Const from "./utils/constants"
import * as Helper from "./utils/helper"

export function handleVetoFinalized(
    event: VetoFinalized
): void {
    let redemptionKey = event.params.redemptionKey
    let count = Const.ZERO_BI

    let transactionEntity = Helper.getOrCreateTransaction(getIDFromEvent(event))
    transactionEntity.txHash = event.transaction.hash
    transactionEntity.timestamp = event.block.timestamp
    transactionEntity.from = event.transaction.from
    transactionEntity.to = event.transaction.to
    transactionEntity.description = `Redemption Vetoed`
    transactionEntity.save()

    for (let i = 0; i < Const.MAXIMUM_BATCH_SIZE; i++) {
        const id = Utils.calculateRedemptionKeyByBigInt(redemptionKey, count)
        const redemption = Helper.getOrCreateRedemption(id)

        if (redemption.updateTimestamp.equals(Const.ZERO_BI)) break
      
        redemption.status = "VETOED"
        redemption.updateTimestamp = event.block.timestamp
        const transactions = redemption.transactions
        transactions.push(transactionEntity.id)
        redemption.transactions = transactions
        redemption.save()
        count = count.plus(Const.ONE_BI)
    }
}

export function handleBanned(
    event: Banned
): void {
    let user = Helper.getOrCreateUser(event.params.redeemer)
    user.isRedeemerBanned = true
    user.save()
}

export function handleUnbanned(
    event: Unbanned
): void {
    let user = Helper.getOrCreateUser(event.params.redeemer)
    user.isRedeemerBanned = false
    user.save()
}
