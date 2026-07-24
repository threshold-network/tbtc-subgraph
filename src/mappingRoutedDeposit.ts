import { BigInt, Bytes } from '@graphprotocol/graph-ts'

import {
    DepositInitialized,
    DepositFinalized,
} from '../generated/GaslessDepositor/RoutedDepositor'
import { getOrCreateDeposit } from './utils/helper'
import * as Utils from './utils/utils'

// The routed L1 depositor events carry the same depositKey (uint256) that the
// Bridge uses as the deposit key, i.e. keccak256(fundingTxHash | fundingOutputIndex).
// That value IS the Deposit entity id (a 32-byte Bytes). bigIntToHex returns a
// 0x-prefixed, big-endian, 64-char (32-byte) hex string, so this reproduces the
// exact id that mappingBridge builds via Bytes.fromByteArray(keccak256(...)).
function depositIdFromKey(depositKey: BigInt): Bytes {
    return Bytes.fromHexString(Utils.bigIntToHex(depositKey))
}

// destinationChainDepositOwner is emitted as bytes32 already — for EVM
// destinations the owner address is left-padded to 32 bytes; for Sui/StarkNet it
// is the raw bytes32. That is exactly the 32-byte form the dapp's
// normalizeDestinationTopic() produces, so storing it verbatim makes
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
    deposit.l1Sender = l1Sender
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
