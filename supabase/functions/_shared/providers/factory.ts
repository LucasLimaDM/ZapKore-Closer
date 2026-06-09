import { EvolutionProvider } from './evolution.ts'
import { ZapiProvider } from './zapi.ts'
import type { WhatsAppProvider } from './types.ts'

export interface ProviderIntegration {
  provider?: string | null
  evolution_api_url?: string | null
  evolution_api_key?: string | null
  instance_name?: string | null
  zapi_instance_id?: string | null
  zapi_instance_token?: string | null
  zapi_client_token?: string | null
}

export function getProvider(integration: ProviderIntegration): WhatsAppProvider {
  const provider = integration.provider ?? 'evolution'

  if (provider === 'zapi') {
    if (!integration.zapi_instance_id || !integration.zapi_instance_token || !integration.zapi_client_token) {
      throw new Error('Z-API credentials not configured (zapi_instance_id, zapi_instance_token, zapi_client_token required)')
    }
    return new ZapiProvider({
      instanceId: integration.zapi_instance_id,
      instanceToken: integration.zapi_instance_token,
      clientToken: integration.zapi_client_token,
    })
  }

  const url = (integration.evolution_api_url || Deno.env.get('EVOLUTION_API_URL') || '').replace(/\/$/, '')
  const key = integration.evolution_api_key || Deno.env.get('EVOLUTION_API_KEY') || ''
  const instance = integration.instance_name || ''
  if (!url || !key || !instance) throw new Error('Evolution credentials not configured')
  return new EvolutionProvider({ url, key, instance })
}
