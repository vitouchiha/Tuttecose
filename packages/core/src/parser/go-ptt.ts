import { ParseResult, PTTServer } from 'go-ptt';
import os from 'os';
import {
  Cache,
  createLogger,
  Env,
  getTimeTakenSincePoint,
} from '../utils/index.js';
import { normaliseTitle } from './utils.js';

const logger = createLogger('parser');

const parseCache = Cache.getInstance<string, ParseResult | null>(
  'ptt',
  10000,
  'memory'
);

class PTT {
  private static _pttServer: PTTServer | null = null;
  private static _pttConfig: {
    network: 'tcp' | 'unix';
    address: string;
  } =
    os.platform() === 'win32'
      ? {
          network: 'tcp',
          address: `:${Env.PTT_PORT}`,
        }
      : {
          network: 'unix',
          address: Env.PTT_SOCKET,
        };

  private constructor() {}

  public static async initialise(): Promise<PTTServer> {
    if (PTT._pttServer) {
      return PTT._pttServer;
    }
    PTT._pttServer = new PTTServer(PTT._pttConfig);
    await PTT._pttServer.start();
    logger.debug('PTT server started');
    return PTT._pttServer;
  }

  public static async cleanup(): Promise<void> {
    await PTT._pttServer?.stop();
    PTT._pttServer = null;
  }

  public static async parse(titles: string[]): Promise<(ParseResult | null)[]> {
    if (!PTT._pttServer) {
      throw new Error('PTT server not running');
    }
    if (titles.length === 0) {
      return [];
    }

    const startTime = Date.now();

    // Check cache for each normalized title
    const titlesToProcess: { title: string; index: number }[] = [];
    const results: (ParseResult | null)[] = new Array(titles.length);

    // First pass - check cache and collect titles that need processing
    await Promise.all(
      titles.map(async (title, index) => {
        const normalizedTitle = normaliseTitle(title);
        const cached = await parseCache.get(normalizedTitle);
        if (cached !== undefined) {
          results[index] = cached;
        } else {
          titlesToProcess.push({ title, index });
        }
      })
    );

    // If all titles were cached, return early
    if (titlesToProcess.length === 0) {
      return results;
    }

    // Process uncached titles
    try {
      const parseResults = await PTT._pttServer.parse({
        torrent_titles: titlesToProcess.map((t) => t.title),
        normalize: true,
      });

      // Store results and cache them
      parseResults.forEach((result, idx) => {
        const { title, index } = titlesToProcess[idx];
        const finalResult = result.err ? null : result;
        results[index] = finalResult;

        if (result.err) {
          logger.error(`Error parsing title ${title}: ${result.err}`);
        }

        // Cache the result
        parseCache.set(
          normaliseTitle(title),
          finalResult,
          60 * 60 * 24 // 24 hours
        );
      });
    } catch (error) {
      logger.error(
        `Error calling PTT server: ${error}, ${JSON.stringify((error as any).metadata)}`,
        error
      );
      // Fill remaining results with null on error
      titlesToProcess.forEach(({ index }) => {
        results[index] = null;
      });
    }

    logger.debug(
      `PTT server parsed ${titlesToProcess.length} titles in ${getTimeTakenSincePoint(startTime)}`
    );

    return results;
  }
}

export default PTT;
