/**
 * AES-128（ECB / CBC，PKCS#7 或 NoPadding）的纯 JS 同步实现。
 *
 * 为什么不用 WebCrypto：扩展沙箱的宿主函数 `utils_aes_encrypt` /
 * (`extensionService/vm/hostContext/hostFuncs.ts:132,153`) 是**同步**调用点，
 * 而 WebCrypto 只有异步 API；把它们改成异步会破坏 QuickJS → 宿主的同步边界。
 *
 * 覆盖范围：上游 `AES_MODE` 只用到 `aes-128-cbc`（PKCS7）与 `aes-128-ecb`（NoPadding）。
 * 实现已由 `scripts/smoke.mjs` 与 Node `crypto` 逐字节比对验证。
 */

const SBOX = Uint8Array.from([
  0x63, 0x7c, 0x77, 0x7b, 0xf2, 0x6b, 0x6f, 0xc5, 0x30, 0x01, 0x67, 0x2b, 0xfe, 0xd7, 0xab, 0x76, 0xca, 0x82, 0xc9,
  0x7d, 0xfa, 0x59, 0x47, 0xf0, 0xad, 0xd4, 0xa2, 0xaf, 0x9c, 0xa4, 0x72, 0xc0, 0xb7, 0xfd, 0x93, 0x26, 0x36, 0x3f,
  0xf7, 0xcc, 0x34, 0xa5, 0xe5, 0xf1, 0x71, 0xd8, 0x31, 0x15, 0x04, 0xc7, 0x23, 0xc3, 0x18, 0x96, 0x05, 0x9a, 0x07,
  0x12, 0x80, 0xe2, 0xeb, 0x27, 0xb2, 0x75, 0x09, 0x83, 0x2c, 0x1a, 0x1b, 0x6e, 0x5a, 0xa0, 0x52, 0x3b, 0xd6, 0xb3,
  0x29, 0xe3, 0x2f, 0x84, 0x53, 0xd1, 0x00, 0xed, 0x20, 0xfc, 0xb1, 0x5b, 0x6a, 0xcb, 0xbe, 0x39, 0x4a, 0x4c, 0x58,
  0xcf, 0xd0, 0xef, 0xaa, 0xfb, 0x43, 0x4d, 0x33, 0x85, 0x45, 0xf9, 0x02, 0x7f, 0x50, 0x3c, 0x9f, 0xa8, 0x51, 0xa3,
  0x40, 0x8f, 0x92, 0x9d, 0x38, 0xf5, 0xbc, 0xb6, 0xda, 0x21, 0x10, 0xff, 0xf3, 0xd2, 0xcd, 0x0c, 0x13, 0xec, 0x5f,
  0x97, 0x44, 0x17, 0xc4, 0xa7, 0x7e, 0x3d, 0x64, 0x5d, 0x19, 0x73, 0x60, 0x81, 0x4f, 0xdc, 0x22, 0x2a, 0x90, 0x88,
  0x46, 0xee, 0xb8, 0x14, 0xde, 0x5e, 0x0b, 0xdb, 0xe0, 0x32, 0x3a, 0x0a, 0x49, 0x06, 0x24, 0x5c, 0xc2, 0xd3, 0xac,
  0x62, 0x91, 0x95, 0xe4, 0x79, 0xe7, 0xc8, 0x37, 0x6d, 0x8d, 0xd5, 0x4e, 0xa9, 0x6c, 0x56, 0xf4, 0xea, 0x65, 0x7a,
  0xae, 0x08, 0xba, 0x78, 0x25, 0x2e, 0x1c, 0xa6, 0xb4, 0xc6, 0xe8, 0xdd, 0x74, 0x1f, 0x4b, 0xbd, 0x8b, 0x8a, 0x70,
  0x3e, 0xb5, 0x66, 0x48, 0x03, 0xf6, 0x0e, 0x61, 0x35, 0x57, 0xb9, 0x86, 0xc1, 0x1d, 0x9e, 0xe1, 0xf8, 0x98, 0x11,
  0x69, 0xd9, 0x8e, 0x94, 0x9b, 0x1e, 0x87, 0xe9, 0xce, 0x55, 0x28, 0xdf, 0x8c, 0xa1, 0x89, 0x0d, 0xbf, 0xe6, 0x42,
  0x68, 0x41, 0x99, 0x2d, 0x0f, 0xb0, 0x54, 0xbb, 0x16,
])

