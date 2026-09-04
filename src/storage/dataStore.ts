import fs from 'fs';
import path from 'path';
import { ProcessoItem } from '../types';

/**
 * Almacenamiento estructurado de procesos y metadatos extraídos.
 */
export class DataStore {
  private filePath: string;
  private processosMap: Map<string, ProcessoItem> = new Map();

  constructor(filePath: string) {
    this.filePath = filePath;
    this.load();
  }

  private load(): void {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf-8');
        const list: ProcessoItem[] = JSON.parse(raw);
        for (const p of list) {
          this.processosMap.set(p.numeroProcesso, p);
        }
      }
    } catch {
      // Archivo nuevo
    }
  }

  /**
   * Agrega o actualiza procesos en el almacén.
   */
  public addOrUpdateMany(items: ProcessoItem[]): void {
    for (const item of items) {
      const existing = this.processosMap.get(item.numeroProcesso);
      if (existing) {
        // Unir documentos sin duplicar
        const docMap = new Map<string, any>();
        existing.documentos.forEach((d) => docMap.set(d.idDocumento, d));
        item.documentos.forEach((d) => docMap.set(d.idDocumento, d));

        this.processosMap.set(item.numeroProcesso, {
          ...existing,
          ...item,
          documentos: Array.from(docMap.values())
        });
      } else {
        this.processosMap.set(item.numeroProcesso, item);
      }
    }
    this.save();
  }

  public getAll(): ProcessoItem[] {
    return Array.from(this.processosMap.values());
  }

  public save(): void {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const items = Array.from(this.processosMap.values());
    fs.writeFileSync(this.filePath, JSON.stringify(items, null, 2), 'utf-8');
  }
}
