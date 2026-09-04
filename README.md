# PJe Scraper (TypeScript)

Scraper desarrollado en TypeScript para consultar procesos judiciales y descargar documentos desde portales **PJe (Processo Judicial Eletrônico)** basados en **JBoss Seam / JSF**, como el del tribunal **TRF5** (`pjett.trf5.jus.br`).

El proyecto se hizo sin herramientas de automatización de navegador (sin Puppeteer, Playwright ni Selenium). Todo el flujo se resuelve mediante peticiones HTTP directas con Axios, persistencia de cookies de sesión (`JSESSIONID`) y manejo del ciclo de vida de JSF (`javax.faces.ViewState`).

---

## Arquitectura y Decisiones Técnicas

### 1. Estado de Sesión en el Servidor (JSF / Seam)
Las aplicaciones que usan `.seam` no son APIs REST sin estado; el servidor guarda el estado de los componentes en memoria:
* **Cookies de sesión**: Usamos `tough-cookie` con `axios-cookiejar-support` para que Axios retenga `JSESSIONID` y `ROUTER_ID` en todas las peticiones sucesivas. Sin esto, el servidor devuelve `ViewExpiredException` y redirige a la página principal.
* **`javax.faces.ViewState`**: Para la búsqueda inicial y para pasar de página por POST, extraemos el token `ViewState` de la respuesta previa (sea desde el HTML del formulario o desde las respuestas parciales XML de RichFaces).

### 2. Manejo de Errores 429 (Too Many Requests)
Para no saturar el servidor y tolerar bloqueos temporales:
* **Backoff Exponencial con Jitter**: El tiempo de espera crece exponencialmente (`baseDelay * 2^attempt`) acotado por un máximo, y se le aplica un factor aleatorio (jitter) para evitar que múltiples reintentos se sincronicen y saturen el servidor al mismo tiempo.
* **Soporte para `Retry-After`**: Si el servidor responde con el header `Retry-After` (en segundos o fecha RFC 1123), se respeta ese tiempo antes del cálculo por defecto.
* **Dead Letter Queue (DLQ)**: Si una descarga falla tras agotar los reintentos, el script no se detiene. El fallo se guarda en `output/failed_downloads.json` y el scraper sigue con el siguiente proceso.

### 3. Descarga de PDFs con Streaming
* Los PDFs se descargan usando streams directos a disco (`pipeline` de Node.js con `fs.createWriteStream`). Esto evita cargar los archivos en la memoria RAM y mantiene el consumo por debajo de 35 MB.
* **Sanitización de nombres**: Se guardan como `{NUMERO_PROCESSO}_doc_{ID_DOCUMENTO}_{TITULO}.pdf`.
* Si un endpoint devuelve `Content-Type: text/html` (como pasa con vistas previas de autos o documentos HTML de PJe), se guarda con extensión `.html` para que el archivo no quede corrupto.

### 4. Conectividad y VPN (Entorno Real)
Los servidores del poder judicial de Brasil (`*.jus.br`) tienen un firewall perimetral que descarta paquetes TCP que provengan de IPs fuera de Brasil.
* **En entorno real:** Es necesario tener activa una VPN conectada a Brasil (ej. Proton VPN o Urban VPN) a nivel de sistema operativo para que el tráfico de Node.js pueda comunicarse con el portal.
* **En entorno de prueba:** Se incluye un servidor mock local (`npm run start:mock`) que replica las vistas JSF, la paginación y la inyección de errores 429 para probar todo sin depender de la conexión externa.

### 5. Pruebas Unitarias
Se agregaron pruebas unitarias con Jest (`npm test`) para verificar:
* Extracción de `ViewState` en HTML regular y respuestas parciales XML.
* Parseo de números de proceso con formato CNJ.
* Cálculo del backoff con jitter y parsing de cabeceras `Retry-After`.
* Detección de paginación y conteo total de registros.

---

## Estructura del Proyecto

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

## Requisitos Previos

* **Node.js**: v18+ o v20+
* **npm**: v9+

---

## Instalacion

1. Clonar el repositorio y acceder a la carpeta:
   ```bash
   cd scraper-challenge
   ```

2. Instalar dependencias:
   ```bash
   npm install
   ```

---

## Modos de Ejecucion

### Opcion A: Prueba con Servidor Mock (Recomendado para probar sin VPN)
Levanta un servidor local en el puerto 3000 que simula el entorno PJe del TRF5, realiza paginacion POST con ViewState, simula errores 429 transitorios (con recuperacion) y permanentes (enviados a DLQ):
```bash
npm run start:mock
```

### Opcion B: Ejecucion contra el Sitio Oficial (TRF5)
Ejecuta el scraper contra la URL real configurada (`https://pjett.trf5.jus.br/pjeconsulta/ConsultaPublica/listView.seam`). Requiere VPN a Brasil:
```bash
npm run start
```

### Opcion C: Ejecucion con URL o paginas personalizadas
Puedes apuntar a cualquier instancia de PJe pasando `--url`:
```bash
npm run start -- --url "https://pje.tse.jus.br/pje/ConsultaPublica/listView.seam"
```

O limitando la cantidad de paginas:
```bash
npm run start -- --max-pages 5
```

### Opcion D: Reintentar descargas fallidas (Dead Letter Queue)
Procesa solo los documentos que quedaron pendientes en `output/failed_downloads.json`:
```bash
npm run retry-failed
```

### Opcion E: Pruebas unitarias
Ejecuta la suite de Jest:
```bash
npm test
```

---

## Variables de Entorno (`.env`)

Copia `.env.example` a `.env` para personalizar la configuracion si lo necesitas:
```bash
cp .env.example .env
```

| Variable | Descripcion | Default |
| :--- | :--- | :--- |
| `TARGET_URL` | URL del endpoint `listView.seam` | `https://pjett.trf5.jus.br/pjeconsulta/ConsultaPublica/listView.seam` |
| `MAX_RETRIES` | Numero maximo de reintentos para 429 | `4` |
| `BASE_DELAY_MS` | Delay base para el calculo de backoff | `1000` |
| `MAX_DELAY_MS` | Techo maximo de espera en backoff | `15000` |
| `REQUEST_DELAY_MS`| Pausa entre descargas | `800` |
| `OUTPUT_DIR` | Directorio de salida de datos | `./output` |
| `DOWNLOAD_DIR` | Directorio de descarga de PDFs | `./output/downloads` |

---

## Formato de Datos (`output/data.json`)

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

## Dead Letter Queue (`output/failed_downloads.json`)

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