const INV_SBOX = new Uint8Array(256)
for (let i = 0; i < 256; i++) INV_SBOX[SBOX[i]!] = i

const RCON = Uint8Array.from([0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80, 0x1b, 0x36])

const BLOCK_SIZE = 16
const ROUNDS = 10

function xtime(a: number): number {
  return ((a << 1) ^ (a & 0x80 ? 0x1b : 0)) & 0xff
}

function gmul(a: number, b: number): number {
  let p = 0
  let x = a
  let y = b
  for (let i = 0; i < 8; i++) {
    if (y & 1) p ^= x
    x = xtime(x)
    y >>>= 1
  }
  return p & 0xff
}

export type AesMode = 'aes-128-ecb' | 'aes-128-cbc'

function expandKey128(key: Uint8Array): Uint8Array {
  if (key.length !== 16) throw new Error(`AES-128 requires a 16-byte key, got ${key.length}`)
  const w = new Uint8Array(176)
  w.set(key)
  for (let i = 4; i < 44; i++) {
    const offset = i * 4
    let t0 = w[offset - 4]!
    let t1 = w[offset - 3]!
    let t2 = w[offset - 2]!
    let t3 = w[offset - 1]!
    if (i % 4 === 0) {
      const tmp = t0
      t0 = SBOX[t1]! ^ RCON[i / 4 - 1]!
      t1 = SBOX[t2]!
      t2 = SBOX[t3]!
      t3 = SBOX[tmp]!
    }
    w[offset] = w[offset - 16]! ^ t0
    w[offset + 1] = w[offset - 15]! ^ t1
    w[offset + 2] = w[offset - 14]! ^ t2
    w[offset + 3] = w[offset - 13]! ^ t3
  }
  return w
}

function addRoundKey(state: Uint8Array, w: Uint8Array, round: number): void {
  const offset = round * 16
  for (let i = 0; i < 16; i++) state[i] = state[i]! ^ w[offset + i]!
}

function subBytes(state: Uint8Array): void {
  for (let i = 0; i < 16; i++) state[i] = SBOX[state[i]!]!
}

function invSubBytes(state: Uint8Array): void {
  for (let i = 0; i < 16; i++) state[i] = INV_SBOX[state[i]!]!
}

function shiftRows(state: Uint8Array): void {
  // state 列主序：state[r + 4c]
  for (let r = 1; r < 4; r++) {
    const row = [state[r]!, state[r + 4]!, state[r + 8]!, state[r + 12]!]
    for (let c = 0; c < 4; c++) state[r + 4 * c] = row[(c + r) % 4]!
  }
}

function invShiftRows(state: Uint8Array): void {
  for (let r = 1; r < 4; r++) {
    const row = [state[r]!, state[r + 4]!, state[r + 8]!, state[r + 12]!]
    for (let c = 0; c < 4; c++) state[r + 4 * c] = row[(c - r + 4) % 4]!
  }
}

function mixColumns(state: Uint8Array): void {
  for (let c = 0; c < 4; c++) {
    const i = c * 4
    const a0 = state[i]!
    const a1 = state[i + 1]!
    const a2 = state[i + 2]!
    const a3 = state[i + 3]!
    state[i] = gmul(a0, 2) ^ gmul(a1, 3) ^ a2 ^ a3
    state[i + 1] = a0 ^ gmul(a1, 2) ^ gmul(a2, 3) ^ a3
    state[i + 2] = a0 ^ a1 ^ gmul(a2, 2) ^ gmul(a3, 3)
    state[i + 3] = gmul(a0, 3) ^ a1 ^ a2 ^ gmul(a3, 2)
  }
}

function invMixColumns(state: Uint8Array): void {
  for (let c = 0; c < 4; c++) {
    const i = c * 4
    const a0 = state[i]!
    const a1 = state[i + 1]!
    const a2 = state[i + 2]!
    const a3 = state[i + 3]!
    state[i] = gmul(a0, 14) ^ gmul(a1, 11) ^ gmul(a2, 13) ^ gmul(a3, 9)
    state[i + 1] = gmul(a0, 9) ^ gmul(a1, 14) ^ gmul(a2, 11) ^ gmul(a3, 13)
    state[i + 2] = gmul(a0, 13) ^ gmul(a1, 9) ^ gmul(a2, 14) ^ gmul(a3, 11)
    state[i + 3] = gmul(a0, 11) ^ gmul(a1, 13) ^ gmul(a2, 9) ^ gmul(a3, 14)
  }
}

