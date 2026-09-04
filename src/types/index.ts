/**
 * Definiciones de tipos para el scraper de PJe
 */

export interface DocumentoItem {
  idDocumento: string;
  titulo: string;
  tipo?: string;
  dataJuntada?: string;
  url: string;
  localFilePath?: string;
  status: 'pending' | 'downloaded' | 'failed';
  downloadError?: string;
}

export interface ProcessoItem {
  idProcesso?: string;
  numeroProcesso: string;
  classeJudicial?: string;
  orgaoJulgador?: string;
  dataDistribuicao?: string;
  poloAtivo?: string;
  poloPassivo?: string;
  assunto?: string;
  detalheUrl?: string;
  documentos: DocumentoItem[];
}

export interface FailedDownloadItem {
  numeroProcesso: string;
  idDocumento: string;
  titulo: string;
  url: string;
  error: string;
  httpStatus?: number;
  attemptCount: number;
  lastAttemptAt: string;
}

export interface PageScrapeResult {
  viewState: string;
  processos: ProcessoItem[];
  currentPage: number;
  totalPages?: number;
  hasNextPage: boolean;
}

export interface ScraperConfig {
  targetUrl: string;
  outputDir: string;
  downloadDir: string;
  dataFilePath: string;
  failedDownloadsPath: string;
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  requestDelayMs: number;
  maxPages: number;
  concurrency: number;
  searchQuery?: string;
}
