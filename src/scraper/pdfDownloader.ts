import fs from 'fs';
import path from 'path';
import { pipeline } from 'stream/promises';
import { HttpClient } from '../client/httpClient';
import { DeadLetterQueue } from '../storage/deadLetterQueue';
import { DocumentoItem } from '../types';

/**
 * Gestor de descarga de PDFs mediante Streams directos a disco.
 * Evita el consumo excesivo de memoria RAM (OOM) y maneja sanitización de nombres.
 */
export class PdfDownloader {
  private httpClient: HttpClient;
  private downloadDir: string;
  private dlq: DeadLetterQueue;

  constructor(httpClient: HttpClient, downloadDir: string, dlq: DeadLetterQueue) {
    this.httpClient = httpClient;
    this.downloadDir = downloadDir;
    this.dlq = dlq;

    if (!fs.existsSync(this.downloadDir)) {
      fs.mkdirSync(this.downloadDir, { recursive: true });
    }
  }

  /**
   * Sanitiza y genera un nombre de archivo descriptivo y válido según el estándar judicial.
   * Formato: {NUMERO_PROCESSO}_{ID_DOCUMENTO}_{TITULO_SANITIZADO}.pdf
   */
  public generateFileName(numeroProcesso: string, documento: DocumentoItem, ext = '.pdf'): string {
    const cleanProcesso = numeroProcesso.replace(/[^a-zA-Z0-9.-]/g, '_');
    const cleanId = documento.idDocumento.replace(/[^a-zA-Z0-9_-]/g, '');

    // Sanitizar título eliminando acentos, caracteres especiales y espacios múltiples
    const cleanTitle = (documento.titulo || 'Documento')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-zA-Z0-9_-]/g, '_')
      .replace(/_+/g, '_')
      .slice(0, 40);

    return `${cleanProcesso}_doc_${cleanId}_${cleanTitle}${ext}`;
  }

  /**
   * Descarga un PDF o documento por streaming a disco.
   */
  public async downloadDocument(
    numeroProcesso: string,
    documento: DocumentoItem
  ): Promise<{ success: boolean; filePath?: string; error?: string }> {
    const isExplicitHtml = documento.url.includes('HTML') || documento.url.includes('documentoSemLogin');
    const defaultExt = isExplicitHtml ? '.html' : '.pdf';
    const initialFileName = this.generateFileName(numeroProcesso, documento, defaultExt);
    const destinationPath = path.join(this.downloadDir, initialFileName);

    // Idempotencia: si ya fue descargado previamente y tiene tamaño > 0
    if (fs.existsSync(destinationPath) && fs.statSync(destinationPath).size > 0) {
      documento.status = 'downloaded';
      documento.localFilePath = destinationPath;
      this.dlq.remove(numeroProcesso, documento.idDocumento);
      return { success: true, filePath: destinationPath };
    }

    const tempPath = `${destinationPath}.tmp`;

    try {
      console.log(`📥 [Descarga] Obteniendo: ${initialFileName} desde ${documento.url}`);

      const response = await this.httpClient.getStream(documento.url, {
        headers: {
          'Accept': 'application/pdf,application/octet-stream,*/*'
        }
      });

      const writeStream = fs.createWriteStream(tempPath);

      // Usamos pipeline de stream/promises para garantizar cierre adecuado ante errores
      await pipeline(response.data, writeStream);

      // Detectar si el servidor realmente devolvió HTML o PDF
      const contentType = String(response.headers['content-type'] || '').toLowerCase();
      const isActualHtml = contentType.includes('text/html');
      const finalExt = isActualHtml ? '.html' : '.pdf';
      const finalFileName = this.generateFileName(numeroProcesso, documento, finalExt);
      const finalDestinationPath = path.join(this.downloadDir, finalFileName);

      // Renombrar el archivo temporal al destino final
      fs.renameSync(tempPath, finalDestinationPath);

      documento.status = 'downloaded';
      documento.localFilePath = finalDestinationPath;

      // Si estaba en la Dead Letter Queue, lo removemos
      this.dlq.remove(numeroProcesso, documento.idDocumento);

      console.log(`✅ [Archivo] Guardado exitosamente: ${finalFileName}`);
      return { success: true, filePath: finalDestinationPath };
    } catch (error: any) {
      // Limpiar archivo temporal si quedó huérfano
      if (fs.existsSync(tempPath)) {
        try {
          fs.unlinkSync(tempPath);
        } catch {}
      }

      const statusCode = error?.response?.status;
      const errorMessage = error?.message || 'Error desconocido';

      console.error(
        `❌ [Descarga] Falló descarga de ${initialFileName} (${statusCode ? `HTTP ${statusCode}` : errorMessage}). Registrando en DLQ.`
      );

      documento.status = 'failed';
      documento.downloadError = errorMessage;

      // Registrar en la Dead Letter Queue para reintento posterior
      this.dlq.recordFailure({
        numeroProcesso,
        idDocumento: documento.idDocumento,
        titulo: documento.titulo,
        url: documento.url,
        error: errorMessage,
        httpStatus: statusCode,
        attemptCount: 1
      });

      return { success: false, error: errorMessage };
    }
  }
}