function encryptBlock(block: Uint8Array, w: Uint8Array): void {
  addRoundKey(block, w, 0)
  for (let round = 1; round < ROUNDS; round++) {
    subBytes(block)
    shiftRows(block)
    mixColumns(block)
    addRoundKey(block, w, round)
  }
  subBytes(block)
  shiftRows(block)
  addRoundKey(block, w, ROUNDS)
}

function decryptBlock(block: Uint8Array, w: Uint8Array): void {
  addRoundKey(block, w, ROUNDS)
  for (let round = ROUNDS - 1; round >= 1; round--) {
    invShiftRows(block)
    invSubBytes(block)
    addRoundKey(block, w, round)
    invMixColumns(block)
  }
  invShiftRows(block)
  invSubBytes(block)
  addRoundKey(block, w, 0)
}

function pkcs7Pad(data: Uint8Array): Uint8Array {
  const padLength = BLOCK_SIZE - (data.length % BLOCK_SIZE)
  const out = new Uint8Array(data.length + padLength)
  out.set(data)
  out.fill(padLength, data.length)
  return out
}

function pkcs7Unpad(data: Uint8Array): Uint8Array {
  if (data.length === 0 || data.length % BLOCK_SIZE !== 0) throw new Error('invalid ciphertext length')
  const padLength = data[data.length - 1]!
  if (padLength < 1 || padLength > BLOCK_SIZE) throw new Error('invalid padding')
  for (let i = data.length - padLength; i < data.length; i++) {
    if (data[i] !== padLength) throw new Error('invalid padding')
  }
  return data.subarray(0, data.length - padLength)
}

export interface AesOptions {
  /** true = PKCS#7 填充；false = NoPadding（输入必须是 16 的整数倍） */
  padding: boolean
}

export function aesEncrypt(mode: AesMode, key: Uint8Array, iv: Uint8Array, data: Uint8Array, opts: AesOptions): Uint8Array {
  const w = expandKey128(key)
  const cbc = mode === 'aes-128-cbc'
  if (cbc && iv.length !== BLOCK_SIZE) throw new Error(`CBC requires a 16-byte iv, got ${iv.length}`)
  const input = opts.padding ? pkcs7Pad(data) : data
  if (input.length % BLOCK_SIZE !== 0) throw new Error('data length must be a multiple of 16 when padding is disabled')

  const out = new Uint8Array(input.length)
  let prev = cbc ? iv.slice(0, BLOCK_SIZE) : null
  for (let offset = 0; offset < input.length; offset += BLOCK_SIZE) {
    const block = input.slice(offset, offset + BLOCK_SIZE)
    if (prev) for (let i = 0; i < BLOCK_SIZE; i++) block[i] = block[i]! ^ prev[i]!
    encryptBlock(block, w)
    out.set(block, offset)
    if (prev) prev = block
  }
  return out
}

export function aesDecrypt(mode: AesMode, key: Uint8Array, iv: Uint8Array, data: Uint8Array, opts: AesOptions): Uint8Array {
  const w = expandKey128(key)
  const cbc = mode === 'aes-128-cbc'
  if (cbc && iv.length !== BLOCK_SIZE) throw new Error(`CBC requires a 16-byte iv, got ${iv.length}`)
  if (data.length % BLOCK_SIZE !== 0) throw new Error('ciphertext length must be a multiple of 16')

  const out = new Uint8Array(data.length)
  let prev = cbc ? iv.slice(0, BLOCK_SIZE) : null
  for (let offset = 0; offset < data.length; offset += BLOCK_SIZE) {
    const cipherBlock = data.slice(offset, offset + BLOCK_SIZE)
    const block = cipherBlock.slice()
    decryptBlock(block, w)
    if (prev) for (let i = 0; i < BLOCK_SIZE; i++) block[i] = block[i]! ^ prev[i]!
    out.set(block, offset)
    if (prev) prev = cipherBlock
  }
  return opts.padding ? pkcs7Unpad(out) : out
}
