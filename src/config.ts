import path from 'path';
import fs from 'fs';
import { ScraperConfig } from './types';

const defaultOutputDir = path.resolve(process.cwd(), process.env.OUTPUT_DIR || 'output');
const defaultDownloadDir = path.resolve(process.cwd(), process.env.DOWNLOAD_DIR || 'output/downloads');

export const DEFAULT_CONFIG: ScraperConfig = {
  // URL por defecto del portal TRF5
  targetUrl: process.env.TARGET_URL || 'https://pjett.trf5.jus.br/pjeconsulta/ConsultaPublica/listView.seam',
  outputDir: defaultOutputDir,
  downloadDir: defaultDownloadDir,
  dataFilePath: path.join(defaultOutputDir, 'data.json'),
  failedDownloadsPath: path.join(defaultOutputDir, 'failed_downloads.json'),
  maxRetries: Number(process.env.MAX_RETRIES) || 4,
  baseDelayMs: Number(process.env.BASE_DELAY_MS) || 1000,
  maxDelayMs: Number(process.env.MAX_DELAY_MS) || 15000,
  requestDelayMs: Number(process.env.REQUEST_DELAY_MS) || 800,
  maxPages: Number(process.env.MAX_PAGES) || 10,
  concurrency: Number(process.env.CONCURRENCY) || 1,
  searchQuery: process.env.SEARCH_QUERY || 'Jose Silva'
};

export function ensureDirectoriesExist(config: ScraperConfig): void {
  if (!fs.existsSync(config.outputDir)) {
    fs.mkdirSync(config.outputDir, { recursive: true });
  }
  if (!fs.existsSync(config.downloadDir)) {
    fs.mkdirSync(config.downloadDir, { recursive: true });
  }
}
