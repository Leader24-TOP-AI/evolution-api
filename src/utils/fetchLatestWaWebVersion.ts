import axios, { AxiosRequestConfig } from 'axios';
import { fetchLatestBaileysVersion, WAVersion } from 'baileys';

// ✅ FIX: Timeout per evitare blocco indefinito se whatsapp.com non risponde
const HTTP_TIMEOUT_MS = 10000; // 10 secondi
const BAILEYS_FALLBACK_TIMEOUT_MS = 5000; // 5 secondi per fallback

/**
 * Helper per aggiungere timeout a qualsiasi Promise
 */
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, operationName: string): Promise<T> {
  let timeoutId: NodeJS.Timeout;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`Timeout after ${timeoutMs}ms: ${operationName}`));
    }, timeoutMs);
  });

  try {
    const result = await Promise.race([promise, timeoutPromise]);
    clearTimeout(timeoutId!);
    return result;
  } catch (error) {
    clearTimeout(timeoutId!);
    throw error;
  }
}

export const fetchLatestWaWebVersion = async (options: AxiosRequestConfig<{}>) => {
  try {
    // ✅ FIX: Aggiunto timeout esplicito alla chiamata HTTP
    const { data } = await axios.get('https://web.whatsapp.com/sw.js', {
      ...options,
      responseType: 'json',
      timeout: HTTP_TIMEOUT_MS, // ✅ Timeout axios
    });

    const regex = /\\?"client_revision\\?":\s*(\d+)/;
    const match = data.match(regex);

    if (!match?.[1]) {
      // ✅ FIX: Timeout anche sul fallback Baileys
      const baileysVersion = await withTimeout(
        fetchLatestBaileysVersion(),
        BAILEYS_FALLBACK_TIMEOUT_MS,
        'fetchLatestBaileysVersion:noMatch',
      );
      return {
        version: baileysVersion.version as WAVersion,
        isLatest: false,
        error: {
          message: 'Could not find client revision in the fetched content',
        },
      };
    }

    const clientRevision = match[1];

    return {
      version: [2, 3000, +clientRevision] as WAVersion,
      isLatest: true,
    };
  } catch (error) {
    // ✅ FIX: Timeout anche sul fallback Baileys in caso di errore
    try {
      const baileysVersion = await withTimeout(
        fetchLatestBaileysVersion(),
        BAILEYS_FALLBACK_TIMEOUT_MS,
        'fetchLatestBaileysVersion:catch',
      );
      return {
        version: baileysVersion.version as WAVersion,
        isLatest: false,
        error,
      };
    } catch (fallbackError) {
      // Se anche il fallback fallisce, usa versione hardcoded di sicurezza
      return {
        version: [2, 3000, 1] as WAVersion, // Versione minima di fallback
        isLatest: false,
        error: fallbackError,
      };
    }
  }
};
