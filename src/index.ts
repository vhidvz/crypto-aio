/**
 * `crypto-aio`: the container (`CryptoAio`), the handle (`Blockchain`), the domain model,
 * errors, signers, stores and the extension points for chain family plugins.
 *
 * @module crypto-aio
 */
import { avalanchePlugin } from './adapters/avalanche/plugin';
import { evmPlugin } from './adapters/evm/plugin';
import { solanaPlugin } from './adapters/solana/plugin';
import { tonPlugin } from './adapters/ton/plugin';
import { tronPlugin } from './adapters/tron/plugin';
import { utxoPlugin } from './adapters/utxo/plugin';
import { setBuiltinPlugins } from './core/container/builtins';
import type { Plugin } from './core/registry/plugin';

/** Built-in chain family plugins. Each family plugin module is SDK-free; drivers load lazily. */
const BUILTIN_PLUGINS: readonly Plugin[] = [
  evmPlugin(),
  utxoPlugin(),
  tronPlugin(),
  solanaPlugin(),
  tonPlugin(),
  avalanchePlugin(),
];
setBuiltinPlugins(BUILTIN_PLUGINS);

// Entry points
export { Blockchain } from './core/blockchain/handle';
export type { Balance, NetworkStatus } from './core/blockchain/handle';
export { CryptoAio } from './core/container/container';
export type {
  MonitorApi,
  OperationsApi,
  OperationsFilter,
} from './core/container/container';
export { configure, defaultContainer } from './core/container/default';

// Errors
export { ERROR_CODES } from './core/errors/codes';
export type { CodesOf, ErrorCategory, ErrorCode } from './core/errors/codes';
export {
  ChainError,
  ConfigError,
  CryptoAioError,
  ProviderError,
  SigningError,
  StateError,
  TimeoutError,
  UnsupportedCapabilityError,
  ValidationError,
  createError,
  isCryptoAioError,
} from './core/errors/error';
export type {
  CryptoAioErrorOptions,
  ErrorContext,
  ErrorContextValue,
  SerializedError,
} from './core/errors/error';

// Secrets and signing
export { REDACTED, Secret, isSecret, reveal, secret } from './core/secret/secret';
export { redactDeep, redactUrl } from './core/secret/redact';
export { localSigner } from './core/signing/local';
export type {
  Curve,
  GenerateOptions,
  GeneratedSigner,
  LocalSignerOptions,
  MnemonicSignerOptions,
} from './core/signing/local';
export { callbackSigner } from './core/signing/callback';
export type { CallbackSignerOptions } from './core/signing/callback';
export { deriveXpubChild } from './core/signing/hd';
export type { ExtendedKeyVersions } from './core/signing/hd';
export type { WalletHdOptions } from './core/signing/wallet';
export type {
  KeyRef,
  SignatureBundle,
  Signer,
  SignerTicket,
  SigningContext,
  SigningParams,
  SigningPurpose,
  SigningRequest,
  SigningResult,
} from './core/signing/types';

// Domain model
export { Address } from './core/model/address';
export type { AddressFormatter, NormalizedAddress } from './core/model/address';
export { Amount } from './core/model/amount';
export type { AmountInput } from './core/model/amount';
export { assetId, parseAssetId } from './core/model/asset';
export type {
  AssetId,
  AssetInfo,
  AssetMetadata,
  AssetRef,
  TokenRef,
} from './core/model/asset';
export { KNOWN_CAPABILITIES } from './core/model/capability';
export type { Capability, KnownCapability } from './core/model/capability';
export { explorerUrl } from './core/model/chain';
export type {
  ChainInfo,
  FinalityPolicy,
  NativeAssetInfo,
  NetworkInfo,
} from './core/model/chain';
export { feeTotal } from './core/model/fee';
export type {
  FeeBound,
  FeeCharge,
  FeeChargeDraft,
  FeeEstimate,
  FeeEstimateDraft,
  FeeOverride,
  FeeSpeed,
} from './core/model/fee';
export { Library } from './core/model/ids';
export type {
  ChainId,
  ChainRegistry,
  ExtOf,
  FamilyOf,
  FamilyRegistry,
  KnownLibrary,
  LibraryOf,
  NativeClientMap,
  NetworkOf,
} from './core/model/ids';
export type {
  DriverIntent,
  DriverOutput,
  IntentSummary,
  StoredIntent,
  TransferIntent,
  TransferOutputInput,
} from './core/model/intent';
export { mutuallyExclusive } from './core/model/ordering';
export type { OrderingData, OrderingKind } from './core/model/ordering';
export type {
  AttemptIdKind,
  AttemptRef,
  Block,
  BlockRef,
  Decoding,
  Evidence,
  Finality,
  RawTx,
  ResolvedTransfer,
  SignedTx,
  Transaction,
  Transfer,
  TransferSource,
  TxState,
  TxStatus,
  UnresolvedTransfer,
  UnsignedTx,
} from './core/model/transaction';

