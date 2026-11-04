/**
 * Util worker 入口。
 *
 * 承载 `@any-listen/app/modules/worker/utilService`（音乐元数据解析、文件操作、网络等"重活"）。
 * 之所以单独一个 worker：这层要做 `music-metadata` 解析（CPU 密集）与大批量文件遍历，
 * 放 core-worker 会拖慢 IPC 响应（arch §3.0 的线程拓扑约束）。
 */

import '../shims/globals'

import '@any-listen/app/modules/worker/utilService/index'
