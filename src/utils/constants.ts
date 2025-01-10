import {BigInt, BigDecimal, Address, dataSource} from '@graphprotocol/graph-ts'

export const ADDRESS_ZERO = Address.fromString(
    '0x0000000000000000000000000000000000000000',
);

export const Treasury = dataSource.network() == "sepolia" ? Address.fromString(
    '0x68ad60cc5e8f3b7cc53beab321cf0e6036962dbc',
) : Address.fromString(
    '0x87F005317692D05BAA4193AB0c961c69e175f45f',
);

export const BRIDGE_CONTRACT = dataSource.network() == "sepolia" ? Address.fromString(
    '0x9b1a7fE5a16A15F2f9475C5B231750598b113403',
) :  Address.fromString(
    '0x5e4861a80B55f035D899f66772117F00FA0E8e7B',
);

export const TBTCVault = dataSource.network() == "sepolia" ? Address.fromString(
    '0xB5679dE944A79732A75CE556191DF11F489448d5',
) :  Address.fromString(
    '0x9c070027cdc9dc8f82416b2e5314e11dfb4fe3cd',
);

export const TBTCToken = dataSource.network() == "sepolia" ? Address.fromString(
    '0x517f2982701695D4E52f1ECFBEf3ba31Df470161',
) :  Address.fromString(
    '0x18084fbA666a33d37592fA2633fD49a74DD93a88',
);

export const ADDRESS_TBTC = dataSource.network() == "sepolia" ? Address.fromString(
    '0x517f2982701695D4E52f1ECFBEf3ba31Df470161',
) :  Address.fromString(
    '0x18084fbA666a33d37592fA2633fD49a74DD93a88',
);

export const MAXIMUM_BATCH_SIZE = 1000;
export let ZERO_BI = BigInt.fromI32(0)
export let ONE_BI = BigInt.fromI32(1)
export let ZERO_BD = BigDecimal.fromString('0')
export let ONE_BD = BigDecimal.fromString('1')
export let BI_18 = BigInt.fromI32(18)
export let SATOSHI_MULTIPLIER = BigInt.fromI64(10000000000);