// Configuration
export type {
  AioOptions,
  ChainDefaults,
  HandleConfig,
  HandleOptions,
  Hooks,
  LifecycleOptions,
  ProviderConfig,
  ProviderRef,
  ScopeOptions,
  WalletConfig,
} from './core/config/types';

// Lifecycle and observation
export type { TransferOptions } from './core/lifecycle/engine';
export type {
  ConfirmationResult,
  RecoveryReport,
  TxStatusEvent,
  WaitOptions,
  WorkerOptions,
} from './core/lifecycle/monitor';
export type {
  AttemptView,
  OperationView,
  PreparedOperation,
  Submission,
} from './core/lifecycle/views';
// M2: type only; scanners come from `bc.scanner()`.
export type {
  Checkpoint,
  ScanEvent,
  ScanEventBody,
  Scanner,
  ScannerOptions,
} from './core/observe/scanner';

// Extension points: drivers, plugins, presets, schemes, stores, transport, events
export type {
  AdapterManifest,
  AddressCodec,
  AddressHistorySource,
  BlockSource,
  BroadcastResult,
  Broadcaster,
  BuildContext,
  ChainDriver,
  ChainReader,
  DisposableNativeClient,
  DriverBlock,
  DriverContext,
  DriverFactory,
  DriverLimits,
  DriverTransaction,
  DriverTransfer,
  DriverTxObservation,
  FinalityLevel,
  FundsCheck,
  PeerDependency,
  ProofSource,
  ReplacementPolicy,
  ScanFilter,
  SequenceSource,
  TxBuilder,
  WalletKey,
  WalletOptions,
} from './core/driver/types';
export type { Plugin } from './core/registry/plugin';
export type { PresetInput, ProviderPreset } from './core/registry/providers';
export type { AssetRegistration } from './core/registry/assets';
export { BUILTIN_SCHEMES } from './core/registry/schemes';
export type { SignatureScheme, VerifyInput } from './core/registry/schemes';
export {
  MemoryCursorStore,
  MemoryLockManager,
  MemoryOperationStore,
  MemorySequenceStore,
  createMemoryStores,
} from './core/store/memory';
export {
  CLEARABLE_FIELDS,
  DATA_CLASSIFICATION,
  NON_TERMINAL_STATES,
  OPERATION_PATCH_KEYS,
  TERMINAL_STATES,
  isTerminal,
} from './core/store/types';
export type {
  AttemptObservation,
  AttemptPurpose,
  AttemptRecord,
  ClearableField,
  CreateResult,
  CursorStore,
  DataClass,
  ExecutionContext,
  Fence,
  Lease,
  LockManager,
  NewOperation,
  OperationClaim,
  OperationFilter,
  OperationPatch,
  OperationRecord,
  OperationState,
  OperationStore,
  ScanCursor,
  SequenceState,
  SequenceStore,
  StoredCursor,
  Stores,
} from './core/store/types';
export { parseTagged, stringifyTagged } from './core/util/json';
export { PLACEHOLDER_ORIGIN } from './core/transport/types';
export type {
  CallOptions,
  EndpointCall,
  EndpointConfig,
  EndpointState,
  EndpointStatus,
  HealthProbes,
  HttpRequest,
  RequestPurpose,
  RetryClass,
  Transport,
  TransportOptions,
} from './core/transport/types';
export type { AioEvent, AioEventName, AioEvents } from './core/events/types';
export { createLogger, noopLogger } from './core/events/logger';
export type { LogFields, LogLevel, LogWriter, Logger } from './core/events/logger';
export type { Clock } from './core/util/clock';

// Chain families: SDK-free types (spec §5.6). SDK client types are in `crypto-aio/avalanche`,
// `crypto-aio/evm`, `crypto-aio/solana`, `crypto-aio/ton`, `crypto-aio/tron` and
// `crypto-aio/utxo`.
export type { EvmExt, EvmFeeDetails, EvmFeeOverride } from './adapters/evm/types';
export type {
  TronExpiryOrdering,
  TronExt,
  TronFeeDetails,
  TronFeeOverride,
  TronResources,
} from './adapters/tron/types';
export type {
  UtxoAddressType,
  UtxoExt,
  UtxoFeeDetails,
  UtxoFeeOverride,
  UtxoOutputType,
  UtxoSelectionPreview,
  UtxoSelectionRequest,
  UtxoUnspent,
  UtxoWalletOptions,
} from './adapters/utxo/types';
export type {
  SolanaExpiryOrdering,
  SolanaExt,
  SolanaFeeDetails,
  SolanaFeeOverride,
  SolanaTokenAccount,
} from './adapters/solana/types';
export type {
  TonExt,
  TonFeeDetails,
  TonFeeOverride,
  TonSeqnoOrdering,
  TonWalletIdentity,
  TonWalletVersion,
} from './adapters/ton/types';
export type {
  AvalancheExt,
  AvalancheFeeDetails,
  AvalancheFeeOverride,
  AvalancheUnspent,
  AvalancheVm,
} from './adapters/avalanche/types';
