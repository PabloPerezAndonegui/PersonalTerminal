export { openDatabase, migrate, transaction, type OpenOptions } from './db.ts';
export { MIGRATIONS, type Migration } from './schema.ts';
export {
  insertFills, readFills, lastFillAt, pruneFills,
  type Fill, type ConsultaFills,
} from './fills.ts';
export {
  writeSnapshots, readSeries, readLatest, rollupHourly, purgeHourly,
  readVolumeAverages,
  type MarketPoint, type SeriesQuery, type VolumeAverage,
  readMidsAt, readVolumenDiario, type VolumenDiario,
} from './market.ts';
export {
  writePoolDaily, readPoolMeans, prunePoolDaily, diaUtc, MINIMO_DIAS, TVL_MINIMO_HISTORICO,
  type PoolParaHistorico, type MediaVentana, type MediasPools,
} from './pools.ts';
export {
  addWallet, getWallet, listWallets, removeWallet, validateAddress,
  type Wallet, type NewWallet,
} from './wallets.ts';

export {
  addTrader, listTraders, getTrader, updateTrader, removeTrader,
  type Trader, type NewTrader, type TraderPatch,
} from './traders.ts';

export {
  insertAlertEvents, markAlertsNotified, listAlertEvents, trimAlertEvents,
  MAX_ALERT_EVENTS, type AlertEvent, type NewAlertEvent,
} from './alerts.ts';

export {
  pairSustainability,
  type ParDeVenues, type SustainabilityRow, type SustainabilityWindow, type SustainabilityOptions,
} from './sustainability.ts';
export {
  SnapshotPersister, writeHealth, readUptime, runRetention, retentionPending, DEFAULT_RETENTION,
  type HealthRow, type Uptime, type RetentionPolicy, type RetentionResult,
} from './persistence.ts';
export {
  addFundingPosition, getFundingPosition, listFundingPositions,
  updateFundingPosition, removeFundingPosition,
  positionMetrics, positionMetricsFromDb,
  addSizeChange, listSizeChanges, removeSizeChange, estimateFundingFromHistory,
  type FundingPosition, type NewFundingPosition, type FundingPositionPatch,
  type PositionMetrics, type FundingEstimate,
} from './fundingPositions.ts';
export {
  addIncomeEntry, listIncomeEntries, removeIncomeEntry, incomeTotals,
  setReferralLink, listReferralLinks, removeReferralLink,
  type IncomeEntry, type NewIncomeEntry, type IncomeKind, type IncomeTotals, type ReferralLink,
} from './income.ts';
export {
  addPointsProgram, listPointsPrograms, removePointsProgram, reorderPointsPrograms,
  addFarmingAction, listFarmingActions, removeFarmingAction,
  actionMetrics, farmingPortfolio,
  type PointsProgram, type FarmingAction, type ActionMetrics, type FarmingPortfolio,
} from './farming.ts';
export {
  exportUserData, importUserData, countUserRows,
  type UserBackup, type RestoreResult,
} from './backup.ts';

export {
  insertOiSnapshots, insertOiIfAbsent, oiAt, borrarRellenoOi, oiSeries, oiCoverage, pruneOi, TOTAL as OI_TOTAL, OI_RETENTION,
  type OiPoint, type OiSeriesQuery, type OiRetention,
} from './openInterest.ts';
