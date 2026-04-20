export interface PriceBar {
  assetId: string;
  provider: string;
  date: string; // YYYY-MM-DD
  open?: string;
  high?: string;
  low?: string;
  close: string;
  adjustedClose?: string;
  volume?: number;
  currency: string;
}
