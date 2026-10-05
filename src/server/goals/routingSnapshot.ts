import type { Db } from '../db.js';
import { allProviders } from '../modelCatalog.js';
import { SecretStore, secretRef } from '../secretStore.js';
import { toConnectionProfile } from '../serialize.js';
import type { ProfileObservation, RouteSnapshot } from './routeIdentity.js';

/**
 * The live provider/profile observation the routing authority reads (Stage 5B). It goes through the same provider
 * infrastructure every run uses (`allProviders`) and reduces credentials to ONE boolean per profile: whether the stored
 * inference credential this backend needs is present. The secret itself is never read into the snapshot.
 */
export function observeProfiles(db: Db): ProfileObservation[] {
  const secrets = SecretStore.forDatabase(db);
  return (db.prepare('SELECT * FROM connection_profiles ORDER BY id').all() as Array<Record<string, unknown>>)
    .map(toConnectionProfile)
    .map((profile) => ({
      // Only a keyed backend needs a stored credential; CLI-subscription backends authenticate outside Turing.
      credentialReady:
        profile.backendId === 'openrouter' ? secrets.has(secretRef(profile.id, 'inference')) : true,
      // The credential store reference is metadata of the profile row, not part of the observation the resolver sees.
      profile: { ...profile, credentialStoreRef: null, metadata: {} },
    }));
}

export async function observeRouteSnapshot(db: Db): Promise<RouteSnapshot> {
  return { providers: await allProviders(db), profiles: observeProfiles(db) };
}
