/**
 * `node:crypto` 替身。
 *
 * 分工（Phase 2 §3.0 的量化表）：
 * - 哈希：`@noble/hashes`（纯 JS、同步、可增量的 `createHash`）—— 上游 `toMD5/toSha1/toSha256/toSha512`
 *   是**同步** API，WebCrypto 的 async 签名无法满足。
 * - AES：`./aes.ts` 自实现（同步边界要求，见该文件注释）。
 * - RSA：`node-forge`（PKCS#1 v1.5 验签 / OAEP-SHA1 加密 / NoPadding 加解密，全部同步）。
 * - UUID / 随机字节：`globalThis.crypto`。
 *
 * 之所以不直接全用 WebCrypto：`verifySignature()`（`extensionService/shared/index.ts:257`）在
 * `if (!verifySignature(...))` 里同步取布尔值，改成 Promise 会破坏扩展验签流程。
 */

import { md5, sha1 } from '@noble/hashes/legacy'
import { sha256, sha512 } from '@noble/hashes/sha2'
import { bytesToHex } from '@noble/hashes/utils'
import forge from 'node-forge'

import { aesDecrypt, aesEncrypt, type AesMode } from '@porting/shims/aes'
import { Buffer } from '@porting/shims/buffer'

/* ------------------------------- 基础 ------------------------------- */

export const constants = {
  RSA_PKCS1_PADDING: 1,
  RSA_PKCS1_OAEP_PADDING: 4,
  RSA_NO_PADDING: 3,
  RSA_PKCS1_OAEP_PADDING_SHA1: 4,
} as const

function toBytes(data: string | Uint8Array | ArrayBuffer): Uint8Array {
  if (typeof data === 'string') return Buffer.from(data)
  if (data instanceof Uint8Array) return data
  return new Uint8Array(data)
}

function toBinaryString(data: Uint8Array): string {
  let out = ''
  const chunk = 0x8000
  for (let i = 0; i < data.length; i += chunk) {
    out += String.fromCharCode(...data.subarray(i, i + chunk))
  }
  return out
}

function fromBinaryString(str: string): Uint8Array {
  const out = new Uint8Array(str.length)
  for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) & 0xff
  return out
}

/* ------------------------------- 随机 ------------------------------- */

function getWebCrypto(): Crypto {
  const c = globalThis.crypto
  if (!c) throw new Error('WebCrypto is not available in this environment')
  return c
}

