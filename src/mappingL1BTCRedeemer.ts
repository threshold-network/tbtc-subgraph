import { BigInt, Bytes, log } from "@graphprotocol/graph-ts";
import {
  RedemptionRequested as WormholeRedemptionRequestedEvent,
  AllowedSenderUpdated as AllowedSenderUpdatedEvent,
  RequestRedemptionCall,
} from "../generated/L1BTCRedeemerWormhole/L1BTCRedeemerWormhole";
import { Redemption, WormholeSender, CrossChainRedemptionTracker } from "../generated/schema";

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
const WORMHOLE_CHAIN_STARKNET: i32 = 10006;

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
  if (chainId == WORMHOLE_CHAIN_STARKNET) return "STARKNET";
  return "UNKNOWN";
}

/**
 * Parse Wormhole VAA (Verified Action Approval) to extract source chain ID
 *
 * VAA Structure:
 * - Version (1 byte)
 * - Guardian Set Index (4 bytes)
 * - Signature Count (1 byte)
 * - Signatures (66 bytes each)
 * - Timestamp (4 bytes)
 * - Nonce (4 bytes)
 * - Emitter Chain ID (2 bytes) <-- This is what we need
 * - Emitter Address (32 bytes)
 * - Sequence (8 bytes)
 * - Consistency Level (1 byte)
 * - Payload (variable)
 */
class WormholeVAAData {
  isValid: boolean;
  emitterChainId: i32;
  emitterAddress: Bytes;
  sequence: BigInt;

  constructor() {
    this.isValid = false;
    this.emitterChainId = 0;
    this.emitterAddress = Bytes.empty();
    this.sequence = BigInt.zero();
  }
}

function parseWormholeVAA(encodedVm: Bytes): WormholeVAAData {
  let result = new WormholeVAAData();

  if (encodedVm.length < 6) {
    log.warning("VAA too short: {} bytes", [encodedVm.length.toString()]);
    return result;
  }

  // Version check
  let version = encodedVm[0];
  if (version != 1) {
    log.warning("Unsupported VAA version: {}", [version.toString()]);
    return result;
  }

  // Skip guardian set index (4 bytes) and get signature count
  let signatureCount = encodedVm[5] as i32;

  // Calculate offset to body (after signatures)
  // Header: 1 (version) + 4 (guardian set) + 1 (sig count) = 6 bytes
  // Each signature: 66 bytes (1 guardian index + 65 signature)
  let bodyOffset = 6 + (signatureCount * 66);

  if (encodedVm.length < bodyOffset + 51) {
    log.warning("VAA body too short after {} signatures", [signatureCount.toString()]);
    return result;
  }

  // Parse body
  // Timestamp: 4 bytes at bodyOffset
  // Nonce: 4 bytes at bodyOffset + 4
  // Emitter Chain ID: 2 bytes at bodyOffset + 8 (big endian)
  let emitterChainOffset = bodyOffset + 8;
  result.emitterChainId = (encodedVm[emitterChainOffset] as i32) * 256 + (encodedVm[emitterChainOffset + 1] as i32);

  // Emitter Address: 32 bytes at bodyOffset + 10
  let emitterAddressOffset = bodyOffset + 10;
  let emitterBytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    emitterBytes[i] = encodedVm[emitterAddressOffset + i];
  }
  result.emitterAddress = Bytes.fromUint8Array(emitterBytes);

  // Sequence: 8 bytes at bodyOffset + 42 (big endian)
  let sequenceOffset = bodyOffset + 42;
  let sequenceBytes = new Uint8Array(8);
  for (let i = 0; i < 8; i++) {
    sequenceBytes[i] = encodedVm[sequenceOffset + 7 - i]; // Reverse for little endian
  }
  result.sequence = BigInt.fromUnsignedBytes(Bytes.fromUint8Array(sequenceBytes));

  result.isValid = true;
  return result;
}

/**
 * Handle call to requestRedemption(bytes encodedVm)
 * This is where we decode the Wormhole VAA to get the source chain
 */
export function handleRequestRedemptionCall(call: RequestRedemptionCall): void {
  let encodedVm = call.inputs.encodedVm;

  // Parse the Wormhole VAA
  let vaaData = parseWormholeVAA(encodedVm);

  if (!vaaData.isValid) {
    log.warning("Failed to parse Wormhole VAA in tx {}", [call.transaction.hash.toHexString()]);
    return;
  }

  log.info("Wormhole redemption from chain {} (emitter: {}, seq: {})", [
    vaaData.emitterChainId.toString(),
    vaaData.emitterAddress.toHexString(),
    vaaData.sequence.toString()
  ]);

  // Store the source chain info in a tracker entity
  // This will be linked to the redemption when RedemptionRequested event is processed
  let txHash = call.transaction.hash.toHexString();

  let tracker = new CrossChainRedemptionTracker(txHash);
  tracker.sourceChainId = vaaData.emitterChainId;
  tracker.sourceChain = chainIdToEnum(vaaData.emitterChainId);
  tracker.emitterAddress = vaaData.emitterAddress;
  tracker.sequence = vaaData.sequence;
  tracker.processed = false;
  tracker.save();
}

/**
 * Handle RedemptionRequested event from L1BTCRedeemerWormhole
 * This event is emitted after the Bridge.requestRedemption is called
 */
export function handleWormholeRedemptionRequested(event: WormholeRedemptionRequestedEvent): void {
  let redemptionKey = event.params.redemptionKey;

  // Try to find the matching redemption created by the Bridge
  let redemption = Redemption.load(redemptionKey.toHexString());

  if (redemption == null) {
    log.warning("Redemption not found for wormhole event: {}", [redemptionKey.toHexString()]);
    return;
  }

  // Look up the cross-chain tracker for this transaction
  let txHash = event.transaction.hash.toHexString();
  let tracker = CrossChainRedemptionTracker.load(txHash);

  if (tracker != null) {
    // Update redemption with cross-chain info
    redemption.sourceChainId = tracker.sourceChainId;
    redemption.sourceChain = tracker.sourceChain;
    redemption.wormholeSequence = tracker.sequence;
    redemption.save();

    // Mark tracker as processed
    tracker.processed = true;
    tracker.save();

    log.info("Updated redemption {} with source chain {}", [
      redemptionKey.toHexString(),
      tracker.sourceChain
    ]);
  } else {
    log.warning("No cross-chain tracker found for tx {}", [txHash]);
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

  if (sender == null) {
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
