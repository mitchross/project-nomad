import Service from '#models/service'
import type { ServiceIntegration } from '../app/services/service_integration/types.js'

export type ServiceSlim = Pick<
  Service,
  | 'id'
  | 'service_name'
  | 'installed'
  | 'installation_status'
  | 'ui_location'
  | 'custom_url'
  | 'friendly_name'
  | 'description'
  | 'icon'
  | 'powered_by'
  | 'display_order'
  | 'container_image'
  | 'available_update_version'
  | 'auto_update_enabled'
  | 'is_custom'
  | 'is_user_modified'
  | 'is_deprecated'
  | 'category'
> & {
  status?: string
  /**
   * Per-service integration descriptor (ownership, availability, endpoints,
   * capabilities) — computed server-side, never persisted. See
   * app/services/service_integration/. UI consumption lands in the Supply
   * Depot capability work; until then this field is additive.
   */
  integration?: ServiceIntegration
}
