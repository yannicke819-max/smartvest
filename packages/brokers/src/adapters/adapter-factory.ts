import type { BrokerProvider } from '@smartvest/domain';
import { IBrokerAdapter, NotSupportedError } from './broker-adapter.interface';
import { ManualAdapter } from './manual.adapter';
import { InteractiveBrokersAdapter } from './interactive-brokers.adapter';
import { SaxoAdapter } from './saxo.adapter';
import { DegiroAdapter } from './degiro.adapter';
import { Trading212Adapter } from './trading212.adapter';

/**
 * Minimal set of feature flags the factory reads. Runs a per-provider check
 * BEFORE instantiating the adapter — throws cleanly when the flag is off so
 * no live HTTP call is ever attempted.
 *
 * MANUAL is always available (no flag gate).
 */
export interface AdapterFactoryFlags {
  BROKER_CONNECTIONS_ENABLED: boolean;
  BROKER_ADAPTER_IB_ENABLED: boolean;
  BROKER_ADAPTER_SAXO_ENABLED: boolean;
  BROKER_ADAPTER_DEGIRO_ENABLED: boolean;
  BROKER_ADAPTER_TRADING212_ENABLED: boolean;
}

export function createBrokerAdapter(
  provider: BrokerProvider,
  flags: AdapterFactoryFlags,
): IBrokerAdapter {
  if (!flags.BROKER_CONNECTIONS_ENABLED) {
    throw new NotSupportedError('Module broker désactivé (BROKER_CONNECTIONS_ENABLED=false)');
  }

  switch (provider) {
    case 'MANUAL':
      return new ManualAdapter();
    case 'INTERACTIVE_BROKERS':
      if (!flags.BROKER_ADAPTER_IB_ENABLED) {
        throw new NotSupportedError('Adapter IB désactivé (BROKER_ADAPTER_IB_ENABLED=false)');
      }
      return new InteractiveBrokersAdapter();
    case 'SAXO':
      if (!flags.BROKER_ADAPTER_SAXO_ENABLED) {
        throw new NotSupportedError('Adapter Saxo désactivé');
      }
      return new SaxoAdapter();
    case 'DEGIRO':
      // DeGiro adapter is intentionally a stub that redirects to CSV import.
      // We instantiate it regardless of the flag so the error message is friendly.
      return new DegiroAdapter();
    case 'TRADING212':
      if (!flags.BROKER_ADAPTER_TRADING212_ENABLED) {
        throw new NotSupportedError('Adapter T212 désactivé');
      }
      return new Trading212Adapter();
    case 'BOURSE_DIRECT':
    case 'FORTUNEO':
    case 'TRADE_REPUBLIC':
    case 'ETORO':
    case 'REVOLUT':
      throw new NotSupportedError(
        `${provider} n'expose pas d'API retail publique — utilisez l'import CSV via /imports.`,
      );
    case 'BINANCE':
    case 'KRAKEN':
    case 'COINBASE':
    case 'CRYPTO_COM':
      // Exchanges crypto : APIs existantes mais adapters live pas livrés ici.
      // Phase ultérieure — en attendant, import CSV.
      throw new NotSupportedError(
        `Adapter ${provider} pas encore livré. Utilisez l'import CSV via /imports en attendant.`,
      );
    default: {
      const _exhaustive: never = provider;
      throw new NotSupportedError(`Provider inconnu : ${_exhaustive as string}`);
    }
  }
}
