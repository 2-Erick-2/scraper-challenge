# PJe TypeScript Scraper (Senior-Grade)

Scraper de alto rendimiento y resiliencia desarrollado en **TypeScript** para la extracción de procesos judiciales y descarga automatizada de documentos en plataformas **PJe (Processo Judicial Eletrônico)** basadas en **JBoss Seam / JavaServer Faces (JSF)**, como el portal del **TRF5** (`pjett.trf5.jus.br`).

Este proyecto fue diseñado cumpliendo estrictamente con la restricción de **no utilizar automatización de navegadores** (sin Puppeteer, Playwright ni Selenium), resolviendo la navegación mediante ingeniería inversa del protocolo HTTP, gestión de estado de sesión (`JSESSIONID`) y tokens de ciclo de vida JSF (`javax.faces.ViewState`).

---

## 🏗️ Decisiones de Arquitectura y Diseño Senior

### 1. Gestión de Estado en Servidor (JSF / JBoss Seam)
Las aplicaciones basadas en `.seam` no son APIs REST sin estado; mantienen un árbol de componentes en la memoria del servidor (*server-side stateful component tree*).
* **`JSESSIONID`**: Se mantiene una sesión HTTP persistente a lo largo de todas las peticiones mediante un `CookieJar` (`tough-cookie` + `axios-cookiejar-support`).
* **`javax.faces.ViewState`**: Cada acción (búsqueda inicial, navegación, cambio de página mediante el componente `rich:datascroller`) extrae dinámicamente el token `ViewState` de la respuesta previa (sea HTML completo o respuesta parcial AJAX) y lo inyecta en el payload POST.

### 2. Manejo de Errores 429 (Too Many Requests) & Resiliencia
Para mitigar bloqueos por WAF o limitadores de tasa sin saturar el servidor:
* **Exponential Backoff con Full Jitter**:
  $$\text{Delay} = \min(\text{maxDelay}, \text{baseDelay} \times 2^{\text{attempt}}) \times \text{random}(0.5, 1.0)$$
  La aleatoriedad previene la sincronización simultánea de reintentos (*Thundering Herd problem*).
* **Respeto a `Retry-After`**: Si el servidor expone este encabezado (sea en segundos o fecha estándar RFC 1123), el scraper lo prioriza antes del cálculo heurístico.
* **Dead Letter Queue (DLQ)**: Si un documento o PDF agota los reintentos permitidos, el proceso **no se interrumpe**. El documento fallido se persiste en `output/failed_downloads.json` con metadatos completos para auditoría y reintento posterior.

### 3. Descarga Eficiente de PDFs (Streaming Directo a Disco)
* Se evita almacenar buffers en memoria RAM (`response.data`), lo que causaría caídas por *Out-Of-Memory* (OOM) en extracciones masivas.
* Se utiliza **Node.js Streams** (`responseType: 'stream'` junto a `stream/promises.pipeline`) canalizando los bytes directamente al sistema de archivos.
* **Nombres descriptivos y sanitizados**:
  Formato: `{NUMERO_PROCESSO}_doc_{ID_DOCUMENTO}_{TITULO_SANITIZADO}.pdf`.

### 4. Conectividad y Evasión de WAF (Recomendación de VPN)
Los servidores del Poder Judicial Brasileño (`*.jus.br`) cuentan con filtros perimetrales y WAF que rechazan o aplican *rate limiting* severo a direcciones IP fuera de Brasil.
* **Uso de VPN (Recomendado para entorno real):** Se recomienda utilizar **Urban VPN** o **Proton VPN** con servidor ubicado en **Brasil**. Esto permite que las peticiones alcancen el portal judicial sin que el firewall descarte los paquetes TCP antes del handshake TLS.
* **Modo Simulación (Mock Server):** Para pruebas y demostración de código sin depender de una conexión VPN activa o cuando el portal oficial experimenta mantenimiento, se incluye un servidor mock local nativo.

### 5. Pruebas Unitarias Automatizadas
Se implementaron pruebas con **Jest** y **ts-jest** para garantizar la robustez de los parsers y algoritmos clave:
* Extracción precisa de `javax.faces.ViewState` en HTML y XML parcial.
* Parseo de expedientes con formato CNJ.
* Cálculo de Exponential Backoff con Jitter y parsing de encabezados `Retry-After`.

---

## 📂 Estructura del Repositorio

```text
scraper-challenge/
├── src/
│   ├── client/
│   │   ├── httpClient.ts       # Axios + CookieJar persistente y headers de navegador
│   │   └── rateLimiter.ts      # Backoff exponencial, jitter y parsing de Retry-After
│   ├── scraper/
│   │   ├── pageParser.ts       # Extracción con Cheerio (ViewState, tablas CNJ, enlaces)
│   │   ├── pdfDownloader.ts    # Streaming de PDFs a disco y sanitización
│   │   └── pjeScraper.ts       # Orquestador del flujo de navegación y paginado
│   ├── storage/
│   │   ├── dataStore.ts        # Almacenamiento persistente en JSON
│   │   └── deadLetterQueue.ts  # Registro y control de reintentos fallidos (DLQ)
│   ├── mock/
│   │   └── server.ts           # Servidor local JSF/PJe con inyección de 429
│   ├── types/
│   │   └── index.ts            # Interfaces y modelos TypeScript estrictos
│   ├── config.ts               # Parámetros configurables y variables de entorno
│   └── index.ts                # Punto de entrada CLI con soporte de flags
├── output/
│   ├── downloads/              # PDFs descargados
│   ├── data.json               # Metadatos extraídos de los procesos
│   └── failed_downloads.json   # Cola de documentos fallidos (DLQ)
├── package.json
├── tsconfig.json
├── .env.example
└── .gitignore
```

