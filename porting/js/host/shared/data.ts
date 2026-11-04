/**
 * `@/shared/data` 的 Android 替身。
 *
 * 上游持久化 serverInfo.json / clientInfo.json（多用户 web 服务的会话体系）。
 * Android 是**单机单用户**（PDR-001），登录/多设备毫无意义（R-16），因此：
 * - serverId / tokenSecret 只保留在内存（用于日志与扩展 API 的稳定标识）
 * - 登录设备列表恒为空
 */

import { randomBytes, randomUUID } from '@any-listen/nodejs'

import { appState } from '@porting/host/app/app'

interface ServerInfo {
  serverId: string
  tokenSecret: string
  version: number
}

const serverInfo: ServerInfo = {
  serverId: randomUUID(),
  // 上游用 32 字节随机数的 hex（`randomBytes(32).toString('hex')`）作为 token 签名密钥。
  // 单机模式下它只用于扩展 API 的稳定标识，长度保持一致以免下游做长度校验时出错。
  tokenSecret: Buffer.from(randomBytes(32)).toString('hex'),
  version: 1,
}

export const initServerData = (): void => {
  /* 单用户模式：会话信息驻留内存即可，无需落盘 */
}

export const getServerId = (): string => serverInfo.serverId

export const getServerName = (): string => 'any-listen'

export const getTokenSecret = (): string => serverInfo.tokenSecret

export const getVersion = (): number => serverInfo.version

export const setVersion = (version: number): void => {
  serverInfo.version = version
}

export const getLoginPassword = (): string => ''

export interface ClientInfo {
  clientId: string
  timestamp: number
  lastActive: number
  userAgent: string
  ip: string
}

const clientInfos: ClientInfo[] = []

export const createClientInfo = (): ClientInfo => ({
  clientId: randomUUID(),
  timestamp: Date.now(),
  lastActive: Date.now(),
  userAgent: 'android-webview',
  ip: '127.0.0.1',
})

export const saveClientInfo = (info: ClientInfo): void => {
  clientInfos.push(info)
}

export const updateLastActive = (id: string, ip: string, userAgent: string): void => {
  const target = clientInfos.find((info) => info.clientId === id)
  if (!target) return
  target.lastActive = Date.now()
  target.ip = ip
  target.userAgent = userAgent
}

export const getClientInfos = (): ClientInfo[] => clientInfos

export const removeClientInfo = (id: string): void => {
  const index = clientInfos.findIndex((info) => info.clientId === id)
  if (index !== -1) clientInfos.splice(index, 1)
}

export const checkClientInfo = (id: string): boolean => clientInfos.some((info) => info.clientId === id)

/** 当前 WebView 的 machineId（`appState` 在 app/index.ts 初始化） */
export const getMachineId = (): string => appState.machineId
