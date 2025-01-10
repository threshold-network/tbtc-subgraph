import {BigInt, ByteArray, Bytes, crypto, ethereum} from '@graphprotocol/graph-ts'
import {final, init, update} from "./crypto";
import { getOrCreateRedemption } from './helper';
import * as Const from './constants';

export function reformatRedemptionKeyIfExists(redeemerOutputScript: Bytes, walletPubKeyHash: Bytes): string {
    let loop = true
    let count = Const.ZERO_BI
    let id = ""
    while (loop) {
        id = calculateRedemptionKey(redeemerOutputScript, walletPubKeyHash, count)
        let redemption = getOrCreateRedemption(id)
        if (redemption.updateTimestamp.notEqual(Const.ZERO_BI)) {
            count = count.plus(Const.ONE_BI)
        } else {
            loop = false
        }
    }
    return id
}

/** Calculates deposit key the same way as the Bridge contract.
 The deposit key is computed as
 `keccak256(fundingTxHash | fundingOutputIndex)`.*/
export function calculateDepositKey(
    fundingTxHash: Uint8Array,
    fundingOutputIndex: i32
): ByteArray {
    let data = new Uint8Array(fundingTxHash.length + 4);
    data.set(fundingTxHash, 0);
    let indexData = new Uint8Array(4);
    indexData[0] = (fundingOutputIndex >> 24) & 0xff;
    indexData[1] = (fundingOutputIndex >> 16) & 0xff;
    indexData[2] = (fundingOutputIndex >> 8) & 0xff;
    indexData[3] = fundingOutputIndex & 0xff;
    data.set(indexData, fundingTxHash.length)
    let byteArray = new ByteArray(data.length)
    for (let i = 0; i < data.length; i++) {
        byteArray[i] = data[i];
    }
    return crypto.keccak256(byteArray);
}

/**
 * keccak256(keccak256(redeemerOutputScript) | walletPubKeyHash) + "-" + count
 * */
export function calculateRedemptionKey(redeemerOutputScript: ByteArray, walletPublicKeyHash: ByteArray, count: BigInt): string {
    let scriptHashArray = crypto.keccak256(redeemerOutputScript);
    let data = new Uint8Array(scriptHashArray.length + walletPublicKeyHash.length);
    data.set(scriptHashArray, 0);
    data.set(walletPublicKeyHash, scriptHashArray.length);

    return crypto.keccak256(Bytes.fromUint8Array(data)).toHexString().concat("-").concat(count.toString());
}

/**
 * The key = keccak256(scriptHash | walletPubKeyHash) + "-" + count
 */
export function calculateRedemptionKeyByScriptHash(scriptHash: ByteArray, walletPublicKeyHash: ByteArray, count: BigInt): string {
    let data = new Uint8Array(scriptHash.length + walletPublicKeyHash.length);
    data.set(scriptHash, 0);
    data.set(walletPublicKeyHash, scriptHash.length);

    return crypto.keccak256(Bytes.fromUint8Array(data)).toHexString().concat("-").concat(count.toString());
}

export function calculateRedemptionKeyByBigInt(redemptionKey: BigInt, count: BigInt): string {
    const redemptionKeyInHexString = bigIntToHex(redemptionKey);
    return redemptionKeyInHexString.concat("-").concat(count.toString());
}

export function keccak256TwoString(first: string, second: string): string {
    let hashData = Bytes.fromHexString(first).concat(Bytes.fromHexString(second));
    return crypto.keccak256(hashData).toHexString();
}

export function bytesToUint8Array(bytes: Bytes): Uint8Array {
    let uint8Array = new Uint8Array(bytes.length)
    for (let i = 0; i < bytes.length; i++) {
        uint8Array[i] = bytes[i]
    }
    return uint8Array;
}

/**
 * Convert hex to Bigint. Start from the last character and multiply value with the 16s power.
 */
