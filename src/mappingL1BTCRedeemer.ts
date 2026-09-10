import { BigInt, log } from "@graphprotocol/graph-ts";
import {
  RedemptionRequested as WormholeRedemptionRequestedEvent,
  AllowedSenderUpdated as AllowedSenderUpdatedEvent,
} from "../generated/L1BTCRedeemerWormhole/L1BTCRedeemerWormhole";
import { Redemption, WormholeSender } from "../generated/schema";

import {createRedemptionActivity} from "./mappingBridgeActivity";
import {calculateRedemptionKeyByBigInt} from "./utils/utils";

// Wormhole Chain ID constants
const WORMHOLE_CHAIN_SOLANA: i32 = 1;
const WORMHOLE_CHAIN_ETHEREUM: i32 = 2;
const WORMHOLE_CHAIN_BSC: i32 = 4;
const WORMHOLE_CHAIN_POLYGON: i32 = 5;
const WORMHOLE_CHAIN_AVALANCHE: i32 = 6;
const WORMHOLE_CHAIN_FANTOM: i32 = 10;
const WORMHOLE_CHAIN_KLAYTN: i32 = 13;
const WORMHOLE_CHAIN_CELO: i32 = 14;
const WORMHOLE_CHAIN_MOONBEAM: i32 = 16;
const WORMHOLE_CHAIN_SUI: i32 = 21;
const WORMHOLE_CHAIN_ARBITRUM: i32 = 23;
const WORMHOLE_CHAIN_OPTIMISM: i32 = 24;
const WORMHOLE_CHAIN_BASE: i32 = 30;

// Known L2BitcoinRedeemer addresses (bytes32 format) mapped to chain IDs
function getChainIdForSender(senderId: string): i32 {
  // Arbitrum L2BitcoinRedeemer
  if (senderId == "0x000000000000000000000000d7cd996a47b3293d4fec2dbcf49692370334d9b7") {
    return WORMHOLE_CHAIN_ARBITRUM;
  }
  // Base L2BitcoinRedeemer
  if (senderId == "0x000000000000000000000000e931f1ac6b00400e1dad153e184afee164d2d88b") {
    return WORMHOLE_CHAIN_BASE;
  }
  return 0;
}

/**
 * Convert Wormhole chain ID to schema enum string
 */
function chainIdToEnum(chainId: i32): string {
  if (chainId == WORMHOLE_CHAIN_SOLANA) return "SOLANA";
  if (chainId == WORMHOLE_CHAIN_ETHEREUM) return "ETHEREUM";
  if (chainId == WORMHOLE_CHAIN_BSC) return "BSC";
  if (chainId == WORMHOLE_CHAIN_POLYGON) return "POLYGON";
  if (chainId == WORMHOLE_CHAIN_AVALANCHE) return "AVALANCHE";
  if (chainId == WORMHOLE_CHAIN_FANTOM) return "FANTOM";
  if (chainId == WORMHOLE_CHAIN_KLAYTN) return "KLAYTN";
  if (chainId == WORMHOLE_CHAIN_CELO) return "CELO";
  if (chainId == WORMHOLE_CHAIN_MOONBEAM) return "MOONBEAM";
  if (chainId == WORMHOLE_CHAIN_SUI) return "SUI";
  if (chainId == WORMHOLE_CHAIN_ARBITRUM) return "ARBITRUM";
  if (chainId == WORMHOLE_CHAIN_OPTIMISM) return "OPTIMISM";
  if (chainId == WORMHOLE_CHAIN_BASE) return "BASE";
  return "UNKNOWN";
}

/** The Bridge has already created the redemption before this hub event. */
export function handleWormholeRedemptionRequested(event: WormholeRedemptionRequestedEvent): void {
  let activity = createRedemptionActivity(event);
  if (activity.get("sourceChainId") === null) return;

  // Redemption ids carry an occurrence suffix because a wallet/script key can
  // be reused after a completed redemption. Do not load the bare uint256 key
  // or create a placeholder entity when no matching Bridge event was indexed.
  let count = BigInt.zero();
  while (true) {
    let id = calculateRedemptionKeyByBigInt(event.params.redemptionKey, count);
    let redemption = Redemption.load(id);
    if (redemption === null) break;
    let txHash = redemption.redemptionTxHash;
    if (txHash !== null && txHash.equals(event.transaction.hash)) {
      redemption.sourceChainId = activity.sourceChainId;
      redemption.sourceChain = activity.sourceChain.toUpperCase();
      redemption.wormholeSequence = activity.sequence;
      redemption.save();
    }
    count = count.plus(BigInt.fromI32(1));
  }
}

/**
 * Handle AllowedSenderUpdated event
 * Tracks which L2 senders are authorized for cross-chain redemptions
 */
export function handleAllowedSenderUpdated(event: AllowedSenderUpdatedEvent): void {
  let senderId = event.params.sender.toHexString();
  let allowed = event.params.allowed;

  let sender = WormholeSender.load(senderId);

  if (sender === null) {
    sender = new WormholeSender(senderId);
    sender.addedAt = event.block.timestamp;

    // Try to determine chain from known senders
    let chainId = getChainIdForSender(senderId);
    sender.chainId = chainId;
    sender.chain = chainIdToEnum(chainId);
  }

  sender.allowed = allowed;
  sender.updatedAt = event.block.timestamp;
  sender.save();

  log.info("Wormhole sender {} updated: allowed={}", [senderId, allowed.toString()]);
}