---

## 🚀 Requisitos Previos

* **Node.js**: v18+ o v20+ recomendado.
* **npm**: v9+.

---

## ⚙️ Instalación

1. Clonar el repositorio y acceder a la carpeta:
   ```bash
   cd scraper-challenge
   ```

2. Instalar dependencias:
   ```bash
   npm install
   ```

---

## 🧪 Modos de Ejecución

### Opción A: Prueba Completa con Servidor Mock (Recomendado para validación inmediata)
Levanta un servidor local en el puerto 3000 que simula el entorno PJe del TRF5, realiza paginación POST con ViewState, simula errores 429 transitorios (con recuperación exitosa) y errores permanentes (registrados en DLQ):
```bash
npm run start:mock
```

### Opción B: Ejecución contra el Sitio Oficial (TRF5)
Ejecuta el scraper contra la URL configurada por defecto (`https://pjett.trf5.jus.br/pjeconsulta/ConsultaPublica/listView.seam`):
```bash
npm run start
```

### Opción C: Ejecución contra una URL personalizada (Cualquier tribunal PJe)
Puedes apuntar a cualquier instancia activa de PJe pasando el argumento `--url`:
```bash
npm run start -- --url "https://pje.tse.jus.br/pje/ConsultaPublica/listView.seam"
```

O limitando el número máximo de páginas a consultar:
```bash
npm run start -- --max-pages 5
```

### Opción D: Reintentar únicamente descargas fallidas (Dead Letter Queue)
Si la ejecución previa registró documentos con error 429 o de red en `output/failed_downloads.json`, puedes procesar únicamente los pendientes sin volver a scrapear todo el portal:
```bash
npm run retry-failed
```

### Opción E: Ejecutar Pruebas Unitarias Automatizadas
Ejecuta la suite de pruebas con Jest para verificar parsers, ViewState y RateLimiter:
```bash
npm test
```

---

## 🔧 Configuración por Variables de Entorno (`.env`)

Copia `.env.example` a `.env` si deseas personalizar la configuración por defecto:
```bash
cp .env.example .env
```

Parámetros disponibles:
| Variable | Descripción | Valor por defecto |
| :--- | :--- | :--- |
| `TARGET_URL` | URL del endpoint `listView.seam` | `https://pjett.trf5.jus.br/pjeconsulta/ConsultaPublica/listView.seam` |
| `MAX_RETRIES` | Número máximo de reintentos ante error 429 | `4` |
| `BASE_DELAY_MS` | Tiempo base para el cálculo de backoff | `1000` |
| `MAX_DELAY_MS` | Techo máximo de espera en backoff | `15000` |
| `REQUEST_DELAY_MS`| Pausa de cortesía entre peticiones para evitar sobrecarga | `800` |
| `OUTPUT_DIR` | Directorio de salida de datos | `./output` |
| `DOWNLOAD_DIR` | Directorio de descarga de PDFs | `./output/downloads` |

---

## 📊 Formato de Datos Extraídos (`output/data.json`)

Los datos extraídos se guardan con el siguiente esquema estructurado:

```json
[
  {
    "numeroProcesso": "0801234-56.2023.4.05.8000",
    "classeJudicial": "Procedimento Comum Cível",
    "orgaoJulgador": "1ª Vara Federal de Pernambuco",
    "dataDistribuicao": "12/01/2023",
    "documentos": [
      {
        "idDocumento": "101",
        "titulo": "Petição Inicial (PDF)",
        "tipo": "PDF/Documento",
        "url": "http://localhost:3000/pjeconsulta/download/documento.seam?idProcessoDoc=101",
        "status": "downloaded",
        "localFilePath": "/.../output/downloads/0801234-56.2023.4.05.8000_doc_101_Peticao_Inicial_PDF_.pdf"
      }
    ]
  }
]
```

---

## 🛡️ Dead Letter Queue (`output/failed_downloads.json`)

Si un archivo no pudo ser recuperado tras agotar la cuota de reintentos, se almacena con el detalle del incidente:

```json
[
  {
    "numeroProcesso": "0809876-12.2023.4.05.8000",
    "idDocumento": "999",
    "titulo": "Documento Bloqueado 429 (PDF)",
    "url": "http://localhost:3000/pjeconsulta/download/documento.seam?idProcessoDoc=999",
    "error": "Request failed with status code 429",
    "httpStatus": 429,
    "attemptCount": 1,
    "lastAttemptAt": "2026-09-04T07:41:53.054Z"
  }
]
```