export function hexToBigint(hex: string): BigInt {
    if (hex.length >= 2 && hex.charAt(0) == '0' && hex.charAt(1) == 'x') {
        hex = hex.substr(2);
    }

    let bigint = BigInt.fromI32(0);
    let power = BigInt.fromI32(1);
    for (let i = hex.length - 1; i >= 0; i--) {
        let char = hex.charCodeAt(i);
        let value = 0;
        if (char >= 48 && char <= 57) {
            value = char - 48;
        } else if (char >= 65 && char <= 70) {
            value = char - 55;
        }
        bigint = bigint.plus(BigInt.fromI32(value).times(power));
        power = power.times(BigInt.fromI32(16));
    }
    return bigint;
}

export function bigIntToHex(bigInt: BigInt, paddingLength: i32 = 64): string {
        const zero = BigInt.fromI32(0);
        if (bigInt.equals(zero)) {
            return "0x" + "0".repeat(paddingLength);
        }
    
        let hex = '';
        while (bigInt.gt(zero)) {
            let digit = bigInt.mod(BigInt.fromI32(16));
            bigInt = bigInt.div(BigInt.fromI32(16));
    
            if (digit.ge(zero) && digit.le(BigInt.fromI32(9))) {
                hex = String.fromCharCode(digit.toI32() + 48) + hex;
            } else {
                hex = String.fromCharCode(digit.toI32() + 87) + hex; // Adding 87 for 'a'-'f'
            }
        }
    
        // Pad with zeros if the hex string is shorter than the specified length
        if (hex.length < paddingLength) {
            hex = "0".repeat(paddingLength - hex.length) + hex;
        }
    
        return '0x' + hex;
    }

export function toHexString(bin: Uint8Array): string {
    let bin_len = bin.length;
    let hex = "";
    for (let i = 0; i < bin_len; i++) {
        let bin_i = bin[i] as u32;
        let c = bin_i & 0xf;
        let b = bin_i >> 4;
        let x: u32 = ((87 + c + (((c - 10) >> 8) & ~38)) << 8) |
            (87 + b + (((b - 10) >> 8) & ~38));
        hex += String.fromCharCode(x as u8);
        x >>= 8;
        hex += String.fromCharCode(x as u8);
    }
    return hex;
}

export function hash(data: Uint8Array): Uint8Array {
    const output = new Uint8Array(32);
    init();
    update(changetype<usize>(data.buffer), data.length);
    final(changetype<usize>(output.buffer));
    return output;
}

/** creates a string composed of '0's given a length */
export function createZeroString(length: i32): string {
    let zeroString = '';
    for (let i = 0; i < length; i++) {
        zeroString += '0';
    }
    return zeroString;
}

export function convertDepositKeyToHex(depositKey: BigInt): string {
    let depositKeyHex = depositKey.toHexString();
    //Some cases with length is 65 then convert to bytes will crash
    //exp : 0x86cc94dc9f76f03160ab4514842b9345b5d063a5b4023fed4efc9a871b06044
    if (depositKeyHex.length < 66) {
        let missedNumber = 66 - depositKeyHex.length;
        let replacement = '0x' + createZeroString(missedNumber);
        depositKeyHex = depositKeyHex.replace('0x', replacement)
    }
    return depositKeyHex
}

export function getIDFromEvent(event: ethereum.Event): string {
    return event.transaction.hash.toHex() + "-" + event.logIndex.toString()
}

export function getIDFromCall(call: ethereum.Call): string {
    return call.transaction.hash.toHex() + "-" + call.transaction.index.toString();
}

export function getBeaconGroupId(pubKey: Bytes): string {
    // Cut off the group pub key, we don't want the ids to to be unreasonably long.
    return pubKey.toHexString().slice(0, 62)
}

export function removeItem<T>(data: Array<T>, item: T): Array<T> {
    let index = data.indexOf(item);
    if (index === -1) {
        // Item not found, return the original array
        return data;
    }

    // Remove the item using splice()
    data.splice(index, 1);
    return data;
}