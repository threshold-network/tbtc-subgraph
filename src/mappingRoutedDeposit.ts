import { BigInt, Bytes } from '@graphprotocol/graph-ts'

import {
    DepositInitialized,
    DepositFinalized,
    DepositInitialized1 as LegacyDepositInitialized,
    DepositFinalized1 as LegacyDepositFinalized,
} from '../generated/GaslessDepositor/RoutedDepositor'
import { getOrCreateDeposit } from './utils/helper'
import * as Utils from './utils/utils'

// The routed L1 depositors emitted two event eras. The legacy overloads
// (DepositInitialized/DepositFinalized with an indexed *address* owner) cover
// the bulk of Arbitrum/Base history; the current overloads carry the owner as
// an indexed *bytes32*. Both funnel into attachRoutedDestination, with legacy
// owners left-padded to 32 bytes so one destinationOwner form covers both eras.

// The routed L1 depositor events carry the same depositKey (uint256) that the
// Bridge uses as the deposit key, i.e. keccak256(fundingTxHash | fundingOutputIndex).
// That value IS the Deposit entity id (a 32-byte Bytes); convertDepositKeyToHex
// is the same conversion mappingTBTCVault uses to look Deposits up by key.
function depositIdFromKey(depositKey: BigInt): Bytes {
    return Bytes.fromHexString(Utils.convertDepositKeyToHex(depositKey))
}

// The legacy events emit the owner as an address (20 bytes) that sits in its
// topic zero-padded to 32 bytes. Store that same left-padded form the current
// bytes32 variant stores so `where: { destinationOwner: $owner }` matches both
// eras. new Bytes(12) is zero-initialized.
function leftPadAddressTo32Bytes(address: Bytes): Bytes {
    return new Bytes(12).concat(address)
}

// destinationChainDepositOwner is stored as 32 bytes — for EVM destinations the
// owner address is left-padded to 32 bytes; for Sui/StarkNet it is the raw
// bytes32. That is exactly the 32-byte form the dapp's
// normalizeDestinationTopic() produces, so storing it makes
// `where: { destinationOwner: $owner }` a drop-in for the client's eth_getLogs scan.
function attachRoutedDestination(
    depositKey: BigInt,
    destinationOwner: Bytes,
    l1Sender: Bytes,
    timestamp: BigInt
): void {
    // The Bridge datasource (startBlock 16,397,413) indexes DepositRevealed for
    // routed deposits too — emitted in the same transaction and at a lower log
    // index than DepositInitialized — so the Deposit already exists with its
    // required `user` set before this handler runs. getOrCreateDeposit therefore
    // loads the existing entity rather than creating a userless one.
    let deposit = getOrCreateDeposit(depositIdFromKey(depositKey))
    deposit.destinationOwner = destinationOwner
    // Keep the first routed sender seen (the initializer when in range) —
    // DepositFinalized is permissionless and typically sent by a relayer.
    // (Truthiness null check: `== null` trips ByteArray's `==` overload and
    // crashes the AS 0.19 compiler.)
    if (!deposit.l1Sender) {
        deposit.l1Sender = l1Sender
    }
    deposit.isRouted = true
    deposit.updateTimestamp = timestamp
    deposit.save()
}

export function handleRoutedDepositInitialized(event: DepositInitialized): void {
    attachRoutedDestination(
        event.params.depositKey,
        event.params.destinationChainDepositOwner,
        event.params.l1Sender,
        event.block.timestamp
    )
}

// Idempotent with Initialized (the owner is identical). Kept so a routed deposit
// whose DepositInitialized predates a datasource startBlock is still attached
// when its DepositFinalized lands in range.
export function handleRoutedDepositFinalized(event: DepositFinalized): void {
    attachRoutedDestination(
        event.params.depositKey,
        event.params.destinationChainDepositOwner,
        event.params.l1Sender,
        event.block.timestamp
    )
}

export function handleLegacyRoutedDepositInitialized(
    event: LegacyDepositInitialized
): void {
    attachRoutedDestination(
        event.params.depositKey,
        leftPadAddressTo32Bytes(event.params.destinationChainDepositOwner),
        event.params.l1Sender,
        event.block.timestamp
    )
}

export function handleLegacyRoutedDepositFinalized(
    event: LegacyDepositFinalized
): void {
    attachRoutedDestination(
        event.params.depositKey,
        leftPadAddressTo32Bytes(event.params.destinationChainDepositOwner),
        event.params.l1Sender,
        event.block.timestamp
    )
}
