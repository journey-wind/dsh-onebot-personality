import { defineDomain } from '@deepseek-ai/dsh-storage-domain';
import type { DomainFacility } from '@deepseek-ai/dsh-storage-domain';
import { controlSchema, emptyControlState, emptyLedger, ledgerSchema } from './model.js';
import { ControlRepository, StorageError } from './repository.js';
import type { OwnerIdentity } from './repository.js';

/** Keep the ledger outside any body-backup rollback set; separate names alone do not ensure that. */
// SDK UNIT_NAME_RE is /^[a-z][a-z0-9_]*$/. These IDs have never been deployed by this development bundle.
export const CONTROL_DOMAIN = 'onebot_personality_control';
export const LEDGER_DOMAIN = 'onebot_personality_deletion_ledger';
export const controlDomainSpec = defineDomain({
  name: CONTROL_DOMAIN, version: 1, layout: 'single',
  global: { schema: controlSchema, initial: emptyControlState() }, tables: {},
});
export const deletionLedgerSpec = defineDomain({
  name: LEDGER_DOMAIN, version: 1, layout: 'single',
  global: { schema: ledgerSchema, initial: emptyLedger() }, tables: {},
});

/**
 * Uses public storageDomain handles only. The caller must independently verify durable backend
 * routes and acquire the dedicated exclusive owner lock before invoking this function.
 * This module never opens knowledge's database and never closes an injected shared service.
 */
export async function openDomains(facility: Pick<DomainFacility, 'open'>, owner: OwnerIdentity, isLive: () => boolean = () => true) {
  const live = () => { try { return isLive() === true; } catch { return false; } };
  const check = () => { if (!owner.isHeld()) throw new StorageError('owner-lock-required');
    if (!live()) throw new StorageError('domain-startup-cancelled'); };
  check();
  const ledger = await facility.open(deletionLedgerSpec);
  try {
    check();
    const control = await facility.open(controlDomainSpec);
    try {
      check();
      const repository = await ControlRepository.open(control.global, ledger.global, owner);
      if (!live()) { await repository.close(); throw new StorageError('domain-startup-cancelled'); }
      let closed = false;
      return {
        repository,
        async close(): Promise<void> {
          if (closed) return;
          closed = true;
          try { await repository.close(); }
          finally {
            try { await control.close(); }
            finally { await ledger.close(); }
          }
        },
      };
    } catch (error) {
      await control.close();
      throw error;
    }
  } catch (error) {
    await ledger.close();
    throw error;
  }
}
