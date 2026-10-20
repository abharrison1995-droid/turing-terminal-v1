import type { ProviderServiceId } from '../../../shared/providerServices';

/**
 * A request from another page to open one part of Settings. It carries no workflow data: the draft being edited stays in
 * the workflow draft store, and `returnTo` only lets Settings offer a way back.
 */
export type SettingsIntent =
  | { target: 'providers'; serviceId?: ProviderServiceId; returnTo?: 'workflows' }
  | { target: 'openrouter'; returnTo?: 'workflows' };
