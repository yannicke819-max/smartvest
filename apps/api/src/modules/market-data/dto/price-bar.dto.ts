export interface PriceBar {
  assetId: string;
  provider: string;
  date: string; // YYYY-MM-DD
  open: string | undefined;
  high: string | undefined;
  low: string | undefined;
  close: string;
  adjustedClose: string | undefined;
  volume: number | undefined;
  currency: string;
}
