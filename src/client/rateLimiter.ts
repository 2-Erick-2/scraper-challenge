// Manejo de rate limiting (429) con backoff exponencial y jitter
export class RateLimiter {
  private baseDelayMs: number;
  private maxDelayMs: number;
  private maxRetries: number;

  constructor(baseDelayMs = 1000, maxDelayMs = 15000, maxRetries = 4) {
    this.baseDelayMs = baseDelayMs;
    this.maxDelayMs = maxDelayMs;
    this.maxRetries = maxRetries;
  }

  public async sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // Parsea el header Retry-After si viene en segundos o fecha RFC 1123
  public parseRetryAfterHeader(retryAfterHeader?: string): number | null {
    if (!retryAfterHeader) return null;

    // Caso 1: Segundos
    const seconds = parseInt(retryAfterHeader, 10);
    if (!isNaN(seconds) && seconds >= 0) {
      return seconds * 1000;
    }

    // Caso 2: Fecha HTTP standard
    const dateMs = Date.parse(retryAfterHeader);
    if (!isNaN(dateMs)) {
      const diffMs = dateMs - Date.now();
      return diffMs > 0 ? diffMs : 1000;
    }

    return null;
  }

  // Calcula tiempo de espera con backoff exponencial + full jitter
  public calculateBackoff(attempt: number, retryAfterHeader?: string): number {
    const explicitWait = this.parseRetryAfterHeader(retryAfterHeader);
    if (explicitWait !== null) {
      // Si el server mando Retry-After le damos prioridad mas un margen chico
      return explicitWait + Math.floor(Math.random() * 200) + 100;
    }

    const exponential = Math.min(
      this.maxDelayMs,
      this.baseDelayMs * Math.pow(2, attempt)
    );

    // Full jitter (50% a 100%) para no pegarle al server al mismo tiempo
    const jitterFactor = 0.5 + Math.random() * 0.5;
    return Math.floor(exponential * jitterFactor);
  }

  // Ejecuta una promesa con reintentos si da 429 o error transitorio de red
  public async executeWithRetry<T>(
    operationName: string,
    fn: () => Promise<T>,
    onRetry?: (attempt: number, delayMs: number, error: any) => void
  ): Promise<T> {
    let attempt = 0;

    while (true) {
      try {
        return await fn();
      } catch (error: any) {
        attempt++;
        const statusCode = error?.response?.status;
        const retryAfter = error?.response?.headers?.['retry-after'];

        const isRateLimited = statusCode === 429;
        const isTransientNetworkError =
          error.code === 'ECONNRESET' ||
          error.code === 'ETIMEDOUT' ||
          error.code === 'EAI_AGAIN' ||
          (statusCode && statusCode >= 502 && statusCode <= 504);

        const shouldRetry = (isRateLimited || isTransientNetworkError) && attempt <= this.maxRetries;

        if (!shouldRetry) {
          throw error;
        }

        const delayMs = this.calculateBackoff(attempt, retryAfter);

        if (onRetry) {
          onRetry(attempt, delayMs, error);
        } else {
          console.warn(
            `[rate-limit] ${operationName} dio HTTP ${statusCode || error.code}. Reintentando en ${delayMs}ms (intento ${attempt}/${this.maxRetries})...`
          );
        }

        await this.sleep(delayMs);
      }
    }
  }
}