export function randomUUID(): string {
  const c = globalThis.crypto
  if (c && typeof c.randomUUID === 'function') return c.randomUUID()
  const bytes = randomBytes(16)
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export function randomBytes(size: number): Buffer {
  const out = new Uint8Array(size)
  getWebCrypto().getRandomValues(out)
  return Buffer.from(out.buffer, out.byteOffset, out.byteLength)
}

/* ------------------------------- 哈希 ------------------------------- */

type HashName = 'md5' | 'sha1' | 'sha256' | 'sha512'

interface NobleHash {
  create(): { update(data: Uint8Array): unknown; digest(): Uint8Array }
}

const HASHERS: Record<HashName, NobleHash> = {
  md5: md5 as unknown as NobleHash,
  sha1: sha1 as unknown as NobleHash,
  sha256: sha256 as unknown as NobleHash,
  sha512: sha512 as unknown as NobleHash,
}

export interface Hash {
  update(data: string | Uint8Array | ArrayBuffer, inputEncoding?: BufferEncoding): Hash
  /**
   * 与 Node 一致的重载：给了 `'hex'`/`'base64'` 就返回 `string`，不给返回 `Buffer`。
   * 少了这层重载，`digest('hex')` 的调用方会拿到 `Buffer | string`，
   * 上游 `toMD5()` 之类的函数签名（`=> string`）就过不了类型检查。
   */
  digest(encoding: 'hex' | 'base64'): string
  digest(): Buffer
  digest(encoding?: 'hex' | 'base64'): string | Buffer
  copy(): Hash
}

function normalizeHashName(algorithm: string): HashName {
  const name = algorithm.toLowerCase().replace('-', '')
  if (name === 'md5' || name === 'sha1' || name === 'sha256' || name === 'sha512') return name
  throw new Error(`unsupported hash algorithm: ${algorithm}`)
}

export function createHash(algorithm: string): Hash {
  const impl = HASHERS[normalizeHashName(algorithm)].create()
  let finished = false

  /**
   * 实现体只写一份，签名用 `Hash['digest']`（含重载）覆盖。
   * 直接写对象方法时 TS 不会把实现签名匹配到重载组，会报 TS2322。
   */
  const digestImpl = (encoding?: 'hex' | 'base64'): string | Buffer => {
    if (finished) throw new Error('digest already called')
    finished = true
    const result = impl.digest()
    if (encoding === 'hex') return bytesToHex(result)
    if (encoding === 'base64') return Buffer.from(result.buffer, result.byteOffset, result.byteLength).toString('base64')
    return Buffer.from(result.buffer, result.byteOffset, result.byteLength)
  }

  const instance: Hash = {
    update(data) {
      if (finished) throw new Error('digest already called')
      impl.update(toBytes(data))
      return instance
    },
    digest: digestImpl as Hash['digest'],
    copy() {
      throw new Error('Hash.copy() is not supported by the Android shim')
    },
  }
  return instance
}

/* -------------------------------- AES -------------------------------- */

interface CipherLike {
  update(data: Uint8Array | string): Buffer
  final(): Buffer
}

function normalizeAesMode(algorithm: string): { mode: AesMode; padding: boolean } {
  const name = algorithm.toLowerCase()
  // 上游 `AES_MODE` 只有这两个（hostFuncs.ts:117-120）
  if (name === 'aes-128-cbc' || name === 'aes-192-cbc' || name === 'aes-256-cbc') {
    return { mode: 'aes-128-cbc', padding: true }
  }
  if (name === 'aes-128-ecb' || name === 'aes-192-ecb' || name === 'aes-256-ecb') {
    // 命名写 NoPadding，但上游调用 `createCipheriv` 时未关闭 autoPadding，
    // 因此 Node 侧实际行为是 PKCS#7 —— 这里必须与可观察行为一致。
    return { mode: 'aes-128-ecb', padding: true }
  }
  throw new Error(`unsupported cipher: ${algorithm}`)
}

function createCipher(mode: AesMode, key: Uint8Array, iv: Uint8Array, encrypt: boolean): CipherLike {
  const chunks: Uint8Array[] = []
  let finished = false
  return {
    update(data) {
      if (finished) throw new Error('cipher already finalized')
      chunks.push(toBytes(data))
      return Buffer.alloc(0)
    },
    final() {
      if (finished) throw new Error('cipher already finalized')
      finished = true
      const total = chunks.reduce((sum, c) => sum + c.length, 0)
      const input = new Uint8Array(total)
      let offset = 0
      for (const chunk of chunks) {
        input.set(chunk, offset)
        offset += chunk.length
      }
      const out = encrypt
        ? aesEncrypt(mode, key, iv, input, { padding: true })
        : aesDecrypt(mode, key, iv, input, { padding: true })
      return Buffer.from(out.buffer, out.byteOffset, out.byteLength)
    },
  }
}

export function createCipheriv(algorithm: string, key: Uint8Array, iv?: Uint8Array | null): CipherLike {
  const { mode } = normalizeAesMode(algorithm)
  return createCipher(mode, toBytes(key), iv ? toBytes(iv) : new Uint8Array(16), true)
}

export function createDecipheriv(algorithm: string, key: Uint8Array, iv?: Uint8Array | null): CipherLike {
  const { mode } = normalizeAesMode(algorithm)
  return createCipher(mode, toBytes(key), iv ? toBytes(iv) : new Uint8Array(16), false)
}

/* -------------------------------- RSA -------------------------------- */

function loadPublicKey(key: Uint8Array | string): forge.pki.rsa.PublicKey {
  const text = typeof key === 'string' ? key : Buffer.from(key).toString('utf8')
  if (text.includes('BEGIN')) return forge.pki.publicKeyFromPem(text) as forge.pki.rsa.PublicKey
  const der = typeof key === 'string' ? Buffer.from(key, 'binary') : key
  return forge.pki.publicKeyFromAsn1(forge.asn1.fromDer(toBinaryString(der))) as forge.pki.rsa.PublicKey
}

function loadPrivateKey(key: Uint8Array | string): forge.pki.rsa.PrivateKey {
  const text = typeof key === 'string' ? key : Buffer.from(key).toString('utf8')
  if (text.includes('BEGIN')) return forge.pki.privateKeyFromPem(text) as forge.pki.rsa.PrivateKey
  const der = typeof key === 'string' ? Buffer.from(key, 'binary') : key
  return forge.pki.privateKeyFromAsn1(forge.asn1.fromDer(toBinaryString(der))) as forge.pki.rsa.PrivateKey
}

/** node-forge 的 encrypt/decrypt 第二参联合类型（@types 里没导出名字，从函数签名反推） */
type ForgeEncryptionScheme = Parameters<forge.pki.rsa.PublicKey["encrypt"]>[1]

export interface PublicEncryptOptions {
  key: Uint8Array | string
  padding: number
}

export function publicEncrypt(options: PublicEncryptOptions, data: Uint8Array | string): Buffer {
  const key = loadPublicKey(options.key)
  const input = toBytes(data)
  let encrypted: string
  if (options.padding === constants.RSA_PKCS1_OAEP_PADDING) {
    encrypted = key.encrypt(toBinaryString(input), 'RSA-OAEP', { md: forge.md.sha1.create() })
  } else if (options.padding === constants.RSA_NO_PADDING) {
    encrypted = key.encrypt(toBinaryString(input))
  } else {
    encrypted = key.encrypt(toBinaryString(input), 'RSA-PKCS1-V1_5' as ForgeEncryptionScheme)
  }
  return Buffer.from(fromBinaryString(encrypted).buffer)
}

export function privateDecrypt(options: PublicEncryptOptions, data: Uint8Array | string): Buffer {
  const key = loadPrivateKey(options.key)
  const input = toBytes(data)
  let decrypted: string
  if (options.padding === constants.RSA_PKCS1_OAEP_PADDING) {
    decrypted = key.decrypt(toBinaryString(input), 'RSA-OAEP', { md: forge.md.sha1.create() })
  } else if (options.padding === constants.RSA_NO_PADDING) {
    decrypted = key.decrypt(toBinaryString(input))
  } else {
    decrypted = key.decrypt(toBinaryString(input), 'RSA-PKCS1-V1_5' as ForgeEncryptionScheme)
  }
  const bytes = fromBinaryString(decrypted)
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}

interface SignerLike {
  update(data: Uint8Array | string): SignerLike
  end(): void
  sign(privateKey: Uint8Array | string, outputEncoding?: 'hex'): string | Buffer
}

interface VerifierLike {
  update(data: Uint8Array | string): VerifierLike
  end(): void
  verify(publicKey: Uint8Array | string, signature: Uint8Array | string, signatureEncoding?: 'hex'): boolean
}

function digestForSign(algorithm: string, data: Uint8Array): forge.md.MessageDigest {
  const md = algorithm.toLowerCase().replace('-', '')
  const digest =
    md === 'sha256' ? forge.md.sha256.create() : md === 'sha1' ? forge.md.sha1.create() : forge.md.sha512.create()
  digest.update(toBinaryString(data))
  return digest
}

export function createSign(algorithm: string): SignerLike {
  const chunks: Uint8Array[] = []
  const signer: SignerLike = {
    update(data) {
      chunks.push(toBytes(data))
      return signer
    },
    end() {
      /* Node 语义：end() 之后才能 sign()，这里无需额外动作 */
    },
    sign(privateKey, outputEncoding) {
      const key = loadPrivateKey(privateKey)
      const digest = digestForSign(algorithm, concatBytes(chunks))
      const signature = (key as { sign(md: forge.md.MessageDigest): string }).sign(digest)
      const bytes = fromBinaryString(signature)
      const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      return outputEncoding === 'hex' ? buf.toString('hex') : buf
    },
  }
  return signer
}

export function createVerify(algorithm: string): VerifierLike {
  const chunks: Uint8Array[] = []
  const verifier: VerifierLike = {
    update(data) {
      chunks.push(toBytes(data))
      return verifier
    },
    end() {
      /* no-op */
    },
    verify(publicKey, signature, signatureEncoding) {
      const key = loadPublicKey(publicKey)
      const digest = digestForSign(algorithm, concatBytes(chunks))
      const sigBytes = typeof signature === 'string' && signatureEncoding === 'hex'
        ? fromBinaryString(Buffer.from(signature, 'hex').toString('binary'))
        : toBytes(signature)
      return key.verify(digest.digest().getBytes(), toBinaryString(sigBytes))
    },
  }
  return verifier
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, c) => sum + c.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

export const webcrypto = (): Crypto => getWebCrypto()

export default {
  constants,
  randomUUID,
  randomBytes,
  createHash,
  createCipheriv,
  createDecipheriv,
  publicEncrypt,
  privateDecrypt,
  createSign,
  createVerify,
  webcrypto,
}
