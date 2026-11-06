import { destroyContext as destroyUpstreamContext } from '@porting-uplink/extension-host-context'
import { contextState } from '@any-listen/app/modules/worker/extensionService/vm/hostContext/state'
import { destroyContext as disposeVmContext, type VmContext } from '@porting/shims/vm'

export * from '@porting-uplink/extension-host-context'

export async function destroyContext(id: string): Promise<void> {
  const state = contextState.vmContexts.get(id)
  await destroyUpstreamContext(id)
  if (state) disposeVmContext(state.vmContext as unknown as VmContext)
}
